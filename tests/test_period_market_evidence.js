const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ExcelJS = require("exceljs");
const { buildPeriodMarketEvidence, calculatePeriodMarketConfidence } = require("../netlify/functions/period-market-evidence");
const { calculateMarketConfidence } = require("../netlify/functions/market-confidence");
const { toBuffer } = require("../netlify/functions/unified-excel");

const history = [
  { normalizedKeyword: "라카트윈립", earlySignalDate: "2026-08-30", detectedAt: "2026-08-30T06:00:00Z", firstSeenAt: "2026-08-30T01:00:00Z",
    sources: ["youtube", "searchad-new-query"], comparisons: { youtube: { current: 3, previous: 1 }, searchAd: { current: 70, previous: 40, currentClicks: 7, previousClicks: 4 } } },
  { normalizedKeyword: "라카트윈립", earlySignalDate: "2026-09-01", detectedAt: "2026-09-01T06:00:00Z", firstSeenAt: "2026-08-30T01:00:00Z",
    sources: ["youtube", "searchad-new-query"], comparisons: { youtube: { current: 4, previous: 2 }, searchAd: { current: 100, previous: 70, currentClicks: 11, previousClicks: 7 } } },
  { normalizedKeyword: "라카트윈립", earlySignalDate: "2026-09-04", detectedAt: "2026-09-04T06:00:00Z",
    sources: ["youtube"], comparisons: { youtube: { current: 99, previous: 0 }, searchAd: { current: 999, previous: 1 } } }
];

function result(evidence) { return { keyword: "라카트윈립", absoluteSurgePassed: true, relativeSurgePassed: true, peakRelativeLiftPct: 120,
  estimatedSurgeCount: 1200, resultType: "product_match", match: { score: 85, item: { product: "라카 트윈 립", brand: "라카" } },
  relatedSignal: { relatedBrand: "라카", relatedProductContext: "립" }, latestDataDate: "2026-09-01", periodMarketEvidence: evidence }; }

test("period YouTube and Search Ad evidence uses only stored observations inside the selected dates", () => {
  const evidence = buildPeriodMarketEvidence("라카트윈립", "2026-08-30", "2026-09-01", history);
  assert.equal(evidence.youtube.current, 7); assert.equal(evidence.youtube.previous, 3); assert.equal(evidence.youtube.delta, 4);
  assert.equal(evidence.searchAd.current, 100); assert.equal(evidence.searchAd.previous, 40); assert.equal(evidence.searchAd.delta, 60); assert.equal(evidence.searchAd.clickDelta, 7);
  assert.equal(evidence.searchAd.newQuery, true); assert.ok(!evidence.observedDates.includes("2026-09-04"));
});

test("missing history remains null and is described as unavailable rather than zero", () => {
  const evidence = buildPeriodMarketEvidence("없는키워드", "2026-08-30", "2026-09-01", history);
  assert.equal(evidence.youtube.current, null); assert.equal(evidence.youtube.delta, null); assert.equal(evidence.searchAd.delta, null);
  assert.equal(evidence.dataAvailability, "no_data"); assert.match(evidence.dataGaps.join(" "), /데이터 없음/);
});

test("period confidence uses period evidence while NAVER surge values remain untouched", () => {
  const evidence = buildPeriodMarketEvidence("라카트윈립", "2026-08-30", "2026-09-01", history); const row = result(evidence);
  const before = { estimatedSurgeCount: row.estimatedSurgeCount, peakRelativeLiftPct: row.peakRelativeLiftPct };
  const confidence = calculatePeriodMarketConfidence(row, evidence, 500);
  assert.ok(confidence.periodMarketConfidenceScore > 0); assert.match(confidence.periodMarketConfidenceReasons.join(" "), /YouTube|Search Ad/);
  assert.deepEqual({ estimatedSurgeCount: row.estimatedSurgeCount, peakRelativeLiftPct: row.peakRelativeLiftPct }, before);
});

test("a stored click-only increase is the lowest Search Ad confidence evidence without double counting", () => {
  const evidence = buildPeriodMarketEvidence("라카트윈립", "2026-08-30", "2026-09-01", history);
  evidence.searchAd.newQuery = false; evidence.searchAd.delta = 0; evidence.searchAd.clickDelta = 7;
  const confidence = calculatePeriodMarketConfidence(result(evidence), evidence, 500);
  assert.equal(confidence.periodMarketConfidenceComponents.searchAd, 4);
  assert.match(confidence.periodMarketConfidenceReasons.join(" "), /클릭 증가 \+7/);
});

test("instant confidence calculator remains independent", () => {
  const instant = calculateMarketConfidence({ ...result(null), earlyMarketEvidence: null, searchAdNewQuery: false, searchAdImpressionDelta: 0,
    searchAdClicks30d: 0, discoverySource: [], marketSourceConfidence: 0, shoppingRise: null, news: null }, 500);
  assert.equal(instant.marketConfidenceComponents.youtube, 0); assert.equal(instant.marketConfidenceComponents.searchAd, 0);
});

test("period Excel exports actual evidence and blanks unavailable click delta", async () => {
  const evidence = buildPeriodMarketEvidence("라카트윈립", "2026-08-30", "2026-09-01", history);
  const row = { ...result(evidence), ...calculatePeriodMarketConfidence(result(evidence), evidence, 500) };
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await toBuffer({ generatedAt: "2026-09-04T00:00:00Z", instantJob: { results: [] }, early: { items: [] }, discoveries: [],
    periodRequest: { startDate: "2026-08-30", endDate: "2026-09-01" }, periodJob: { jobId: "p", startDate: "2026-08-30", endDate: "2026-09-01", results: [row] } }));
  const sheet = book.getWorksheet("07_선택기간분석"); const headers = sheet.getRow(11).values; const values = sheet.getRow(12).values;
  const value = (name) => values[headers.indexOf(name)];
  assert.equal(value("YouTube delta"), 4); assert.equal(value("Search Ad 노출 delta"), 60); assert.equal(value("Search Ad 클릭 delta"), 7);
  assert.match(String(value("데이터 부족 상태")), /일부 기간/);
});

test("period enrichment is cache-only and cannot call external APIs", () => {
  const source = fs.readFileSync("netlify/functions/period-market-evidence.js", "utf8");
  assert.doesNotMatch(source, /fetch\(|api\.youtube|searchad\.naver|naverapihub/);
  const background = fs.readFileSync("netlify/functions/trend-analysis-background.js", "utf8");
  assert.match(background, /job\.mode === "period"/); assert.match(background, /loadedEarlyCache\?\.history/);
});
