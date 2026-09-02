const { connect, readCache } = require("./market-discovery-cache");
const { connect: connectTrend, readCache: readTrendCache } = require("./trend-series-cache");
const { readDiagnosticIndex } = require("./trend-analysis-cache");
const { normalizedKeyword } = require("./market-discovery-core");
const { selectWithMarketDiscovery } = require("./trend-analysis-background")._test;

const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
const WINDOW_MS = { today: 24 * 60 * 60 * 1000, "24h": 24 * 60 * 60 * 1000, "3d": 3 * 86400000, "7d": 7 * 86400000, all: Infinity };
function discoverySortScore(item, now = Date.now()) {
  const sources = new Set(item.discoverySource || []); const ageHours = Math.max(0, (now - Date.parse(item.discoveredAt || 0)) / 3600000);
  return Math.max(0, 168 - ageHours) * 100000 + Number(sources.size > 1) * 5000000
    + Number(sources.has("youtube")) * 2000000 + Number(sources.has("searchad-new-query")) * 1000000
    + Number(Boolean(item.relatedBrand && (item.relatedProductType || item.relatedProductLine))) * 500000
    + Number(item.sourceConfidence || 0) * 1000 + Math.log10(Number(item.monthlyTotalSearches || 0) + 1) * 100;
}
function inWindow(item, windowName, now = Date.now()) {
  if (windowName === "today") {
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
    return formatter.format(new Date(item.discoveredAt || 0)) === formatter.format(new Date(now));
  }
  const duration = WINDOW_MS[windowName] ?? WINDOW_MS["24h"];
  return duration === Infinity || now - Date.parse(item.discoveredAt || 0) <= duration;
}

exports.handler = async (event) => {
  connect(event); connectTrend(event);
  if (event.httpMethod !== "GET") return json(405, { error: "GET 요청만 허용됩니다." });
  try {
    const windowName = String(event.queryStringParameters?.window || "24h"); const limit = Math.min(100, Math.max(1, Number(event.queryStringParameters?.limit || 100)));
    const [market, trend, diagnostic] = await Promise.all([readCache(), readTrendCache(), readDiagnosticIndex()]);
    const marketItems = market?.items || [];
    const selection = selectWithMarketDiscovery([], marketItems, new Map(), 500, 500);
    const protectedItems = [...selection.selected, ...selection.ratioOnly];
    const protectedRanks = new Map(protectedItems.map((item, index) => [normalizedKeyword(item.keyword), index + 1]));
    const traces = new Map((diagnostic?.items || []).map((item) => [item.normalizedKeyword, item]));
    const rows = marketItems.filter((item) => inWindow(item, windowName)).sort((a, b) => discoverySortScore(b) - discoverySortScore(a)).slice(0, limit)
      .map((item, index) => {
        const key = normalizedKeyword(item.keyword); const trendRecord = trend.entries.get(key)?.search || null; const trace = traces.get(key) || null;
        let trendStatus = trendRecord ? "completed" : protectedRanks.has(key) ? "pending" : "not-selected";
        if (trace?.searchTrendStatus === "pending-cache") trendStatus = trace.trendWaitReason || "fast_path_cache_wait";
        else if (trace?.searchTrendStatus === "valid" || trace?.searchTrendStatus === "empty") trendStatus = "completed";
        return { rank: index + 1, keyword: item.keyword, normalizedKeyword: key, discoverySource: item.discoverySource || [],
          discoveredAt: item.discoveredAt || null, lastSeenAt: item.lastSeenAt || null, sourceConfidence: Number(item.sourceConfidence || 0),
          relatedBrand: item.relatedBrand || "", relatedProductType: item.relatedProductType || "", relatedProductLine: item.relatedProductLine || "",
          monthlySearchStatus: item.monthlySearchStatus || "not-requested", monthlyTotalSearches: item.monthlyTotalSearches ?? null,
          marketDiscoveryRank: marketItems.findIndex((candidate) => candidate.normalizedKeyword === key) + 1,
          selectedForProtectedSlot: protectedRanks.has(key), protectedSlotRank: protectedRanks.get(key) || null,
          trendStatus, trendWaitReason: trace?.trendWaitReason || null, trendFetchedAt: trendRecord?.fetchedAt || trace?.trendFetchedAt || null,
          selectedForAnalysis: Boolean(trace), lastTrendResult: trace ? { status: trace.searchTrendStatus, finalIncluded: trace.finalIncluded,
            resultType: trace.resultType, exclusionReason: trace.exclusionReason } : null };
      });
    return json(200, { ok: true, window: windowName, totalMarketDiscovery: marketItems.length, matchingCount: rows.length, items: rows });
  } catch (error) { return json(500, { error: `신규 발견 후보 조회 실패: ${error.message}` }); }
};

exports._test = { discoverySortScore, inWindow };
