const { accounts, isActive, searchAdGet, readCache: readProductCache } = require("./search-ad-cache");
const { connect, store, readCandidateCache, readCandidateStatus, writeCandidateStatus, CACHE_KEY } = require("./keyword-candidate-cache");

// Keep Search Ad calls bounded, but finish comfortably inside Netlify's
// background-function execution window. Product synchronization remains
// unchanged and uses its own concurrency setting.
const CONCURRENCY = 8;
const MAX_SEEDS = 500;
const MAX_CACHED_CANDIDATES = 20000;
// Leave enough time for the final 20k-candidate Blob write inside the
// background-function execution window. Remaining missing values keep the
// explicit `not-requested` status and can be covered by the next manual run.
const MAX_VOLUME_BACKFILL = 1000;
const MIN_MONTHLY_SEARCH = 100;
const STOP_WORDS = new Set(["기획", "증정", "단독", "세트", "리필", "본품", "무료", "배송", "정품", "올리브영", "공식", "NEW"]);
const HEALTH_WORDS = ["유산균", "프로바이오틱스", "프리바이오틱스", "콜라겐", "비타민", "영양제", "건강식품", "오메가", "프로틴", "단백질", "단백바", "쉐이크", "홍삼", "건강", "효소", "루테인", "마그네슘", "아연", "철분", "밀크씨슬", "글루타치온", "비오틴", "베르베린"];
const BEAUTY_WORDS = ["세럼", "크림", "쿠션", "선크림", "마스크", "앰플", "토너", "로션", "클렌징", "샴푸", "트리트먼트", "립", "향수", "메이크업", "파운데이션", "네일", "헤어", "바디", "레티놀", "나이아신아마이드", "히알루론산", "세라마이드", "판테놀", "병풀", "시카", "브라이트닝", "미백", "보습", "화장품", "에센스"];

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function normalize(value) {
  const cleaned = String(value || "").replace(/\d+(?:\.\d+)?\s*(?:ml|g|mg|정|포|매|개|입)/gi, " ")
    .replace(/\d+\s*\+\s*\d+/g, " ").replace(/[()[\]{}]/g, " ").replace(/[^0-9A-Za-z가-힣\s]/g, " ")
    .replace(/\s+/g, " ").trim();
  return cleaned.split(" ").filter((word) => !STOP_WORDS.has(word.toUpperCase())).join(" ");
}

function categoryCounts(value) {
  const text = String(value || "").toLowerCase();
  return { health: HEALTH_WORDS.filter((word) => text.includes(word)).length, beauty: BEAUTY_WORDS.filter((word) => text.includes(word)).length };
}
function words(value) { return normalize(value).toLocaleLowerCase("ko-KR").split(/\s+/).filter((word) => word.length >= 2); }
function classify(keyword, context = "") {
  const direct = categoryCounts(keyword);
  if (direct.health || direct.beauty) return direct.health > direct.beauty ? "health" : "beauty";
  const contextCategory = categoryCounts(context);
  const queryWords = new Set(words(keyword)); const contextWords = new Set(words(context));
  const contextOverlap = [...queryWords].some((word) => contextWords.has(word) || [...contextWords].some((item) => item.includes(word) || word.includes(item)));
  if (contextOverlap && (contextCategory.health || contextCategory.beauty)) return contextCategory.health > contextCategory.beauty ? "health" : "beauty";
  return "unknown";
}

function buildGroupContexts(items) {
  const contexts = new Map();
  for (const item of items || []) {
    const key = `${item.accountNumber}:${item.adGroupId}`;
    const current = contexts.get(key) || { products: [], brands: [], text: "" };
    if (item.product && current.products.length < 8 && !current.products.includes(item.product)) current.products.push(item.product);
    if (item.brand && current.brands.length < 8 && !current.brands.includes(item.brand)) current.brands.push(item.brand);
    current.text = `${current.brands.join(" ")} ${current.products.join(" ")}`.trim();
    contexts.set(key, current);
  }
  return contexts;
}
function candidatePriority(item, now = Date.now()) {
  const monthly = Number(item.monthlyTotalSearches || 0), impressions = Number(item.impressions30d || 0), delta = Number(item.impressionDelta || 0);
  const ageDays = Math.max(0, (now - Date.parse(item.firstSeenAt || new Date(now).toISOString())) / 86400000);
  return (item.category === "unknown" ? 0 : 100) + Math.log10(monthly + 1) * 12 + (ageDays <= 14 ? 14 : 0)
    + Math.max(-8, Math.min(18, Math.sign(delta) * Math.log10(Math.abs(delta) + 1) * 5))
    + (item.sources.includes("keywordstool") ? 8 : 0) + Math.log10(impressions + 1) * 2;
}

