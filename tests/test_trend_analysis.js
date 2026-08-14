const assert = require("node:assert/strict");
const { _test } = require("../netlify/functions/trend-analysis-background.js");

const ratios = Array.from({ length: 30 }, (_, index) => ({ period: `2026-08-${String(index + 1).padStart(2, "0")}`, ratio: index < 20 ? 1 : 10 }));
const estimated = _test.estimate(ratios, 120000);
assert.equal(Math.round(estimated.reduce((sum, point) => sum + point.estimated, 0)), 120000);
const period = _test.periodMetrics(estimated, "2026-08-01", "2026-08-30");
assert.ok(period.peakLift > 0);
assert.equal(period.surgeCount, Math.max(0, period.endLift, period.peakLift));
assert.equal(period.peakLift, period.peakDailyLift);
assert.ok(period.sustainedLift > 0);
assert.equal(period.surgeCount >= 500, true);
assert.equal(period.surgeCount >= 100000, false);
const instant = _test.instantMetrics(estimated);
assert.equal(instant.surgeCount, Math.max(0, instant.latest - instant.baseline));
const sparse = _test.estimate([{ period: "2026-08-10", ratio: 1.5 }], 2720, "2026-07-12");
const sparseInstant = _test.instantMetrics(sparse);
assert.equal(sparseInstant.baseline, 0);
assert.equal(sparseInstant.surgeCount, 2720);

const spikeSeries = Array.from({ length: 22 }, (_, index) => ({ period: `2026-05-${String(index + 8).padStart(2, "0")}`, estimated: index === 14 ? 1162.52 : 298.57, ratio: 1 }));
const spikePeriod = _test.periodMetrics(spikeSeries, "2026-05-15", "2026-05-29");
assert.equal(spikePeriod.peakDailyDate, "2026-05-22");
assert.equal(Math.round(spikePeriod.peakDailyLift), 864);
assert.equal(Math.round(spikePeriod.surgeCount), 864);

const products = [{ product: "메디힐 비타민씨 세럼", brand: "메디힐", account: "계정1" }];
const index = _test.buildIndex(products);
const match = _test.bestMatch("비타민씨 세럼", products, index);
assert.ok(match.score >= 60);

const diagnosticCandidates = [
  { keyword: "비타민씨 세럼", monthlyPcSearches: 1000, monthlyMobileSearches: 9000, monthlyTotalSearches: 10000, impressions30d: 200, clicks30d: 5, sources: ["searchad-query"], isNewSearchQuery: true, category: "beauty" },
  { keyword: "콜라겐", monthlyPcSearches: 2000, monthlyMobileSearches: 18000, monthlyTotalSearches: 20000, impressions30d: 0, clicks30d: 0, sources: ["keywordstool"], isNewSearchQuery: false, category: "health" }
];
const stats = _test.summaryStats(diagnosticCandidates);
assert.equal(stats.count, 2);
assert.equal(stats.averageMonthlySearches, 15000);
assert.equal(stats.medianSearchAdImpressions, 100);
assert.equal(stats.newSearchAdQueryRate, 0.5);
const diagnostic = _test.surgeDiagnostic(diagnosticCandidates[0], instant, estimated);
assert.equal(diagnostic.monthlyTotalSearches, 10000);
assert.equal(Math.round(diagnostic.ratioSum), 120);
assert.equal(diagnostic.ratios.length, 30);
assert.ok(_test.analysisPriority({ priorityScore: 50 }, { estimatedSurgeCount: 5000 }) > _test.analysisPriority({ priorityScore: 50 }, null));
const selectionPool = Array.from({ length: 6500 }, (_, index) => ({
  keyword: `candidate-${index}`, category: index % 2 ? "beauty" : "health", categoryEvidence: "keyword",
  monthlyTotalSearches: 500 + index, impressions30d: index, clicks30d: index % 7, impressionDelta: index % 9,
  isNewSearchQuery: index < 200, firstSeenAt: index < 1700 ? new Date().toISOString() : "2026-01-01T00:00:00.000Z",
  sources: index % 3 ? ["searchad-query"] : ["keywordstool"], priorityScore: index % 100
}));
const selectedCandidates = _test.selectAnalysisCandidates(selectionPool, new Map(), 5000);
assert.equal(selectedCandidates.selected.length, 5000);
assert.equal(selectedCandidates.excluded.length, 1500);
assert.ok(selectedCandidates.selected.filter((item) => _test.isRecentCandidate(item)).length >= 1500);
assert.equal(selectedCandidates.diagnostics.selectedByGroup.new, 1500);
assert.ok(selectedCandidates.diagnostics.multiGroupOverlap > 0 && selectedCandidates.diagnostics.multiGroupOverlap < 5000);
assert.ok(selectedCandidates.selected.some((item) => item.keyword === "candidate-6499"));
const protectionPool = Array.from({ length: 6000 }, (_, index) => ({ keyword: `protected-${index}`,
  monthlyTotalSearches: index ? 10000 + index : 500, priorityScore: index ? 100 : 0,
  firstSeenAt: "2026-01-01T00:00:00.000Z", categoryEvidence: index ? "keyword" : "unknown",
  impressionDelta: index ? 10 : 0, clicks30d: index ? 1 : 0, sources: ["keywordstool"] }));
