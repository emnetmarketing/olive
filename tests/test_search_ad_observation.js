const test = require("node:test");
const assert = require("node:assert/strict");
const { previousCandidateObservation, normalizeSearchAdObservation, sanitizeSearchAdEvidence } = require("../netlify/functions/search-ad-observation");
const { buildEarlySignals, projectStoredSignal, projectCache } = require("../netlify/functions/today-early-signal-cache");
const { calculateMarketConfidence } = require("../netlify/functions/market-confidence");
const { buildPeriodMarketEvidence } = require("../netlify/functions/period-market-evidence");
const { mergeCandidates } = require("../netlify/functions/market-discovery-core");
const now = "2026-10-27T00:00:00.000Z", before = "2026-10-26T00:00:00.000Z";
const measured = overrides => ({ observedAt: now, previousObservedAt: before, recentImpressions: 80, previousImpressions: 20,
  recentClicks: 8, previousClicks: 3, previousObservationAvailable: true, ...overrides });
const market = search => ({ keyword: "테스트크림", normalizedKeyword: "테스트크림", discoverySource: ["searchad-new-query"],
  discoveredAt: now, lastSeenAt: now, relatedBrand: "테스트", relatedProductType: "크림", searchAdEvidence: search });

test("missing previous candidate is null, never a measured zero", () => {
  assert.deepEqual(previousCandidateObservation(null, now), { previousImpressions30d: null, previousClicks30d: null,
    previousSearchAdObservedAt: null, previousSearchAdObservationAvailable: false });
  assert.equal(previousCandidateObservation({ sources: ["keywordstool"], lastSeenAt: before, impressions30d: 0, clicks30d: 0 }, now).previousImpressions30d, null);
});
test("a genuine prior zero with its source time remains a valid observation", () => {
  const previous = previousCandidateObservation({ sources: ["searchad-query"], lastSeenAt: before, impressions30d: 0, clicks30d: 0 }, now);
  const result = normalizeSearchAdObservation({ ...previous, searchAdObservedAt: now, impressions30d: 30, clicks30d: 2 });
  assert.equal(result.previous, 0); assert.equal(result.delta, 30); assert.equal(result.deltaRate, null);
  assert.equal(result.comparisonStatus, "comparable");
});
test("null and absent values cannot become zero through Number conversion", () => {
  const result = normalizeSearchAdObservation(measured({ previousImpressions: null, previousClicks: null, recentImpressions: null }));
  assert.equal(result.current, null); assert.equal(result.previous, null); assert.equal(result.delta, null);
  assert.equal(result.previousClicks, null); assert.equal(result.clickDelta, null);
});
test("legacy new-query zero without measured baseline is incomparable", () => {
  const result = normalizeSearchAdObservation({ firstSeenAt: now, lastSeenAt: now, recentImpressions: 100,
    previousImpressions: 0, recentClicks: 5, previousClicks: 0 });
  assert.equal(result.isNewlyObserved, true); assert.equal(result.previous, null); assert.equal(result.delta, null);
  assert.equal(result.comparisonStatus, "unavailable");
  assert.equal(normalizeSearchAdObservation({ observedAt: now, recentImpressions: 100, previousImpressions: 20 }).delta, null);
});
test("same or future observation time does not establish an earlier measurement", () => {
  assert.equal(normalizeSearchAdObservation(measured({ previousObservedAt: now })).delta, null);
  assert.equal(normalizeSearchAdObservation(measured({ previousObservedAt: "2026-10-28T00:00:00Z" })).delta, null);
});
test("new discovery does not receive invented increase points", () => {
  const base = { firstSeenAt: now, observedAt: now, isNewlyObserved: true, recentImpressions: 100, recentClicks: 5 };
  const missing = buildEarlySignals([market(base)], { items: [] }, now, { requireFreshSource: true })[0];
  const fakeZero = buildEarlySignals([market({ ...base, previousImpressions: 0, previousClicks: 0 })], { items: [] }, now, { requireFreshSource: true })[0];
  assert.equal(fakeZero.todayEarlySignalScore, missing.todayEarlySignalScore);
  assert.equal(fakeZero.comparisons.searchAd.delta, null);
  assert.match(fakeZero.reasons.join(" "), /신규 발견/);
  assert.doesNotMatch(fakeZero.reasons.join(" "), /노출 \+|노출 증가/);
});
test("measured stored-observation change retains increase credit with honest period label", () => {
  const row = buildEarlySignals([market(measured())], { items: [] }, now, { requireFreshSource: true })[0];
  assert.equal(row.comparisons.searchAd.delta, 60);
  assert.equal(row.comparisons.searchAd.previousObservedAt, before);
  assert.match(row.reasons.join(" "), /이전 저장 관측 대비 Search Ad 노출 \+60/);
  assert.match(row.reasons.join(" "), /집계기간 미확인/);
});
test("existing cache read projection preserves saved score/order and never mutates raw rows", () => {
  const row = { keyword: "테스트크림", normalizedKeyword: "테스트크림", earlySignalDate: "2026-10-27", todayEarlySignalScore: 75,
    reasons: ["Search Ad 신규 유입", "최근 수집 대비 Search Ad 노출 +100"], comparisons: {
      searchAd: { current: 100, previous: 0, delta: 100, previousClicks: 0, currentClicks: 5, clickDelta: 5, observedAt: now } } };
  const raw = { items: [row], history: [row] }, original = JSON.stringify(raw), result = projectCache(raw);
  assert.equal(JSON.stringify(raw), original);
  assert.equal(result.items[0].todayEarlySignalScore, 75);
  assert.equal(result.items[0].comparisons.searchAd.previous, null);
  assert.equal(result.items[0].scoreVerificationStatus, "legacy_unverified_comparison");
  assert.match(result.items[0].scoreWarning, /재계산 안 됨/);
  assert.doesNotMatch(result.items[0].reasons.join(" "), /노출 \+100/);
  assert.equal(result.items[0].keyword, row.keyword);
});
test("projection is idempotent and real comparisons need no legacy warning", () => {
  const row = { comparisons: { searchAd: measured() }, reasons: [], todayEarlySignalScore: 50 };
  const projected = projectStoredSignal(row);
  assert.equal(projected.scoreWarning, undefined); assert.equal(projected.comparisons.searchAd.delta, 60);
  assert.deepEqual(projectStoredSignal(projected), projected);
});
test("Discovery merge sanitizes legacy observations and preserves unverified expression separately", () => {
  const old = market({ firstSeenAt: now, lastSeenAt: now, recentImpressions: 100, previousImpressions: 0 });
  const merged = mergeCandidates([old], [], now)[0];
  assert.equal(merged.searchAdEvidence.previousImpressions, null);
  assert.equal(merged.relatedBrand, ''); assert.equal(merged.relatedExpression, old.relatedBrand);
  assert.equal(merged.brandContextStatus, 'unverified'); assert.equal(old.searchAdEvidence.previousImpressions, 0);
  assert.equal(sanitizeSearchAdEvidence(measured()).delta, 60);
});
test("confidence requires measured increase but leaves NAVER metrics and new-discovery credit unchanged", () => {
  const base = { estimatedSurgeCount: 700, peakRelativeLiftPct: 120, absoluteSurgePassed: true, relativeSurgePassed: true,
    resultType: "product_match", match: { score: 80 }, searchAdImpressionDelta: 100, searchAdClicks30d: 0 };
  const beforeRow = JSON.stringify(base);
  assert.equal(calculateMarketConfidence(base, 300).marketConfidenceComponents.searchAd, 0);
  assert.equal(calculateMarketConfidence({ ...base, searchAdObservation: measured() }, 300).marketConfidenceComponents.searchAd, 6);
  assert.equal(calculateMarketConfidence({ ...base, searchAdNewQuery: true }, 300).marketConfidenceComponents.searchAd, 8);
  assert.equal(JSON.stringify(base), beforeRow);
});
test("market analysis metadata does not re-coerce an unavailable prior value to zero", () => {
  const { marketCandidateForAnalysis } = require("../netlify/functions/trend-analysis-background")._test;
  const item = { ...market({ observedAt: now, recentImpressions: 100, previousImpressions: null }),
    monthlyTotalSearches: 7000, monthlySearchStatus: "available" };
  const candidate = marketCandidateForAnalysis(item);
  assert.equal(candidate.confidenceImpressionDelta, null);
  assert.equal(candidate.searchAdObservation.delta, null);
  assert.equal(candidate.monthlyTotalSearches, 7000);
  assert.equal(candidate.impressionDelta, 100, "Existing candidate selection policy is outside this confidence correction");
});
test("period evidence compares two actual source observations but not repeated publication of one observation", () => {
  const record = (date, current) => ({ normalizedKeyword: "테스트", earlySignalDate: date.slice(0, 10), detectedAt: date,
    firstSeenAt: before, sources: ["searchad-new-query"], comparisons: { searchAd: { observedAt: date, current, previous: 0, currentClicks: current / 10, previousClicks: 0 } } });
  const one = record(before, 70), two = record(now, 100);
  const result = buildPeriodMarketEvidence("테스트", "2026-10-26", "2026-10-27", [one, two]);
  assert.equal(result.searchAd.previous, 70); assert.equal(result.searchAd.current, 100); assert.equal(result.searchAd.delta, 30);
  assert.equal(result.searchAd.clickDelta, 3);
  const repeat = { ...one, earlySignalDate: "2026-10-27", detectedAt: now };
  assert.equal(buildPeriodMarketEvidence("테스트", "2026-10-26", "2026-10-27", [one, repeat]).searchAd.delta, null);
});
