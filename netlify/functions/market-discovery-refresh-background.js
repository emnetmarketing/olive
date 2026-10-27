const { connect, readCache, writeCache, readTrustedChannels, readYoutubeSnapshot, writeYoutubeSnapshot,
  readProductCandidates, writeProductCandidates, mutateYoutubeUsage, readYoutubeUsage, claimWorker, writeOwnedStatus } = require("./market-discovery-cache");
const { readCache: readProductCache } = require("./search-ad-cache");
const { readCandidateCache } = require("./keyword-candidate-cache");
const { accounts, searchAdGet } = require("./search-ad-cache");
const { YOUTUBE_SEEDS, productCandidates, youtubeCandidates, mergeCandidates, discoveryPriority, selectMarketCacheItems, normalizedKeyword } = require("./market-discovery-core");
const { readHistory, writeHistory, mergeHistory, restoreHistory, mergeEarlySignalHistory } = require("./market-discovery-history-cache");
const earlySignals = require("./today-early-signal-cache");

const PRODUCT_BATCH = 2500; const MAX_CACHE = 5000; const MAX_PRODUCT_CANDIDATES = 15000;
const MAX_KEYWORDTOOL_BACKFILL = 750; const MAX_SEARCH_CALLS_PER_DAY = 90;
const SOURCE_BUDGET_MS = 180000; const ENRICHMENT_BUDGET_MS = 300000;
function youtubeQuotaDay(value = Date.now()) { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(value)); }
function chunks(values, size) { const output = []; for (let i = 0; i < values.length; i += size) output.push(values.slice(i, i + size)); return output; }
function toolRows(payload) { if (Array.isArray(payload)) return payload; for (const key of ["keywordList", "relKwdStat", "items", "results"]) if (Array.isArray(payload?.[key])) return payload[key]; return []; }
function numericVolume(value) { if (typeof value === "number" && Number.isFinite(value)) return value; const text = String(value || "").replace(/,/g, "").trim(); if (!text || text.includes("<")) return null; const result = Number(text); return Number.isFinite(result) ? result : null; }
async function youtubeGet(path, params, counters, hooks = {}) {
  const key = String(process.env.YOUTUBE_API_KEY || "").trim(); if (!key) throw new Error("YOUTUBE_API_KEY 미설정");
  if (hooks.deadline && Date.now() + 25000 >= hooks.deadline) throw Object.assign(new Error("YouTube 수집 안전시간 도달 · 확보한 원본으로 계속 진행"), { code: "SOURCE_TIME_BUDGET" });
  await hooks.beforeRequest?.(path);
  counters.api += 1; if (path === "search") counters.search += 1;
  const url = new URL(path, "https://www.googleapis.com/youtube/v3/"); Object.entries({ ...params, key }).forEach(([name, value]) => url.searchParams.set(name, String(value)));
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(20000) }); }
  catch (error) { await hooks.afterResponse?.(null, error.message); throw error; }
  const payload = await response.json().catch(() => ({}));
  await hooks.afterResponse?.(response.status, null, (payload.error?.errors || []).map((item) => item.reason).filter(Boolean));
  if (!response.ok) throw Object.assign(new Error(`YouTube API HTTP ${response.status} · ${payload.error?.message || "응답 오류"}`), { status: response.status });
  return payload;
}
async function collectYoutube(previousStatus, products, trustedChannels, hooks = {}) {
  const today = youtubeQuotaDay(); const counters = { search: previousStatus?.youtubeQuotaDate === today ? Number(previousStatus.youtubeSearchCallsToday || 0) : 0,
    api: previousStatus?.youtubeQuotaDate === today ? Number(previousStatus.youtubeApiCallsToday || 0) : 0 };
  const startSearch = counters.search, startSupplemental = counters.api - counters.search;
  const searchLimit = hooks.searchLimit ?? 52, supplementalLimit = hooks.supplementalLimit ?? 100;
  const videos = new Map(); const publishedAfter = new Date(Date.now() - 48 * 3600000).toISOString();
  const queriedSeeds = new Set();
  let error = null;
  try {
  for (const query of YOUTUBE_SEEDS) {
    for (let page = 0, pageToken = ""; page < 2 && counters.search < MAX_SEARCH_CALLS_PER_DAY && counters.search - startSearch < searchLimit; page += 1) {
      const payload = await youtubeGet("search", { part: "snippet", type: "video", order: "date", regionCode: "KR", relevanceLanguage: "ko",
        maxResults: 25, publishedAfter, q: query, ...(pageToken ? { pageToken } : {}) }, counters, hooks);
      queriedSeeds.add(query);
      for (const item of payload.items || []) { const snippet = item.snippet || {}; const videoId = item.id?.videoId; if (!videoId) continue;
        videos.set(videoId, { videoId, channelId: snippet.channelId || "", channelTitle: snippet.channelTitle || "", title: snippet.title || "",
          description: snippet.description || "", publishedAt: snippet.publishedAt || "", sourceQuery: query, discoveredAt: new Date().toISOString() }); }
      pageToken = payload.nextPageToken || ""; if (!pageToken) break;
    }
  }
  for (const channelId of (searchLimit < 52 ? [] : trustedChannels?.channels || []).slice(0, 50)) {
    if (counters.api - counters.search - startSupplemental >= supplementalLimit) break;
    const payload = await youtubeGet("activities", { part: "snippet,contentDetails", channelId, publishedAfter, maxResults: 25 }, counters, hooks);
    for (const item of payload.items || []) { const snippet = item.snippet || {}; const videoId = item.contentDetails?.upload?.videoId; if (!videoId) continue;
      videos.set(videoId, { videoId, channelId: snippet.channelId || channelId, channelTitle: snippet.channelTitle || "", title: snippet.title || "",
        description: snippet.description || "", publishedAt: snippet.publishedAt || "", sourceQuery: "trusted-channel", discoveredAt: new Date().toISOString(), trustedChannel: true }); }
  }
  const videoList = [...videos.values()];
  for (const batch of chunks(videoList.map((item) => item.videoId), 50)) {
    if (counters.api - counters.search - startSupplemental >= supplementalLimit) break;
    const payload = await youtubeGet("videos", { part: "statistics", id: batch.join(",") }, counters, hooks);
    for (const item of payload.items || []) { const video = videos.get(item.id); if (video) video.statistics = { viewCount: Number(item.statistics?.viewCount || 0),
      likeCount: Number(item.statistics?.likeCount || 0), commentCount: Number(item.statistics?.commentCount || 0) }; }
  }
  } catch (caught) { error = caught.message; }
  // Persist this original source before potentially expensive candidate extraction.
  const videoItems = [...videos.values()];
  return { videos: videoItems.length, videoItems, counters, quotaDate: today, error,
    partial: Boolean(error) || searchLimit < 52 || queriedSeeds.size < YOUTUBE_SEEDS.length || videoItems.some((item) => !item.statistics),
    attempted: counters.api > Number(previousStatus?.youtubeApiCallsToday || 0) };
}
function prioritizedKeywordtoolBackfill(items, limit = MAX_KEYWORDTOOL_BACKFILL) {
  const pending = (items || []).filter((item) => !item.monthlySearchStatus || ["not-requested", "request-failed"].includes(item.monthlySearchStatus));
  const scoreSort = (a, b) => discoveryPriority(b) - discoveryPriority(a);
  const groups = [pending.slice().sort(scoreSort).slice(0, 400),
    pending.filter((item) => item.discoverySource?.includes("youtube")).sort(scoreSort).slice(0, 200),
    pending.filter((item) => item.relatedBrand && (item.relatedProductType || item.relatedProductLine)).sort(scoreSort).slice(0, 300),
    pending.filter((item) => item.discoverySource?.includes("searchad-new-query")).sort(scoreSort).slice(0, 200)];
  const selected = []; const keys = new Set();
  for (const item of groups.flat()) { if (selected.length >= limit) break; if (keys.has(item.normalizedKeyword)) continue; keys.add(item.normalizedKeyword); selected.push(item); }
  if (selected.length < limit) for (const item of pending.slice().sort(scoreSort)) {
    if (selected.length >= limit) break; if (keys.has(item.normalizedKeyword)) continue; keys.add(item.normalizedKeyword); selected.push(item);
  }
  return selected;
}
exports.handler = async (event, context = {}) => {
  connect(event); let input; try { input = JSON.parse(event.body || "{}"); } catch { return; }
  if (!input.jobId) return;
  let status = await claimWorker(input.jobId);
  const invocationId = context.awsRequestId || event.headers?.["x-nf-request-id"] || status?.workerOwner || null;
  const trace = (eventName, extra = {}) => console.info(JSON.stringify({ event: eventName, jobId: input.jobId, invocationId,
    workerOwner: status?.workerOwner || null, stage: status?.stage || null, at: new Date().toISOString(), ...extra }));
  if (!status) { trace("discovery-worker-skipped"); return; }
  trace("discovery-worker-entered", { sourceMode: status.sourceMode });
  const started = Date.now(); const errors = [];
  const persist = async (patch) => { status = await writeOwnedStatus(status.jobId, status.workerOwner, patch); };
  const stage = async (name, message, extra = {}) => { await persist({ stage: name, message, ...extra }); trace("discovery-stage"); };
  try {
    await stage("source-cache-read", "Discovery 원본 캐시 확인 중");
    const [previous, productCache, candidateCache, trustedChannels, history, storedYoutube, productCandidateCache] = await Promise.all([
      readCache(), readProductCache(), readCandidateCache(), readTrustedChannels(), readHistory(), readYoutubeSnapshot(), readProductCandidates()]);
    if (!productCache?.items?.length) throw new Error("Search Ad 상품 캐시가 없습니다.");
    const previousItems = previous?.items || [];
    const searchAdItems = (candidateCache?.candidates || []).filter((item) => item.isNewSearchQuery && item.sources?.includes("searchad-query")).map((item) => ({
      keyword: item.keyword, normalizedKeyword: normalizedKeyword(item.keyword), discoverySource: ["searchad-new-query"], sourceConfidence: 82,
      relatedBrand: "", relatedProductType: "", relatedProductLine: "", category: item.category, categoryEvidence: item.categoryEvidence,
      monthlySearchStatus: item.monthlyVolumeStatus, monthlyTotalSearches: item.monthlyTotalSearches,
      searchAdEvidence: { firstSeenAt: item.firstSeenAt, lastSeenAt: item.lastSeenAt, observedAt: item.lastSeenAt || candidateCache.refreshedAt,
        previousObservedAt: item.previousSearchAdObservedAt || null, previousObservationAvailable: item.previousSearchAdObservationAvailable === true,
        isNewlyObserved: item.isNewSearchQuery === true, observationSource: "search-ad-stats",
        sourceRefreshedAt: candidateCache.refreshedAt, observationWindow: "unspecified_api_default", recentImpressions: item.impressions30d, recentClicks: item.clicks30d,
        previousImpressions: item.previousImpressions30d, previousClicks: item.previousClicks30d,
        accountSources: item.accountNumbers || [] }, evidence: [{ source: "searchad-new-query", impressions: item.impressions30d, clicks: item.clicks30d }] }));
    const initialUsage = await readYoutubeUsage(); const quotaDate = youtubeQuotaDay();
    let usage = initialUsage?.quotaDate === quotaDate ? initialUsage : { quotaDate, search: 0, api: 0, officialRemaining: null, estimateOnly: true };
    let youtubeSource = storedYoutube;
    let youtube = { videos: storedYoutube?.items?.length || 0, videoItems: storedYoutube?.items || [],
      counters: { search: Number(usage.search || 0), api: Number(usage.api || 0) }, quotaDate, reused: true, items: [] };
    await stage("youtube-source", status.sourceMode === "cache-only" ? "저장된 YouTube 원본 재사용 중 · 외부 API 없음" : "YouTube 최신 원본 확인 중");
    if (status.sourceMode !== "cache-only" && String(process.env.YOUTUBE_API_KEY || "").trim()) {
      if (usage.providerBlocked) errors.push("YouTube 공식 quota 제한 기록 · 다음 PT quota 일자까지 기존 원본 사용");
      else if (Number(usage.search || 0) < MAX_SEARCH_CALLS_PER_DAY) {
        youtube = await collectYoutube({ youtubeQuotaDate: quotaDate, youtubeSearchCallsToday: usage.search, youtubeApiCallsToday: usage.api }, productCache.items, trustedChannels, {
          deadline: started + SOURCE_BUDGET_MS, searchLimit: status.youtubeSearchLimit, supplementalLimit: status.youtubeSupplementalLimit,
          beforeRequest: async (path) => {
            // Reserve before fetch: even a hard termination cannot silently lose an attempted call.
            usage = await mutateYoutubeUsage((previousUsage) => {
              const old = previousUsage?.quotaDate === quotaDate ? previousUsage : { quotaDate, search: 0, api: 0, http200: 0, http429: 0, other: 0 };
              if (old.providerBlocked || (path === "search" && Number(old.search || 0) >= MAX_SEARCH_CALLS_PER_DAY)) throw new Error("YouTube 안전예산 또는 공식 quota 제한 · 기존 원본 사용");
              return { ...old, search: Number(old.search || 0) + Number(path === "search"), api: Number(old.api || 0) + 1,
                lastAttemptAt: new Date().toISOString(), jobId: status.jobId, quotaTimeZone: "America/Los_Angeles", estimateOnly: true, officialRemaining: null };
            });
            await persist({ youtubeQuotaDate: quotaDate, youtubeSearchCallsToday: usage.search, youtubeApiCallsToday: usage.api });
          },
          afterResponse: async (httpStatus, transportError, reasons = []) => {
            const quota403 = httpStatus === 403 && reasons.some((reason) => ["quotaExceeded", "dailyLimitExceeded"].includes(reason));
            usage = await mutateYoutubeUsage((old) => ({ ...old, updatedAt: new Date().toISOString(),
              http200: Number(old.http200 || 0) + Number(httpStatus === 200), http429: Number(old.http429 || 0) + Number(httpStatus === 429),
              other: Number(old.other || 0) + Number(httpStatus !== 200 && httpStatus !== 429),
              providerBlocked: old.providerBlocked || httpStatus === 429 || quota403, lastHttpStatus: httpStatus,
              lastErrorReasons: reasons, lastTransportError: transportError || null }));
          },
        });
        if (youtube.error) errors.push(youtube.error);
        if (youtube.videoItems.length || (youtube.attempted && !youtube.error)) {
          youtubeSource = { version: 2, jobId: status.jobId, refreshedAt: new Date().toISOString(), partial: youtube.partial,
            quotaDate, counters: youtube.counters, items: youtube.videoItems };
          await writeYoutubeSnapshot(youtubeSource);
          await stage("youtube-source-saved", "YouTube 원본 저장 완료 · 후보 결합 중", { youtubeSourceSavedAt: youtubeSource.refreshedAt, youtubeVideos: youtube.videoItems.length });
        } else { youtube.reused = true; youtube.videoItems = storedYoutube?.items || []; }
      }
    } else if (status.sourceMode !== "cache-only") errors.push("YOUTUBE_API_KEY 미설정 · 기존 소스로 계속 진행");
    // Save the source first. Candidate CPU work must not lose a completed source collection.
    await stage("product-candidates", `상품 기반 후보 생성 중 · ${productCache.items.length.toLocaleString("ko-KR")} / ${productCache.items.length.toLocaleString("ko-KR")}`);
    const productCacheReusable = productCache.refreshedAt && productCandidateCache?.sourceRefreshedAt === productCache.refreshedAt
      && productCandidateCache?.version === 1 && Array.isArray(productCandidateCache.items);
    const productItems = productCacheReusable ? productCandidateCache.items : productCandidates(productCache.items, { brandProducts: productCache.items, limit: MAX_PRODUCT_CANDIDATES })
      .map((item) => ({ ...item, discoverySource: ["product-cache"] }));
    if (!productCacheReusable) await writeProductCandidates({ version: 1, sourceRefreshedAt: productCache.refreshedAt, items: productItems });
    await stage("youtube-candidates", "저장된 YouTube 원본의 상품 문맥 추출 중");
    youtube.items = youtubeCandidates(youtubeSource?.items || [], productCache.items);
    youtube.videos = youtubeSource?.items?.length || 0;
    await stage("candidate-merge", "원본 후보 결합 및 우선순위 계산 중", { sourceSuccessTimes: { youtube: youtubeSource?.refreshedAt || null, searchAd: candidateCache?.refreshedAt || null } });
    const discoveredItems = restoreHistory(mergeCandidates(previousItems, [...productItems, ...youtube.items, ...searchAdItems]), history);
    let items = selectMarketCacheItems(discoveredItems, MAX_CACHE);
    const metrics = { apiCalls: 0, retries: 0 }; const toolAccount = accounts().find((item) => item.apiKey && item.secretKey && item.customerId);
    const backfill = prioritizedKeywordtoolBackfill(items);
    let backfillProcessed = 0;
    const applyKeywordtoolRow = (item, row) => {
      const pc = numericVolume(row?.monthlyPcQcCnt), mobile = numericVolume(row?.monthlyMobileQcCnt);
      item.keywordtoolCheckedAt = new Date().toISOString(); item.monthlySearchStatus = pc !== null && mobile !== null ? "available" : "keywordtool-unavailable";
      item.monthlyPcSearches = pc; item.monthlyMobileSearches = mobile; item.monthlyTotalSearches = pc !== null && mobile !== null ? pc + mobile : null;
    };
    await stage("keywordtool-backfill", status.sourceMode === "cache-only" ? "저장된 월간검색량 사용 · 외부 API 없음" : "선택 후보 월간검색량 보강 중");
    if (toolAccount && status.sourceMode !== "cache-only" && status.keywordtoolBackfill !== false) for (const batch of chunks(backfill, 5)) {
      // A Search Ad call can take four 20s attempts. Keep ample time for final Blob publication.
      if (Date.now() - started + 90000 >= ENRICHMENT_BUDGET_MS) break;
      try {
        const payload = await searchAdGet(toolAccount, "/keywordstool", { hintKeywords: batch.map((item) => item.keyword).join(","), showDetail: 1 }, metrics);
        const byKeyword = new Map(toolRows(payload).map((row) => [normalizedKeyword(row.relKeyword || row.keyword), row]));
        for (const item of batch) applyKeywordtoolRow(item, byKeyword.get(item.normalizedKeyword));
      } catch (batchError) {
        if (Date.now() - started + 90000 >= ENRICHMENT_BUDGET_MS) { errors.push(batchError.message); break; }
        const retries = await Promise.allSettled(batch.map(async (item) => {
          const payload = await searchAdGet(toolAccount, "/keywordstool", { hintKeywords: item.keyword, showDetail: 1 }, metrics);
          const row = toolRows(payload).find((entry) => normalizedKeyword(entry.relKeyword || entry.keyword) === item.normalizedKeyword);
          applyKeywordtoolRow(item, row);
        }));
        retries.forEach((result, index) => { if (result.status === "rejected") {
          const item = batch[index]; item.keywordtoolCheckedAt = new Date().toISOString(); item.monthlySearchStatus = "request-failed";
          errors.push(result.reason?.message || batchError.message);
        } });
      }
      backfillProcessed += batch.length;
      await persist({ keywordtoolChecked: backfillProcessed, keywordtoolPending: Math.max(0, backfill.length - backfillProcessed), apiCalls: metrics.apiCalls,
        message: `선택 후보 월간검색량 보강 중 · ${backfillProcessed} / ${backfill.length}` });
    }
    if (status.sourceMode !== "cache-only" && status.keywordtoolBackfill !== false && backfillProcessed < backfill.length)
      errors.push("월간검색량 보강 일부 대기 · 안전 실행시간 내 확보한 원본과 기존 값으로 게시");
    await stage("early-signal-calculation", "저장된 원본으로 오늘 신호 계산 중");
    items = selectMarketCacheItems(items.filter((item) => Date.now() - Date.parse(item.lastSeenAt || item.discoveredAt || 0) <= 45 * 86400000), MAX_CACHE)
      .map((item, index) => ({ ...item, marketDiscoveryRank: index + 1 }));
    const refreshedAt = new Date().toISOString(); const sourceCount = (source) => items.filter((item) => item.discoverySource?.includes(source)).length;
    const ratioOnlyCandidateCount = items.filter((item) => item.monthlySearchStatus === "keywordtool-unavailable" && item.sourceConfidence >= 75
      && (item.discoverySource?.length > 1 || item.discoverySource?.includes("searchad-new-query") || item.relatedBrand && (item.relatedProductType || item.relatedProductLine))).length;
    const cache = { version: 1, jobId: status.jobId, refreshedAt, items, sourceCounts: { youtube: sourceCount("youtube"), productCache: sourceCount("product-cache"), searchAdNewQuery: sourceCount("searchad-new-query") },
      monthlyVolumeCounts: { available: items.filter((item) => item.monthlySearchStatus === "available").length,
        unavailable: items.filter((item) => item.monthlySearchStatus === "keywordtool-unavailable").length,
        notRequested: items.filter((item) => !item.monthlySearchStatus || item.monthlySearchStatus === "not-requested").length,
        requestFailed: items.filter((item) => item.monthlySearchStatus === "request-failed").length }, ratioOnlyCandidateCount,
      productBackfill: { cursor: productCache.items.length, processedThisRun: productCache.items.length, total: productCache.items.length, completeCycle: true },
      youtube: { enabled: Boolean(String(process.env.YOUTUBE_API_KEY || "").trim()), quotaDate: youtube.quotaDate,
        searchCallsToday: Number(usage.search || 0), apiCallsToday: Number(usage.api || 0),
        remainingSearchQuotaEstimate: Math.max(0, MAX_SEARCH_CALLS_PER_DAY - Number(usage.search || 0)), officialRemaining: null,
        quotaTimeZone: "America/Los_Angeles", estimateOnly: true, providerBlocked: Boolean(usage.providerBlocked), collectedVideos: youtube.videos,
        generatedCandidates: youtube.items.length, sourcePartial: Boolean(youtubeSource?.partial),
        lastSuccessAt: youtubeSource?.refreshedAt || null, lastError: errors.find((item) => item.includes("YouTube")) || null },
      sourceSuccessTimes: { youtube: youtubeSource?.refreshedAt || null, searchAd: candidateCache?.refreshedAt || null },
      sourceObservationPolicy: { searchAd: "refresh_observation_window_unspecified" }, sourceMode: status.sourceMode,
      keywordtool: { checkedThisRun: backfillProcessed, pending: Math.max(0, backfill.length - backfillProcessed), apiCalls: metrics.apiCalls, retries: metrics.retries }, errors: errors.slice(0, 20) };
    const previousEarly = await earlySignals.readCache();
    const todaySignals = earlySignals.buildEarlySignals(items, history, refreshedAt, { requireFreshSource: true });
    const earlyByKeyword = new Map(todaySignals.map((signal) => [signal.normalizedKeyword, signal]));
    items = items.map((item) => ({ ...item, todayEarlySignalScore: earlyByKeyword.get(item.normalizedKeyword)?.todayEarlySignalScore || 0 }));
    cache.items = items;
    const hasFreshYoutube = youtubeSource?.refreshedAt && Date.parse(refreshedAt) - Date.parse(youtubeSource.refreshedAt) <= 6 * 3600000;
    const hasFreshSearchAd = candidateCache?.refreshedAt && earlySignals.kstDate(candidateCache.refreshedAt) === earlySignals.kstDate(refreshedAt);
    const hasFreshSources = hasFreshYoutube || hasFreshSearchAd;
    const todayCache = { ...(hasFreshSources ? earlySignals.mergeCache(previousEarly, todaySignals, refreshedAt) : previousEarly),
      jobId: hasFreshSources ? status.jobId : previousEarly?.jobId || null, lastRefreshAttemptAt: refreshedAt,
      refreshFailure: hasFreshSources ? null : { code: "NO_CURRENT_SOURCE", attemptedAt: refreshedAt, message: "당일 원본 관측 없음 · 이전 신호와 기준일 유지" },
      sourceSuccessTimes: cache.sourceSuccessTimes, sourceObservationPolicy: cache.sourceObservationPolicy,
      sourceErrors: errors.slice(0, 20), sourcePartial: Boolean(youtubeSource?.partial), sourceMode: status.sourceMode };
    await stage("derived-cache-publication", "분석 후보와 오늘 신호 게시 중");
    await Promise.all([writeCache(cache), earlySignals.writeCache(todayCache)]);
    await stage("history-publication", "후보·오늘 신호 이력 저장 중", { derivedPublishedAt: refreshedAt });
    const mergedHistory = mergeHistory(history, discoveredItems.map((item) => ({ ...item,
      todayEarlySignalScore: earlyByKeyword.get(item.normalizedKeyword)?.todayEarlySignalScore || 0 })), new Set(items.map((item) => item.normalizedKeyword)), refreshedAt);
    await writeHistory(mergeEarlySignalHistory(mergedHistory, todaySignals, refreshedAt));
    await persist({ state: "completed", stage: "completed", message: errors.length ? "신규 시장 후보 게시 완료 · 일부 소스 보강 대기" : "신규 시장 후보 수집 완료", completedAt: new Date().toISOString(), durationMs: Date.now() - started,
      candidateCount: items.length, sourceCounts: cache.sourceCounts, youtubeQuotaDate: youtube.quotaDate,
      youtubeSearchCallsToday: Number(usage.search || 0), youtubeApiCallsToday: Number(usage.api || 0), youtubeVideos: youtube.videos,
      youtubeCandidates: youtube.items.length, productCandidates: productItems.length, searchAdNewCandidates: searchAdItems.length,
      keywordtoolChecked: backfillProcessed, ratioOnlyCandidateCount, errors: errors.slice(0, 20) });
    trace("discovery-completed", { sourceSuccessTimes: cache.sourceSuccessTimes, youtubeApiCalls: usage.api || 0, youtubeSearchCalls: usage.search || 0,
      keywordtoolApiCalls: metrics.apiCalls, candidateCount: items.length, signalCount: todayCache.items?.length || 0 });
  } catch (error) {
    trace("discovery-failed", { errorCode: error.code || "DISCOVERY_STAGE_FAILED" });
    if (error.code === "DISCOVERY_WORKER_FENCED") return;
    await persist({ state: "failed", failedStage: status.stage, message: "신규 시장 후보 후속 처리 실패 · 저장된 원본/기존 결과 보존", failedAt: new Date().toISOString(), durationMs: Date.now() - started,
      resumableFromSources: true, errors: [error.message, ...errors].slice(0, 20) });
  }
};

exports._test = { collectYoutube, numericVolume, toolRows, prioritizedKeywordtoolBackfill,
  youtubeQuotaDay, SOURCE_BUDGET_MS, ENRICHMENT_BUDGET_MS,
  PRODUCT_BATCH, MAX_CACHE, MAX_PRODUCT_CANDIDATES, MAX_KEYWORDTOOL_BACKFILL };