const protectedSignals = new Map([["protected-0", { estimatedSurgeCount: 900, protectionPriority: 1000 }]]);
const protectedSelection = _test.selectAnalysisCandidates(protectionPool, protectedSignals, 5000);
assert.ok(protectedSelection.selected.some((item) => item.keyword === "protected-0"));

const snpeProducts = Array.from({ length: 13 }, (_, index) => ({
  product: `SNPE 교정 마사지 상품 ${index + 1}`, account: "account1", productId: `snpe-${index + 1}`
}));
const snpeIndex = _test.buildIndex(snpeProducts);
const snpeMatch = _test.bestMatch("SNPE", snpeProducts, snpeIndex);
assert.equal(snpeMatch.score, 38);
const snpeSignal = _test.buildBrandOrCategorySignal({ keyword: "SNPE", category: "beauty" }, snpeMatch, snpeProducts);
assert.equal(snpeSignal.signalType, "brand");
assert.equal(snpeSignal.relatedProductCount, 13);
assert.equal(snpeSignal.judgment, "브랜드 급등");
assert.equal(_test.buildBrandOrCategorySignal({ keyword: "크림", category: "beauty" }, _test.bestMatch("크림", snpeProducts, snpeIndex), snpeProducts), null);
assert.equal(_test.classifySurgeResult({ keyword: "SNPE", category: "beauty" }, snpeMatch, snpeProducts, 40).resultType, "brand_or_category_signal");
const lakaProducts = [{ product: "라카 퍼펙트 트윈 립 4.7g 10colors", account: "account1" }];
const lakaMatch = _test.bestMatch("라카트윈립", lakaProducts, _test.buildIndex(lakaProducts));
assert.equal(lakaMatch.score, 83);
assert.equal(_test.classifySurgeResult({ keyword: "라카트윈립", category: "beauty" }, lakaMatch, lakaProducts, 40).resultType, "product_match");
const pdrnProducts = [{ product: "메디힐 PDRN 모공 탄력 더마 크림 50ml", account: "account1" }];
const pdrnMatch = _test.bestMatch("PDRN", pdrnProducts, _test.buildIndex(pdrnProducts));
assert.equal(_test.classifySurgeResult({ keyword: "PDRN", category: "beauty" }, pdrnMatch, pdrnProducts, 40).resultType, "domain_related_signal");
const coffeeProducts = [{ product: "모모스커피 브루백 에스쇼콜라 7개입", account: "account2" }];
const coffeeMatch = _test.bestMatch("모모스커피", coffeeProducts, _test.buildIndex(coffeeProducts));
assert.equal(_test.classifySurgeResult({ keyword: "모모스커피", category: "beauty" }, coffeeMatch, coffeeProducts, 40).resultType, null);
console.log("Trend estimation, surge calculation, and indexed matching OK");
