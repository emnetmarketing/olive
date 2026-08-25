const { connect, readCache, readYoutubeSnapshot } = require("./market-discovery-cache");
const { readCandidateCache } = require("./keyword-candidate-cache");
const { readCache: readProductCache } = require("./search-ad-cache");
const { readDiagnosticIndex, readLastSuccess } = require("./trend-analysis-cache");
const { normalizedKeyword, discoveryPriority } = require("./market-discovery-core");
const { buildProductIndex, findBestMatch } = require("./product-matching");

const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
function isRatioEligible(item) { return item?.monthlySearchStatus === "keywordtool-unavailable" && Number(item.sourceConfidence || 0) >= 75
  && ((item.discoverySource || []).length > 1 || item.discoverySource?.includes("searchad-new-query") || item.relatedBrand && (item.relatedProductType || item.relatedProductLine)); }
function protectedSelection(items, limit = 500) {
  const numeric = (items || []).filter((item) => item.monthlySearchStatus === "available" && Number(item.monthlyTotalSearches || 0) >= 40)
    .sort((a, b) => discoveryPriority(b) - discoveryPriority(a));
  const ratio = (items || []).filter(isRatioEligible).sort((a, b) => discoveryPriority(b) - discoveryPriority(a));
  const output = []; const keys = new Set();
  for (const item of [...numeric, ...ratio]) { if (output.length >= limit) break; if (keys.has(item.normalizedKeyword)) continue; keys.add(item.normalizedKeyword); output.push(item); }
  return output;
}
function safeMatch(match) { if (!match) return null; return { product: match.item?.product || null, productId: match.item?.productId || match.item?.id || null,
  score: match.score, judgment: match.judgment, reason: match.reason, matchingCandidateCount: match.matchingCandidateCount }; }

exports.handler = async (event) => {
  connect(event); if (event.httpMethod !== "GET") return json(405, { error: "GET 요청만 허용됩니다." });
  const keyword = String(event.queryStringParameters?.keyword || "").trim(); if (!keyword) return json(400, { error: "keyword가 필요합니다." });
  try {
    const [market, candidateCache, productCache, analysisIndex, lastSuccess, youtubeSnapshot] = await Promise.all([
      readCache(), readCandidateCache(), readProductCache(), readDiagnosticIndex(), readLastSuccess("latest"), readYoutubeSnapshot()
    ]);
    const key = normalizedKeyword(keyword); const marketItems = market?.items || []; const protectedItems = protectedSelection(marketItems);
    const item = marketItems.find((entry) => entry.normalizedKeyword === key) || null;
    const existingCandidate = (candidateCache?.candidates || []).find((entry) => normalizedKeyword(entry.keyword) === key) || null;
    const trace = (analysisIndex?.items || []).find((entry) => entry.normalizedKeyword === key) || null;
    const finalResult = (lastSuccess?.results || []).find((entry) => normalizedKeyword(entry.keyword) === key) || null;
    const marketRank = item ? marketItems.findIndex((entry) => entry.normalizedKeyword === key) + 1 : null;
    const protectedRank = protectedItems.findIndex((entry) => entry.normalizedKeyword === key) + 1;
    const textKey = normalizedKeyword(keyword); const youtubeMatches = (youtubeSnapshot?.items || []).filter((video) => {
      const contentKey = normalizedKeyword(`${video.title || ""} ${video.description || ""}`); const titleKey = normalizedKeyword(video.title || "");
      return textKey.length >= 2 && (contentKey.includes(textKey) || titleKey.length >= 3 && textKey.includes(titleKey));
    }).slice(0, 20);
    const match = productCache?.items?.length ? findBestMatch(keyword, productCache.items, buildProductIndex(productCache.items)) : null;
    let exclusionReason = null;
    if (!item && !existingCandidate) exclusionReason = "marketDiscovery와 기존 후보 캐시에 없음";
    else if (item && protectedRank < 1 && !existingCandidate) exclusionReason = item.monthlySearchStatus === "not-requested" ? "keywordstool 미조회로 monthly-search/ratio-only 유형 미확정"
      : item.monthlySearchStatus === "keywordtool-unavailable" && !isRatioEligible(item) ? "ratio-only 관련성·신뢰도 조건 미달" : "marketDiscovery 500 보호 슬롯 순위 밖";
    else if (!trace) exclusionReason = "마지막 성공 분석의 5,000개 대상에 포함되지 않음";
    else exclusionReason = trace.exclusionReason;
    return json(200, { keyword, normalizedKeyword: key, exists: Boolean(item), existingCandidateExists: Boolean(existingCandidate),
      discoverySource: item?.discoverySource || [], discoveredAt: item?.discoveredAt || null, lastSeenAt: item?.lastSeenAt || null,
      sourceConfidence: item?.sourceConfidence ?? null, evidence: item?.evidence || [], youtubeEvidence: item?.youtubeEvidence || [],
      productEvidence: item?.productEvidence || [], searchAdEvidence: item?.searchAdEvidence || null,
      relatedBrand: item?.relatedBrand || null, relatedProductType: item?.relatedProductType || null, relatedProductLine: item?.relatedProductLine || null,
      monthlySearchStatus: item?.monthlySearchStatus || existingCandidate?.monthlyVolumeStatus || null,
      monthlyTotalSearches: item?.monthlyTotalSearches ?? existingCandidate?.monthlyTotalSearches ?? null,
      keywordtoolCheckedAt: item?.keywordtoolCheckedAt || null, marketDiscoveryRank: marketRank,
      selectedForProtectedSlot: protectedRank > 0, protectedSlotRank: protectedRank > 0 ? protectedRank : null,
      selectedForAnalysis: Boolean(trace), analysis: trace, finalResult: finalResult ? { resultType: finalResult.resultType,
        estimatedSurgeCount: finalResult.estimatedSurgeCount, peakDailyLift: finalResult.peakDailyLift,
        peakRelativeLiftPct: finalResult.peakRelativeLiftPct, relativeRatioLift: finalResult.relativeRatioLift } : null,
      productMatch: safeMatch(match), youtubeRawMatches: youtubeMatches.map((video) => ({ videoId: video.videoId, channelTitle: video.channelTitle,
        title: video.title, publishedAt: video.publishedAt, sourceQuery: video.sourceQuery })), exclusionReason });
  } catch (error) { return json(500, { error: `시장 후보 진단 실패: ${error.message}` }); }
};

exports._test = { isRatioEligible, protectedSelection };
