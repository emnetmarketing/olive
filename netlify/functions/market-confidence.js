function bounded(value, min, max) { return Math.max(min, Math.min(max, Number(value || 0))); }
function grade(score) { return score >= 85 ? "very_strong" : score >= 70 ? "strong" : score >= 50 ? "medium" : "reference"; }

function calculateMarketConfidence(row, surgeThreshold) {
  let score = 15; const reasons = []; const components = { naver: 15, relevance: 0, youtube: 0, searchAd: 0, multiSource: 0, marketDiscovery: 0, shopping: 0, news: 0 };
  if (row.absoluteSurgePassed) components.naver += 8;
  if (row.relativeSurgePassed) components.naver += 7;
  if (Number(row.peakRelativeLiftPct || row.relativeRatioLift || 0) >= 100) components.naver += 3;
  if (row.estimatedSurgeCount != null && Number(row.estimatedSurgeCount) >= Math.max(1, Number(surgeThreshold || 0)) * 2) components.naver += 3;
  score = components.naver;
  reasons.push(row.absoluteSurgePassed && row.relativeSurgePassed ? "NAVER 절대·상대 급등 확인"
    : row.absoluteSurgePassed ? "NAVER 절대 급등 확인" : row.relativeSurgePassed ? "NAVER 상대 급등 확인" : "NAVER 상승 확인");

  const matchScore = bounded(row.match?.score, 0, 100);
  if (row.resultType === "product_match") { components.relevance = Math.round(14 + matchScore * 0.08); reasons.push(`상품 직접 매칭 ${Math.round(matchScore)}%`); }
  else if (row.resultType === "brand_or_category_signal") { components.relevance = 14; reasons.push("브랜드 직접 관련성 확인"); }
  else if (row.resultType === "domain_related_signal") { components.relevance = 10; reasons.push("제품라인·성분·제품군 관련성 확인"); }
  else if (row.resultType === "low_intensity_early_signal") { components.relevance = 12; reasons.push("브랜드·제품 선행 문맥 확인"); }
  else if (row.resultType === "ratio_only_market_signal") { components.relevance = 8; reasons.push("검증된 시장·상품 문맥 확인"); }
  score += components.relevance;

  const youtube = row.earlyMarketEvidence?.comparisons?.youtube;
  if (youtube && Number(youtube.delta || 0) > 0) { components.youtube = 8; reasons.push(`YouTube 언급 증가 +${Number(youtube.delta)}`); }
  else if (youtube && Number(youtube.current || 0) > 0) { components.youtube = 5; reasons.push(`YouTube 최근 언급 ${Number(youtube.current)}건`); }
  score += components.youtube;

  if (row.searchAdNewQuery) { components.searchAd = 8; reasons.push("Search Ad 신규 유입"); }
  else if (Number(row.searchAdImpressionDelta || 0) > 0) { components.searchAd = 6; reasons.push(`Search Ad 노출 증가 +${Number(row.searchAdImpressionDelta)}`); }
  else if (Number(row.searchAdClicks30d || 0) > 0) { components.searchAd = 4; reasons.push("Search Ad 클릭 유입 확인"); }
  score += components.searchAd;

  const sources = new Set((row.discoverySource || row.sources || []).filter((source) => !["market-discovery", "keywordstool"].includes(source)));
  if (sources.size >= 2) { components.multiSource = 8; reasons.push("복수 출처 발견"); score += 8; }
  if (Number(row.marketSourceConfidence || 0) >= 90) components.marketDiscovery = 5;
  else if (Number(row.marketSourceConfidence || 0) >= 75) components.marketDiscovery = 3;
  score += components.marketDiscovery;
  if (Number(row.shoppingRise || 0) > 0) { components.shopping = 4; reasons.push("Shopping Insight 상승"); score += 4; }
  if (Number(row.news?.total || 0) > 0) { components.news = 3; reasons.push("관련 뉴스 근거 확인"); score += 3; }
  score = Math.min(100, Math.round(score));
  return { marketConfidenceScore: score, marketConfidenceGrade: grade(score), marketConfidenceReasons: [...new Set(reasons)].slice(0, 5), marketConfidenceComponents: components };
}

module.exports = { calculateMarketConfidence, grade };
