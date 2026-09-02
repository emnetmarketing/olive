const { connect, readCache, writeCache, readStatus, writeStatus, readTrustedChannels, writeYoutubeSnapshot } = require("./market-discovery-cache");
const { readCache: readProductCache } = require("./search-ad-cache");
const { readCandidateCache } = require("./keyword-candidate-cache");
const { accounts, searchAdGet } = require("./search-ad-cache");
const { YOUTUBE_SEEDS, productCandidates, youtubeCandidates, mergeCandidates, discoveryPriority, selectMarketCacheItems, normalizedKeyword } = require("./market-discovery-core");
const { readHistory, writeHistory, mergeHistory, restoreHistory } = require("./market-discovery-history-cache");

const PRODUCT_BATCH = 2500; const MAX_CACHE = 5000; const MAX_PRODUCT_CANDIDATES = 15000;
const MAX_KEYWORDTOOL_BACKFILL = 750; const MAX_SEARCH_CALLS_PER_DAY = 90;
function seoulDay() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date()); }
function chunks(values, size) { const output = []; for (let i = 0; i < values.length; i += size) output.push(values.slice(i, i + size)); return output; }
function toolRows(payload) { if (Array.isArray(payload)) return payload; for (const key of ["keywordList", "relKwdStat", "items", "results"]) if (Array.isArray(payload?.[key])) return payload[key]; return []; }
function numericVolume(value) { if (typeof value === "number" && Number.isFinite(value)) return value; const text = String(value || "").replace(/,/g, "").trim(); if (!text || text.includes("<")) return null; const result = Number(text); return Number.isFinite(result) ? result : null; }
async function youtubeGet(path, params, counters) {
  const key = String(process.env.YOUTUBE_API_KEY || "").trim(); if (!key) throw new Error("YOUTUBE_API_KEY 미설정");
  const url = new URL(path, "https://www.googleapis.com/youtube/v3/"); Object.entries({ ...params, key }).forEach(([name, value]) => url.searchParams.set(name, String(value)));
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) }); counters.api += 1; if (path.includes("search")) counters.search += 1;
  const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(`YouTube API HTTP ${response.status} · ${payload.error?.message || "응답 오류"}`); return payload;
}
async function collectYoutube(previousStatus, products, trustedChannels) {
  const today = seoulDay(); const counters = { search: previousStatus?.youtubeQuotaDate === today ? Number(previousStatus.youtubeSearchCallsToday || 0) : 0,
    api: previousStatus?.youtubeQuotaDate === today ? Number(previousStatus.youtubeApiCallsToday || 0) : 0 };
  const videos = new Map(); const publishedAfter = new Date(Date.now() - 48 * 3600000).toISOString();
  for (const query of YOUTUBE_SEEDS) {
    for (let page = 0, pageToken = ""; page < 2 && counters.search < MAX_SEARCH_CALLS_PER_DAY; page += 1) {
      const payload = await youtubeGet("search", { part: "snippet", type: "video", order: "date", regionCode: "KR", relevanceLanguage: "ko",
        maxResults: 25, publishedAfter, q: query, ...(pageToken ? { pageToken } : {}) }, counters);
      for (const item of payload.items || []) { const snippet = item.snippet || {}; const videoId = item.id?.videoId; if (!videoId) continue;
        videos.set(videoId, { videoId, channelId: snippet.channelId || "", channelTitle: snippet.channelTitle || "", title: snippet.title || "",
          description: snippet.description || "", publishedAt: snippet.publishedAt || "", sourceQuery: query, discoveredAt: new Date().toISOString() }); }
      pageToken = payload.nextPageToken || ""; if (!pageToken) break;
    }
  }
  for (const channelId of (trustedChannels?.channels || []).slice(0, 50)) {
    const payload = await youtubeGet("activities", { part: "snippet,contentDetails", channelId, publishedAfter, maxResults: 25 }, counters);
    for (const item of payload.items || []) { const snippet = item.snippet || {}; const videoId = item.contentDetails?.upload?.videoId; if (!videoId) continue;
      videos.set(videoId, { videoId, channelId: snippet.channelId || channelId, channelTitle: snippet.channelTitle || "", title: snippet.title || "",
        description: snippet.description || "", publishedAt: snippet.publishedAt || "", sourceQuery: "trusted-channel", discoveredAt: new Date().toISOString(), trustedChannel: true }); }
  }
  const videoList = [...videos.values()];
  for (const batch of chunks(videoList.map((item) => item.videoId), 50)) {
    const payload = await youtubeGet("videos", { part: "statistics", id: batch.join(",") }, counters);
    for (const item of payload.items || []) { const video = videos.get(item.id); if (video) video.statistics = { viewCount: Number(item.statistics?.viewCount || 0),
      likeCount: Number(item.statistics?.likeCount || 0), commentCount: Number(item.statistics?.commentCount || 0) }; }
  }
  return { items: youtubeCandidates(videoList, products), videos: videoList.length, videoItems: videoList, counters, quotaDate: today };
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
exports.handler = async (event) => {
  connect(event); let input; try { input = JSON.parse(event.body || "{}"); } catch { return; }
  let status = await readStatus(); if (!status || status.jobId !== input.jobId) status = input.status; if (!status?.jobId) return;
  const started = Date.now(); const errors = []; const persist = async (patch) => { status = { ...status, ...patch, updatedAt: new Date().toISOString() }; await writeStatus(status); };
  try {
    const [previous, productCache, candidateCache, trustedChannels, history] = await Promise.all([readCache(), readProductCache(), readCandidateCache(), readTrustedChannels(), readHistory()]);
    if (!productCache?.items?.length) throw new Error("Search Ad 상품 캐시가 없습니다.");
    const previousItems = previous?.items || [];
    await persist({ message: `상품 기반 후보 생성 중 · ${productCache.items.length.toLocaleString("ko-KR")} / ${productCache.items.length.toLocaleString("ko-KR")}` });
    const productItems = productCandidates(productCache.items, { brandProducts: productCache.items, limit: MAX_PRODUCT_CANDIDATES })
      .map((item) => ({ ...item, discoverySource: ["product-cache"] }));
    const searchAdItems = (candidateCache?.candidates || []).filter((item) => item.isNewSearchQuery && item.sources?.includes("searchad-query")).map((item) => ({
      keyword: item.keyword, normalizedKeyword: normalizedKeyword(item.keyword), discoverySource: ["searchad-new-query"], sourceConfidence: 82,
      relatedBrand: "", relatedProductType: "", relatedProductLine: "", category: item.category, categoryEvidence: item.categoryEvidence,
      monthlySearchStatus: item.monthlyVolumeStatus, monthlyTotalSearches: item.monthlyTotalSearches,
      searchAdEvidence: { firstSeenAt: item.firstSeenAt, lastSeenAt: item.lastSeenAt, recentImpressions: item.impressions30d, recentClicks: item.clicks30d,
        accountSources: item.accountNumbers || [] }, evidence: [{ source: "searchad-new-query", impressions: item.impressions30d, clicks: item.clicks30d }] }));
    const previousYoutubeStatus = { youtubeQuotaDate: previous?.youtube?.quotaDate || status.youtubeQuotaDate,
      youtubeSearchCallsToday: previous?.youtube?.searchCallsToday ?? status.youtubeSearchCallsToday,
      youtubeApiCallsToday: previous?.youtube?.apiCallsToday ?? status.youtubeApiCallsToday };
    let youtube = { items: [], videos: Number(previous?.youtube?.collectedVideos || 0), videoItems: [], counters: {
      search: previousYoutubeStatus.youtubeQuotaDate === seoulDay() ? Number(previousYoutubeStatus.youtubeSearchCallsToday || 0) : 0,
      api: previousYoutubeStatus.youtubeQuotaDate === seoulDay() ? Number(previousYoutubeStatus.youtubeApiCallsToday || 0) : 0,
    }, quotaDate: seoulDay(), reused: true, generatedCandidates: Number(previous?.youtube?.generatedCandidates || 0) };
    try {
      if (String(process.env.YOUTUBE_API_KEY || "").trim()) {
        if (youtube.counters.search < MAX_SEARCH_CALLS_PER_DAY) youtube = await collectYoutube(previousYoutubeStatus, productCache.items, trustedChannels);
      } else errors.push("YOUTUBE_API_KEY 미설정 · 기존 소스로 계속 진행");
    } catch (error) { errors.push(error.message); }
    if (!youtube.reused && youtube.videoItems?.length) await writeYoutubeSnapshot({ version: 1, refreshedAt: new Date().toISOString(), items: youtube.videoItems });
    const discoveredItems = restoreHistory(mergeCandidates(previousItems, [...productItems, ...youtube.items, ...searchAdItems]), history);
    let items = selectMarketCacheItems(discoveredItems, MAX_CACHE);
    const metrics = { apiCalls: 0, retries: 0 }; const toolAccount = accounts().find((item) => item.apiKey && item.secretKey && item.customerId);
    const backfill = prioritizedKeywordtoolBackfill(items);
    const applyKeywordtoolRow = (item, row) => {
      const pc = numericVolume(row?.monthlyPcQcCnt), mobile = numericVolume(row?.monthlyMobileQcCnt);
      item.keywordtoolCheckedAt = new Date().toISOString(); item.monthlySearchStatus = pc !== null && mobile !== null ? "available" : "keywordtool-unavailable";
      item.monthlyPcSearches = pc; item.monthlyMobileSearches = mobile; item.monthlyTotalSearches = pc !== null && mobile !== null ? pc + mobile : null;
    };
    if (toolAccount) for (const batch of chunks(backfill, 5)) {
      try {
        const payload = await searchAdGet(toolAccount, "/keywordstool", { hintKeywords: batch.map((item) => item.keyword).join(","), showDetail: 1 }, metrics);
        const byKeyword = new Map(toolRows(payload).map((row) => [normalizedKeyword(row.relKeyword || row.keyword), row]));
        for (const item of batch) applyKeywordtoolRow(item, byKeyword.get(item.normalizedKeyword));
      } catch (batchError) {
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
    }
    items = selectMarketCacheItems(items.filter((item) => Date.now() - Date.parse(item.lastSeenAt || item.discoveredAt || 0) <= 45 * 86400000), MAX_CACHE)
      .map((item, index) => ({ ...item, marketDiscoveryRank: index + 1 }));
    const refreshedAt = new Date().toISOString(); const sourceCount = (source) => items.filter((item) => item.discoverySource?.includes(source)).length;
    const ratioOnlyCandidateCount = items.filter((item) => item.monthlySearchStatus === "keywordtool-unavailable" && item.sourceConfidence >= 75
      && (item.discoverySource?.length > 1 || item.discoverySource?.includes("searchad-new-query") || item.relatedBrand && (item.relatedProductType || item.relatedProductLine))).length;
    const cache = { version: 1, refreshedAt, items, sourceCounts: { youtube: sourceCount("youtube"), productCache: sourceCount("product-cache"), searchAdNewQuery: sourceCount("searchad-new-query") },
      monthlyVolumeCounts: { available: items.filter((item) => item.monthlySearchStatus === "available").length,
        unavailable: items.filter((item) => item.monthlySearchStatus === "keywordtool-unavailable").length,
        notRequested: items.filter((item) => !item.monthlySearchStatus || item.monthlySearchStatus === "not-requested").length,
        requestFailed: items.filter((item) => item.monthlySearchStatus === "request-failed").length }, ratioOnlyCandidateCount,
      productBackfill: { cursor: productCache.items.length, processedThisRun: productCache.items.length, total: productCache.items.length, completeCycle: true },
      youtube: { enabled: Boolean(String(process.env.YOUTUBE_API_KEY || "").trim()), quotaDate: youtube.quotaDate,
        searchCallsToday: youtube.counters.search, apiCallsToday: youtube.counters.api,
        remainingSearchQuotaEstimate: Math.max(0, 100 - youtube.counters.search), collectedVideos: youtube.videos,
        generatedCandidates: youtube.reused ? youtube.generatedCandidates : youtube.items.length,
        lastSuccessAt: youtube.reused ? previous?.youtube?.lastSuccessAt || null : refreshedAt, lastError: errors.find((item) => item.includes("YouTube")) || null },
      keywordtool: { checkedThisRun: backfill.length, apiCalls: metrics.apiCalls, retries: metrics.retries }, errors: errors.slice(0, 20) };
    await writeCache(cache);
    await writeHistory(mergeHistory(history, discoveredItems, new Set(items.map((item) => item.normalizedKeyword)), refreshedAt));
    await persist({ state: "completed", message: "신규 시장 후보 수집 완료", completedAt: refreshedAt, durationMs: Date.now() - started,
      candidateCount: items.length, sourceCounts: cache.sourceCounts, youtubeQuotaDate: youtube.quotaDate,
      youtubeSearchCallsToday: youtube.counters.search, youtubeApiCallsToday: youtube.counters.api, youtubeVideos: youtube.videos,
      youtubeCandidates: youtube.items.length, productCandidates: productItems.length, searchAdNewCandidates: searchAdItems.length,
      keywordtoolChecked: backfill.length, ratioOnlyCandidateCount, errors: errors.slice(0, 20) });
  } catch (error) { await persist({ state: "failed", message: "신규 시장 후보 수집 실패 · 마지막 정상 캐시 유지", failedAt: new Date().toISOString(), durationMs: Date.now() - started, errors: [error.message, ...errors].slice(0, 20) }); }
};

exports._test = { collectYoutube, numericVolume, toolRows, prioritizedKeywordtoolBackfill,
  PRODUCT_BATCH, MAX_CACHE, MAX_PRODUCT_CANDIDATES, MAX_KEYWORDTOOL_BACKFILL };