function numericVolume(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value || "").replace(/,/g, "").trim();
  if (!text || text.includes("<")) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function productSeeds(items) {
  const frequency = new Map();
  for (const item of items || []) {
    const words = normalize(`${item.brand || ""} ${item.product || ""}`).split(" ").filter((word) =>
      word.length >= 2 && word.length <= 15 && !STOP_WORDS.has(word) && !/^\d+$/.test(word));
    for (const word of words) frequency.set(word, (frequency.get(word) || 0) + 1);
    const productType = words.find((word) => [...HEALTH_WORDS, ...BEAUTY_WORDS].some((type) => word.includes(type)));
    if (words[0] && productType && words[0] !== productType) {
      const pair = `${words[0]} ${productType}`;
      frequency.set(pair, (frequency.get(pair) || 0) + 2);
    }
  }
  return [...frequency.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SEEDS).map(([keyword]) => keyword);
}

async function loadActiveGroups(account, metrics) {
  const campaigns = await searchAdGet(account, "/ncc/campaigns", undefined, metrics);
  const shopping = (Array.isArray(campaigns) ? campaigns : []).filter((campaign) => {
    const type = String(campaign.campaignTp || campaign.type || "").toUpperCase();
    return ["SHOPPING", "CATALOG", "SHOPPING_BRAND"].some((value) => type.includes(value)) && isActive(campaign);
  });
  const groups = [];
  for (const campaign of shopping) {
    const result = await searchAdGet(account, "/ncc/adgroups", { nccCampaignId: campaign.nccCampaignId }, metrics);
    for (const group of Array.isArray(result) ? result : []) if (isActive(group)) groups.push(group);
  }
  return groups;
}

function statsRows(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["data", "stats", "items", "results"]) if (Array.isArray(payload?.[key])) return payload[key];
  return [];
}

function toolRows(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["keywordList", "relKwdStat", "items", "results"]) if (Array.isArray(payload?.[key])) return payload[key];
  return [];
}

