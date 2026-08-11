const { accounts, isActive, searchAdGet, readCache: readProductCache } = require("./search-ad-cache");
const { connect, store, readCandidateStatus, writeCandidateStatus, CACHE_KEY } = require("./keyword-candidate-cache");

// Keep Search Ad calls bounded, but finish comfortably inside Netlify's
// background-function execution window. Product synchronization remains
// unchanged and uses its own concurrency setting.
const CONCURRENCY = 8;
const MAX_SEEDS = 500;
const MIN_MONTHLY_SEARCH = 100;
const STOP_WORDS = new Set(["기획", "증정", "단독", "세트", "리필", "본품", "무료", "배송", "정품", "올리브영", "공식", "NEW"]);
const HEALTH_WORDS = ["유산균", "콜라겐", "비타민", "영양제", "오메가", "프로틴", "단백질", "홍삼", "건강", "효소", "루테인", "마그네슘", "아연", "철분", "밀크씨슬"];
const BEAUTY_WORDS = ["세럼", "크림", "쿠션", "선크림", "마스크", "앰플", "토너", "로션", "클렌징", "샴푸", "트리트먼트", "립", "레티놀", "브라이트닝", "미백", "보습", "화장품", "에센스"];

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

function classify(keyword) {
  const value = String(keyword || "").toLowerCase();
  if (HEALTH_WORDS.some((word) => value.includes(word))) return "health";
  if (BEAUTY_WORDS.some((word) => value.includes(word))) return "beauty";
  return "beauty";
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
  const initial = await readCandidateStatus() || input.status;
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
    const productCache = await readProductCache();
    if (!productCache?.items?.length) throw new Error("Search Ad 상품 캐시가 없습니다.");
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
        for (const result of results) {
          if (result.status === "rejected") { errors.push(result.reason?.message || "유입 검색어 조회 실패"); continue; }
          statsSucceeded += 1;
          for (const row of statsRows(result.value)) {
            const keyword = normalize(row.schKeyword || row.keyword);
            if (keyword.length < 2 || keyword.length > 40) continue;
            const key = keyword.toLocaleLowerCase("ko-KR");
            const existing = candidateMap.get(key) || { keyword, category: classify(keyword), sources: [], impressions30d: 0, clicks30d: 0, accountNumbers: [] };
            if (!existing.sources.includes("searchad-query")) existing.sources.push("searchad-query");
            if (!existing.accountNumbers.includes(account.number)) existing.accountNumbers.push(account.number);
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
    for (const batch of chunks(seeds, 5)) {
      try {
        const payload = await searchAdGet(toolAccount, "/keywordstool", { hintKeywords: batch.join(","), showDetail: 1 }, metrics);
        for (const row of toolRows(payload)) {
          const keyword = normalize(row.relKeyword || row.keyword);
          if (keyword.length < 2 || keyword.length > 30) continue;
          const pc = numericVolume(row.monthlyPcQcCnt);
          const mobile = numericVolume(row.monthlyMobileQcCnt);
          const monthly = pc === null || mobile === null ? null : pc + mobile;
          const key = keyword.toLocaleLowerCase("ko-KR");
          const existing = candidateMap.get(key) || { keyword, category: classify(keyword), sources: [], impressions30d: 0, clicks30d: 0, accountNumbers: [] };
          if (!existing.sources.includes("keywordstool")) existing.sources.push("keywordstool");
          existing.monthlyPcSearches = pc;
          existing.monthlyMobileSearches = mobile;
          existing.monthlyTotalSearches = monthly;
          existing.competition = row.compIdx || null;
          if (monthly === null || monthly >= MIN_MONTHLY_SEARCH || existing.sources.includes("searchad-query")) {
            candidateMap.set(key, existing);
            keywordToolCount += 1;
          }
        }
      } catch (error) { errors.push(error.message); }
      processedSeeds += batch.length;
      if (processedSeeds % 25 < batch.length || processedSeeds === seeds.length) {
        await persist({ processedSeeds, apiCalls: metrics.apiCalls, retries: metrics.retries,
          message: `keywordstool 후보 확장 중 · ${processedSeeds.toLocaleString("ko-KR")} / ${seeds.length.toLocaleString("ko-KR")} seed` });
      }
    }

    const candidates = [...candidateMap.values()].filter((item) => item.sources.includes("searchad-query") || Number(item.monthlyTotalSearches || 0) >= MIN_MONTHLY_SEARCH);
    if (!candidates.length) throw new Error("Search Ad 실제 유입 검색어와 keywordstool에서 유효한 후보를 생성하지 못했습니다.");
    const refreshedAt = new Date().toISOString();
    const cache = {
      version: 1, refreshedAt, candidates, candidateCount: candidates.length,
      actualQueryCount: candidates.filter((item) => item.sources.includes("searchad-query")).length,
      keywordToolCount: candidates.filter((item) => item.sources.includes("keywordstool")).length,
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

exports._test = { normalize, classify, numericVolume, productSeeds, statsRows, toolRows };
