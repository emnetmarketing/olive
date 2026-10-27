const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm");
const { projectStoredResultConfidence, projectStoredPeriodResult } = require("../netlify/functions/search-ad-observation");
const { resultRow, periodResultRow } = require("../netlify/functions/unified-excel");
const { extractFunction } = require("../scripts/verify-deployed-period-display.cjs");
const html = fs.readFileSync("index.html", "utf8");
function ui() {
  const context = vm.createContext({});
  for (const name of ["escapeHtml", "storedInstantConfidenceDisplay", "storedPeriodConfidenceDisplay", "periodSourceEvidence", "marketConfidenceSummary"])
    vm.runInContext(extractFunction(html, name), context);
  return context;
}
const base = () => ({ keyword: "stored", latestDataDate: "2026-10-25", marketConfidenceScore: 66,
  marketConfidenceGrade: "medium", estimatedSurgeCount: 7031, marketConfidenceReasons: ["NAVER 급등 확인", "Search Ad 노출 증가 +300"] });
test("legacy Instant confidence display removes unproved growth without changing raw score, rows or hash", () => {
  const row = { ...base(), searchAdImpressionDelta: 300 }, before = JSON.stringify(row);
  const projected = projectStoredResultConfidence(row), context = ui();
  assert.equal(JSON.stringify(context.storedInstantConfidenceDisplay(row).reasons), JSON.stringify(projected.reasons));
  const rendered = context.marketConfidenceSummary(row), excel = resultRow(row);
  for (const value of [rendered, excel.confidenceReasons]) {
    assert.doesNotMatch(value, /노출 증가 \+300/); assert.match(value, /이전 비교 근거 확인 불가/); assert.match(value, /점수 재계산 안 됨/);
  }
  assert.match(rendered, /66\/100/); assert.equal(excel.confidenceScore, 66);
  assert.equal(excel.estimatedSurgeCount, 7031); assert.match(excel.searchAdEvidence, /비교 불가/);
  assert.equal(JSON.stringify(row), before);
});

test("legacy acquisition labels mean discovery or observation, not measured increase", () => {
  const row = { ...base(), marketConfidenceReasons: ["Search Ad 신규 유입", "Search Ad 클릭 유입 확인"] };
  const expected = projectStoredResultConfidence(row);
  assert.match(expected.reasons[0], /신규 발견/); assert.match(expected.reasons[1], /저장 클릭 관측/);
  assert.equal(JSON.stringify(ui().storedInstantConfidenceDisplay(row).reasons), JSON.stringify(expected.reasons));
  assert.equal(resultRow(row).confidenceScore, row.marketConfidenceScore);
});

test("legacy Period zero baseline and several publication dates do not prove previous observation", () => {
  const row = { ...base(), periodMarketConfidenceScore: 66, periodMarketConfidenceReasons: ["Search Ad 노출 증가 +300", "Search Ad 신규 유입"],
    periodMarketEvidence: { observedDates: ["2026-10-01", "2026-10-02"], searchAd: { current: 300, previous: 0, delta: 300,
      currentClicks: 4, previousClicks: 0, clickDelta: 4, newQuery: true, availability: "partial" } } };
  const before = JSON.stringify(row), display = projectStoredPeriodResult(row), client = ui().storedPeriodConfidenceDisplay(row);
  assert.equal(display.searchAd.delta, null); assert.equal(display.searchAd.previous, null); assert.equal(display.searchAd.clickDelta, null);
  assert.equal(JSON.stringify(client.reasons), JSON.stringify(display.reasons)); assert.equal(client.searchAd.delta, null);
  assert.equal(client.scoreWarning, display.scoreWarning); assert.ok(display.scoreWarning);
  const excel = periodResultRow(row, { startDate: "2026-10-01", endDate: "2026-10-16" });
  assert.equal(excel.searchAdImpressionDelta, null); assert.equal(excel.searchAdClickDelta, null); assert.equal(excel.confidenceScore, 66);
  assert.match(excel.dataStatus, /비교 불가/); assert.match(excel.confidenceReasons, /신규 발견/);
  assert.match(ui().periodSourceEvidence(client.searchAd, "Search Ad"), /비교 불가/);
  assert.equal(JSON.stringify(row), before);
});

test("Period actual source timestamp pair retains measured deltas and existing score", () => {
  const row = { ...base(), periodMarketConfidenceScore: 66, periodMarketConfidenceReasons: ["Search Ad 노출 증가 +300"],
    periodMarketEvidence: { searchAd: { observedAt: "2026-10-25T01:00:00Z", previousObservedAt: "2026-10-24T01:00:00Z",
      current: 500, previous: 200, currentClicks: 6, previousClicks: 2, availability: "partial" } } };
  const display = projectStoredPeriodResult(row), client = ui().storedPeriodConfidenceDisplay(row), excel = periodResultRow(row, {});
  assert.equal(display.searchAd.delta, 300); assert.equal(client.searchAd.delta, 300); assert.equal(excel.searchAdImpressionDelta, 300);
  assert.equal(excel.searchAdClickDelta, 4); assert.equal(display.scoreWarning, null); assert.equal(excel.confidenceScore, 66);
  assert.deepEqual(display.reasons, row.periodMarketConfidenceReasons);
});
test("proven saved Search Ad observations retain their existing reasons and score", () => {
  const row = { ...base(), searchAdObservation: { observedAt: "2026-10-25T01:00:00Z", previousObservedAt: "2026-10-24T01:00:00Z", current: 500, previous: 200 } };
  const projected = projectStoredResultConfidence(row), context = ui();
  assert.deepEqual(projected.reasons, row.marketConfidenceReasons); assert.equal(projected.scoreWarning, null);
  assert.equal(JSON.stringify(context.storedInstantConfidenceDisplay(row).reasons), JSON.stringify(projected.reasons));
  assert.equal(context.storedInstantConfidenceDisplay(row).scoreWarning, null);
  assert.match(resultRow(row).searchAdEvidence, /노출 Δ 300/);
});
test("new source, absent dates, false comparability and click-only growth cannot validate an impression increase", () => {
  const proven = { observedAt: "2026-10-25", previousObservedAt: "2026-10-24", current: 200, previous: 100 };
  for (const source of [{ ...proven, previousObservedAt: null }, { ...proven, isNewlyObserved: true },
    { ...proven, previousObservationAvailable: false }, { ...proven, current: 100, currentClicks: 20, previousClicks: 2 }]) {
    const row = { ...base(), searchAdObservation: source }, projected = projectStoredResultConfidence(row);
    assert.equal(projected.unverifiedIncrease, true); assert.ok(ui().storedInstantConfidenceDisplay(row).scoreWarning);
  }
});
test("unrelated legacy reasons are unchanged and TOP10 preserves the proof needed by the display projection", () => {
  const row = { ...base(), marketConfidenceReasons: ["상품 직접 매칭 87%", "Search Ad 신규 발견 · 저장 광고 관측 참고"] };
  assert.deepEqual(projectStoredResultConfidence(row).reasons, row.marketConfidenceReasons);
  assert.equal(projectStoredResultConfidence(row).scoreWarning, null);
  const chart = extractFunction(html, "renderTrendChart");
  assert.match(chart, /searchAdObservation: row.searchAdObservation/);
  assert.match(chart, /earlyMarketEvidence: row.earlyMarketEvidence/);
  assert.doesNotMatch(extractFunction(html, "storedInstantConfidenceDisplay"), /fetch\s*\(/);
});