exports.handler = async (event) => {
  connect(event);
  let input;
  try { input = JSON.parse(event.body || "{}"); } catch { return; }
  const storedStatus = await readCandidateStatus();
  // The singleton status Blob can briefly return the previous job immediately
  // after a manual refresh starts. Prefer the trigger payload for the new job;
  // later heartbeats still read and write the shared status normally.
  const initial = storedStatus?.jobId === input.jobId ? storedStatus : input.status;
  if (!input.jobId || initial?.jobId !== input.jobId || initial.state !== "running") return;
  let status = { ...initial };
  const persist = async (patch) => {
    status = { ...status, ...patch, updatedAt: new Date().toISOString() };
    await writeCandidateStatus(status);
  };
  const metrics = { apiCalls: 0, retries: 0 };
  const started = Date.now();
  const errors = [];
  try {
    const [productCache, previousCache] = await Promise.all([readProductCache(), readCandidateCache()]);
    if (!productCache?.items?.length) throw new Error("Search Ad 상품 캐시가 없습니다.");
    const previousCandidates = new Map((previousCache?.candidates || []).map((item) => [String(item.keyword || "").toLocaleLowerCase("ko-KR"), item]));
    const groupContexts = buildGroupContexts(productCache.items);
    const observedAt = new Date().toISOString();
    const configuredAccounts = accounts();
    const plans = [];
    for (const account of configuredAccounts) plans.push({ account, groups: await loadActiveGroups(account, metrics) });
    const totalAdgroups = plans.reduce((sum, plan) => sum + plan.groups.length, 0);
    await persist({ totalAdgroups, message: `실제 유입 검색어 수집 중 · 0 / ${totalAdgroups.toLocaleString("ko-KR")} 광고그룹` });

    const candidateMap = new Map();
    let processedAdgroups = 0;
    let statsSucceeded = 0;
    for (const { account, groups } of plans) {
      for (const batch of chunks(groups, CONCURRENCY)) {
        const results = await Promise.allSettled(batch.map((group) => searchAdGet(account, "/stats", {
          id: group.nccAdgroupId, statType: "NPLA_SCH_KEYWORD"
        }, metrics)));
        for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
          const result = results[resultIndex]; const group = batch[resultIndex];
          if (result.status === "rejected") { errors.push(result.reason?.message || "유입 검색어 조회 실패"); continue; }
          statsSucceeded += 1;
          for (const row of statsRows(result.value)) {
            const keyword = normalize(row.schKeyword || row.keyword);
            if (keyword.length < 2 || keyword.length > 40) continue;
            const key = keyword.toLocaleLowerCase("ko-KR");
            const context = groupContexts.get(`${account.number}:${group.nccAdgroupId}`) || { products: [], brands: [], text: "" };
            const previous = previousCandidates.get(key);
            const category = classify(keyword, context.text);
            const existing = candidateMap.get(key) || { keyword, category, categoryEvidence: category === "unknown" ? "unknown" : (categoryCounts(keyword)[category] ? "keyword" : "adgroup-product"),
              sources: [], impressions30d: 0, clicks30d: 0, accountNumbers: [], relatedAdgroupIds: [], relatedProducts: [], relatedBrands: [],
              firstSeenAt: previous?.firstSeenAt || observedAt, lastSeenAt: observedAt, previousImpressions30d: Number(previous?.impressions30d || 0),
              monthlyPcSearches: previous?.monthlyPcSearches ?? null, monthlyMobileSearches: previous?.monthlyMobileSearches ?? null,
              monthlyTotalSearches: previous?.monthlyTotalSearches ?? null, monthlyVolumeStatus: previous?.monthlyVolumeStatus || (previous?.monthlyTotalSearches != null ? "available" : null) };
            if (!existing.sources.includes("searchad-query")) existing.sources.push("searchad-query");
            if (!existing.accountNumbers.includes(account.number)) existing.accountNumbers.push(account.number);
            if (!existing.relatedAdgroupIds.includes(group.nccAdgroupId) && existing.relatedAdgroupIds.length < 3) existing.relatedAdgroupIds.push(group.nccAdgroupId);
            for (const product of context.products) if (!existing.relatedProducts.includes(product) && existing.relatedProducts.length < 3) existing.relatedProducts.push(product);
            for (const brand of context.brands) if (!existing.relatedBrands.includes(brand) && existing.relatedBrands.length < 3) existing.relatedBrands.push(brand);
            if (existing.category === "unknown" && category !== "unknown") { existing.category = category; existing.categoryEvidence = categoryCounts(keyword)[category] ? "keyword" : "adgroup-product"; }
            existing.impressions30d += Number(row.impCnt || 0);
            existing.clicks30d += Number(row.clkCnt || 0);
            candidateMap.set(key, existing);
          }
        }
        processedAdgroups += batch.length;
        if (processedAdgroups % 40 < batch.length || processedAdgroups === totalAdgroups) {
          await persist({ processedAdgroups, apiCalls: metrics.apiCalls, retries: metrics.retries,
            message: `실제 유입 검색어 수집 중 · ${processedAdgroups.toLocaleString("ko-KR")} / ${totalAdgroups.toLocaleString("ko-KR")} 광고그룹` });
        }
      }
    }

    if (totalAdgroups > 0 && statsSucceeded === 0) throw new Error(`Search Ad NPLA_SCH_KEYWORD 호출이 모든 광고그룹에서 실패했습니다. ${errors[0] || "응답을 확인해주세요."}`);

    const actualQueries = [...candidateMap.values()].sort((a, b) => b.impressions30d - a.impressions30d).slice(0, 500).map((item) => item.keyword);
    const seeds = [...new Set([...actualQueries, ...productSeeds(productCache.items)])].slice(0, 1000);
    await persist({ totalSeeds: seeds.length, processedSeeds: 0, message: `keywordstool 후보 확장 중 · 0 / ${seeds.length.toLocaleString("ko-KR")} seed` });
    const toolAccount = configuredAccounts[0];
    let processedSeeds = 0;
    let keywordToolCount = 0;
    const requestedSeeds = new Set(); const failedSeeds = new Set();
    const applyToolPayload = (payload, seedBatch) => {
      seedBatch.forEach((seed) => requestedSeeds.add(seed.toLocaleLowerCase("ko-KR")));
      for (const row of toolRows(payload)) {
        const keyword = normalize(row.relKeyword || row.keyword);
        if (keyword.length < 2 || keyword.length > 30) continue;
        const pc = numericVolume(row.monthlyPcQcCnt);
        const mobile = numericVolume(row.monthlyMobileQcCnt);
        const monthly = pc === null || mobile === null ? null : pc + mobile;
        const key = keyword.toLocaleLowerCase("ko-KR");
        const previous = previousCandidates.get(key);
        const category = classify(keyword, seedBatch.join(" "));
        const existing = candidateMap.get(key) || { keyword, category, categoryEvidence: category === "unknown" ? "unknown" : "keywordstool-seed",
          sources: [], impressions30d: 0, clicks30d: 0, accountNumbers: [], relatedAdgroupIds: [], relatedProducts: [], relatedBrands: [],
          firstSeenAt: previous?.firstSeenAt || observedAt, lastSeenAt: observedAt, previousImpressions30d: Number(previous?.impressions30d || 0),
          monthlyPcSearches: previous?.monthlyPcSearches ?? null, monthlyMobileSearches: previous?.monthlyMobileSearches ?? null,
          monthlyTotalSearches: previous?.monthlyTotalSearches ?? null, monthlyVolumeStatus: previous?.monthlyVolumeStatus || (previous?.monthlyTotalSearches != null ? "available" : null) };
        if (!existing.sources.includes("keywordstool")) existing.sources.push("keywordstool");
        existing.seedRelations = [...new Set([...(existing.seedRelations || []), ...seedBatch])].slice(0, 10);
        existing.monthlyPcSearches = pc;
        existing.monthlyMobileSearches = mobile;
        existing.monthlyTotalSearches = monthly;
        existing.monthlyVolumeStatus = monthly === null ? "keywordtool-unavailable" : "available";
        existing.monthlyVolumeUpdatedAt = observedAt;
        existing.competition = row.compIdx || null;
        if (monthly === null || monthly >= MIN_MONTHLY_SEARCH || existing.sources.includes("searchad-query")) {
          if (existing.category === "unknown" && category !== "unknown") { existing.category = category; existing.categoryEvidence = "keywordstool-seed"; }
          candidateMap.set(key, existing); keywordToolCount += 1;
        }
      }
    };
    for (const batch of chunks(seeds, 5)) {
      try {
        const payload = await searchAdGet(toolAccount, "/keywordstool", { hintKeywords: batch.join(","), showDetail: 1 }, metrics);
        applyToolPayload(payload, batch);
      } catch (batchError) {
        for (const seed of batch) {
          try { applyToolPayload(await searchAdGet(toolAccount, "/keywordstool", { hintKeywords: seed, showDetail: 1 }, metrics), [seed]); }
          catch (error) { failedSeeds.add(seed.toLocaleLowerCase("ko-KR")); errors.push(error.message || batchError.message); }
        }
      }
      processedSeeds += batch.length;
      if (processedSeeds % 25 < batch.length || processedSeeds === seeds.length) {
        await persist({ processedSeeds, apiCalls: metrics.apiCalls, retries: metrics.retries,
          message: `keywordstool 후보 확장 중 · ${processedSeeds.toLocaleString("ko-KR")} / ${seeds.length.toLocaleString("ko-KR")} seed` });
      }
    }

    const volumeBackfill = [...candidateMap.values()].filter((item) => item.sources.includes("searchad-query")
      && item.category !== "unknown" && item.monthlyTotalSearches == null && !requestedSeeds.has(item.keyword.toLocaleLowerCase("ko-KR")))
      .sort((a, b) => Number(b.impressions30d || 0) - Number(a.impressions30d || 0)).slice(0, MAX_VOLUME_BACKFILL).map((item) => item.keyword);
    let processedBackfill = 0;
    await persist({ totalVolumeBackfill: volumeBackfill.length, processedVolumeBackfill: 0,
      message: `월간검색량 누락 후보 보강 중 · 0 / ${volumeBackfill.length.toLocaleString("ko-KR")}` });
    for (const requestBatch of chunks(chunks(volumeBackfill, 5), 5)) {
      const results = await Promise.allSettled(requestBatch.map((batch) => searchAdGet(toolAccount, "/keywordstool", {
        hintKeywords: batch.join(","), showDetail: 1
      }, metrics)));
      results.forEach((result, index) => {
        const batch = requestBatch[index]; batch.forEach((seed) => requestedSeeds.add(seed.toLocaleLowerCase("ko-KR")));
        if (result.status === "fulfilled") applyToolPayload(result.value, batch);
        else { batch.forEach((seed) => failedSeeds.add(seed.toLocaleLowerCase("ko-KR"))); errors.push(result.reason?.message || "월간검색량 보강 실패"); }
      });
      processedBackfill += requestBatch.reduce((sum, batch) => sum + batch.length, 0);
      if (processedBackfill % 100 < 25 || processedBackfill === volumeBackfill.length) await persist({ processedVolumeBackfill: processedBackfill,
        apiCalls: metrics.apiCalls, retries: metrics.retries,
        message: `월간검색량 누락 후보 보강 중 · ${processedBackfill.toLocaleString("ko-KR")} / ${volumeBackfill.length.toLocaleString("ko-KR")}` });
    }

    for (const item of candidateMap.values()) {
      const key = item.keyword.toLocaleLowerCase("ko-KR");
      item.impressionDelta = Number(item.impressions30d || 0) - Number(item.previousImpressions30d || 0);
      item.isNewSearchQuery = !previousCandidates.has(key);
      if (!item.monthlyVolumeStatus) item.monthlyVolumeStatus = failedSeeds.has(key) ? "request-failed"
        : requestedSeeds.has(key) ? "keywordtool-unavailable" : "not-requested";
      item.priorityScore = candidatePriority(item);
      // Product/ad-group context has already been reduced to categoryEvidence.
      // Do not persist repeated product strings for 20k candidates: they are
      // not consumed by analysis and can push the final atomic Blob write past
      // the background-function execution window.
      delete item.relatedAdgroupIds;
      delete item.relatedProducts;
      delete item.relatedBrands;
      delete item.seedRelations;
    }
    const candidates = [...candidateMap.values()]
      .filter((item) => item.sources.includes("searchad-query") || Number(item.monthlyTotalSearches || 0) >= MIN_MONTHLY_SEARCH)
      .sort((a, b) => Number(b.priorityScore || 0) - Number(a.priorityScore || 0)
        || Number(b.monthlyTotalSearches || 0) - Number(a.monthlyTotalSearches || 0))
      .slice(0, MAX_CACHED_CANDIDATES);
    candidateMap.clear();
    if (!candidates.length) throw new Error("Search Ad 실제 유입 검색어와 keywordstool에서 유효한 후보를 생성하지 못했습니다.");
    const refreshedAt = new Date().toISOString();
    const cache = {
      version: 1, refreshedAt, candidates, candidateCount: candidates.length,
      actualQueryCount: candidates.filter((item) => item.sources.includes("searchad-query")).length,
      keywordToolCount: candidates.filter((item) => item.sources.includes("keywordstool")).length,
      categoryCounts: { beauty: candidates.filter((item) => item.category === "beauty").length,
        health: candidates.filter((item) => item.category === "health").length, unknown: candidates.filter((item) => item.category === "unknown").length },
      monthlyVolumeCounts: { available: candidates.filter((item) => item.monthlyVolumeStatus === "available").length,
        unavailable: candidates.filter((item) => item.monthlyVolumeStatus === "keywordtool-unavailable").length,
        notRequested: candidates.filter((item) => item.monthlyVolumeStatus === "not-requested").length,
        requestFailed: candidates.filter((item) => item.monthlyVolumeStatus === "request-failed").length },
      seedCount: seeds.length, apiCalls: metrics.apiCalls, retries: metrics.retries,
      durationMs: Date.now() - started, warnings: errors.slice(0, 50)
    };
    await store().setJSON(CACHE_KEY, cache);
    await persist({ state: "completed", message: "검색어 후보 새로고침 완료", completedAt: refreshedAt,
      candidateCount: cache.candidateCount, actualQueryCount: cache.actualQueryCount, keywordToolCount: cache.keywordToolCount,
      apiCalls: metrics.apiCalls, retries: metrics.retries, durationMs: cache.durationMs, errors: errors.slice(0, 50) });
  } catch (error) {
    await persist({ state: "failed", message: "검색어 후보 새로고침 실패", failedAt: new Date().toISOString(),
      apiCalls: metrics.apiCalls, retries: metrics.retries, durationMs: Date.now() - started, errors: [error.message, ...errors].slice(0, 50) });
  }
};

exports._test = { normalize, classify, numericVolume, productSeeds, statsRows, toolRows, buildGroupContexts, candidatePriority };
