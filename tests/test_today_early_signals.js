const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { buildEarlySignals, mergeCache, confirmSignals } = require("../netlify/functions/today-early-signal-cache");

const now = "2026-09-02T04:00:00.000Z";
function marketItem(overrides = {}) { return { keyword: "테스트쿠션", normalizedKeyword: "테스트쿠션", discoverySource: ["youtube"], discoveredAt: "2026-09-02T01:00:00.000Z",
  lastSeenAt: now, sourceConfidence: 80, relatedBrand: "테스트", relatedProductType: "쿠션",
  youtubeEvidence: [{ publishedAt: "2026-09-02T02:00:00.000Z" }], ...overrides }; }

test("today Early Signal detects actual recent YouTube evidence and classifies strength", () => {
  const rows = buildEarlySignals([marketItem()], { items: [] }, now);
  assert.equal(rows.length, 1); assert.equal(rows[0].comparisons.youtube.current, 1);
  assert.equal(rows[0].comparisons.youtube.previous, 0); assert.equal(rows[0].comparisons.youtube.deltaRate, null);
  assert.ok(["strong", "rising", "watch"].includes(rows[0].strength));
});

test("repeated and multi-source evidence raises score and preserves real deltas", () => {
  const rows = buildEarlySignals([marketItem({ discoverySource: ["youtube", "searchad-new-query"],
    youtubeEvidence: [{ publishedAt: "2026-09-02T02:00:00.000Z" }, { publishedAt: "2026-09-02T03:00:00.000Z" }, { publishedAt: "2026-09-01T21:00:00.000Z" }],
    searchAdEvidence: { recentImpressions: 80, previousImpressions: 20 } })], { items: [] }, now);
  assert.equal(rows[0].comparisons.youtube.delta, 1); assert.equal(rows[0].comparisons.searchAd.delta, 60);
  assert.ok(rows[0].todayEarlySignalScore >= 70); assert.match(rows[0].reasons.join(" "), /복수 source/);
});

test("product-only discovery and missing source values do not fabricate temporal deltas", () => {
  assert.equal(buildEarlySignals([marketItem({ discoverySource: ["product-cache"], youtubeEvidence: [] })], { items: [] }, now).length, 0);
  const row = buildEarlySignals([marketItem({ discoverySource: ["searchad-new-query"], youtubeEvidence: [], searchAdEvidence: { recentImpressions: 3 } })], { items: [] }, now)[0];
  assert.equal(row.comparisons.searchAd.previous, null); assert.equal(row.comparisons.searchAd.delta, null); assert.equal(row.comparisons.searchAd.deltaRate, null);
});

test("signals are deduplicated, retained in history and confirmed by next NAVER date", () => {
  const signals = buildEarlySignals([marketItem(), marketItem()], { items: [] }, now); assert.equal(signals.length, 1);
  const cache = mergeCache(null, signals, now); assert.equal(cache.history.length, 1);
  const confirmed = confirmSignals(cache, [{ normalizedKeyword: "테스트쿠션", searchTrendStatus: "valid" }],
    [{ keyword: "테스트쿠션", estimatedSurgeCount: 410, peakRelativeLiftPct: 70, resultType: "product_match" }], "2026-09-03");
  assert.equal(confirmed.history[0].confirmation.naverConfirmed, true); assert.equal(confirmed.history[0].confirmation.confirmedSurge, 410);
});

test("UI separates today's unconfirmed signals from yesterday's NAVER-confirmed results", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /오늘 급상승 신호/); assert.match(html, /NAVER 당일 검색 급등 확정 결과는 아닙니다/);
  assert.match(html, /어제 급등 확인/); assert.match(html, /NAVER 데이터 기준/); assert.match(html, /today-early-signals/);
});

test("Early Signal adds no NAVER collection schedule or external call", () => {
  const moduleText = fs.readFileSync("netlify/functions/today-early-signal-cache.js", "utf8");
  const config = fs.readFileSync("netlify.toml", "utf8");
  assert.doesNotMatch(moduleText, /fetch\s*\(/); assert.match(config, /market-discovery-scheduled[\s\S]*0 \*\/6 \* \* \*/);
});
