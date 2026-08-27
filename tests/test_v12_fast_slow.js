const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { candidateTier, isDueForCollection } = require("../netlify/functions/trend-collection-policy");
const { compactItem } = require("../netlify/functions/signal-snapshot-cache");

test("new discovery and recent surge stay HOT while stable candidates rotate WARM/COLD", () => {
  const now = new Date("2026-08-26T00:00:00Z");
  assert.equal(candidateTier({ marketDiscovery: true }, null, now), "hot");
  assert.equal(candidateTier({}, { estimatedSurgeCount: 500 }, now), "hot");
  assert.equal(candidateTier({ relatedBrand: "브랜드", relatedProductType: "크림", firstSeenAt: "2026-08-10" }, null, now), "hot");
  assert.equal(candidateTier({ firstSeenAt: "2026-08-15", impressionDelta: 2 }, null, now), "warm");
  assert.equal(candidateTier({ firstSeenAt: "2026-01-01" }, null, now), "cold");
});

test("tier collection intervals are one, three and seven days", () => {
  const now = new Date("2026-08-26T00:00:00Z");
  assert.equal(isDueForCollection({ marketDiscovery: true }, null, { fetchedAt: "2026-08-24T00:00:00Z" }, now).due, true);
  assert.equal(isDueForCollection({ firstSeenAt: "2026-08-15", impressionDelta: 2 }, null, { fetchedAt: "2026-08-24T00:00:00Z" }, now).due, false);
  assert.equal(isDueForCollection({ firstSeenAt: "2026-01-01" }, null, { fetchedAt: "2026-08-20T00:00:00Z" }, now).due, false);
});

test("fast analysis cannot schedule external APIs and slow Shopping is deferred to result rows", () => {
  const start = fs.readFileSync("netlify/functions/trend-analysis-start.js", "utf8");
  const background = fs.readFileSync("netlify/functions/trend-analysis-background.js", "utf8");
  assert.match(start, /exports\.handler = \(event\) => handle\(event, \{ fastPath: true \}\)/);
  assert.match(background, /job\.fastPath \? \{ selected: \[\], pending: searchFetchQueue/);
  assert.match(background, /if \(!job\.fastPath && rows\.length\)/);
  assert.match(background, /const shoppingCandidates = rows\.map/);
  assert.match(background, /const newsResults = job\.fastPath \? \[\]/);
});

test("scheduled live collection is opt-in while the provider monthly quota is exhausted", () => {
  const scheduled = fs.readFileSync("netlify/functions/trend-data-collection-scheduled.js", "utf8");
  assert.match(scheduled, /ENABLE_SCHEDULED_TREND_COLLECTION/);
  assert.match(scheduled, /scheduled Trend collection is paused/);
});

test("same historical window is a cache hit and requires no fetch plan", () => {
  const cache = require("../netlify/functions/trend-series-cache");
  const analysis = require("../netlify/functions/trend-analysis-background")._test;
  const entries = new Map(); cache.upsert(entries, { keyword: "재사용", source: "search", startDate: "2026-08-01", endDate: "2026-08-24",
    series: [{ period: "2026-08-24", ratio: 100 }], fetchedAt: "2026-08-25T00:00:00Z" });
  const hit = cache.lookup(entries, "재사용", "search", "beauty", "2026-08-01", "2026-08-24", new Date("2026-08-27T00:00:00Z"));
  assert.equal(hit.state, "hit"); assert.equal(analysis.planTrendFetch([], { remaining: 100, dailyRemaining: 100 }).expectedCalls, 0);
});

test("signal snapshot preserves operational fields without changing calculation meaning", () => {
  const item = compactItem({ keyword: "테스트", resultType: "product_match", estimatedSurgeCount: 300,
    peakDailyLift: 300, peakRelativeLiftPct: 50, match: { score: 83, item: { brand: "브랜드", product: "상품" } },
    shoppingRise: 10, candidateTier: "hot", latestDataDate: "2026-08-24" });
  assert.equal(item.estimatedSurgeCount, 300); assert.equal(item.productMatchScore, 83); assert.equal(item.candidateTier, "hot");
});

test("dashboard separates cached analysis from administrator data collection", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /저장된 최신 데이터로 빠른 분석/);
  assert.match(html, /latestDataCollectionBtn/);
  assert.match(html, /trend-data-collection-start/);
  assert.match(html, /HOT\/WARM\/COLD/);
});
