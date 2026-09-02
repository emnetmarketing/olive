const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const quota = require("../netlify/functions/trend-api-quota");
const history = require("../netlify/functions/market-discovery-history-cache");
const trend = require("../netlify/functions/trend-analysis-background")._test;

test("bootstrap accelerates cache recovery without exceeding daily or operating monthly budgets", () => {
  const usage = { daily: { searchTrend: 0 }, monthly: { searchTrend: 1332 } };
  const now = new Date("2026-09-02T01:00:00Z");
  const normal = quota.statusFor(usage, "searchTrend", 0, now);
  const bootstrap = quota.statusFor(usage, "searchTrend", 0, now, { bootstrap: true });
  assert.equal(bootstrap.budgetMode, "bootstrap");
  assert.ok(bootstrap.dailyLimit > normal.dailyLimit);
  assert.equal(bootstrap.dailyLimit, 1000);
  const nearTarget = quota.statusFor({ daily: {}, monthly: { searchTrend: 19950 } }, "searchTrend", 0, now, { bootstrap: true });
  assert.equal(nearTarget.dailyLimit, 50);
});

test("new market candidates outrank cold candidates for Trend collection", () => {
  const fresh = { keyword: "신규", marketDiscovery: true, sources: ["market-discovery", "youtube"], firstSeenAt: new Date().toISOString() };
  const cold = { keyword: "기존", sources: [], firstSeenAt: "2025-01-01" };
  assert.ok(trend.trendFetchPriority(fresh, new Map()) > trend.trendFetchPriority(cold, new Map()));
});

test("inactive candidate history is retained and restored on reappearance", () => {
  const old = { version: 1, items: [{ keyword: "재등장", normalizedKeyword: "재등장", firstSeenAt: "2026-01-01T00:00:00Z",
    lastSeenAt: "2026-02-01T00:00:00Z", discoverySource: ["youtube"], active: false }] };
  const incoming = [{ keyword: "재등장", normalizedKeyword: "재등장", discoveredAt: "2026-09-01T00:00:00Z", discoverySource: ["searchad-new-query"] }];
  const restored = history.restoreHistory(incoming, old);
  assert.equal(restored[0].discoveredAt, "2026-01-01T00:00:00Z");
  assert.equal(restored[0].reappeared, true);
  const merged = history.mergeHistory(old, restored, new Set(["재등장"]), "2026-09-02T00:00:00Z");
  assert.deepEqual(merged.items[0].discoverySource.sort(), ["searchad-new-query", "youtube"]);
  assert.equal(merged.items[0].active, true);
  const signaled = history.mergeSignalHistory(merged, [{ keyword: "재등장", resultType: "product_match", estimatedSurgeCount: 500,
    match: { item: { brand: "브랜드", product: "상품" } } }], "2026-09-03T00:00:00Z");
  assert.equal(signaled.items[0].everSurged, true); assert.equal(signaled.items[0].relatedProduct, "상품");
});

test("scheduled pipeline separates candidate refresh, discovery and Trend collection", () => {
  const config = fs.readFileSync("netlify.toml", "utf8");
  assert.match(config, /keyword-candidate-scheduled[\s\S]*0 17 \* \* \*/);
  assert.match(config, /market-discovery-scheduled[\s\S]*0 \*\/6 \* \* \*/);
  assert.match(config, /trend-data-collection-scheduled[\s\S]*0 21 \* \* \*/);
  for (const file of ["market-discovery-cache.js", "keyword-candidate-cache.js"]) {
    const source = fs.readFileSync(`netlify/functions/${file}`, "utf8");
    assert.match(source, /getWithMetadata/); assert.match(source, /onlyIfMatch/); assert.match(source, /onlyIfNew/);
  }
});

test("dashboard exposes freshness and discovery while folding administrator recovery buttons", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /관리자 데이터 관리/);
  assert.match(html, /정상 운영에서는 자동 수집/);
  assert.match(html, /분석 후보 풀/);
  assert.match(html, /최근 발견 키워드 TOP 100/);
  assert.match(html, /급등 확정 결과는 아닙니다/);
  assert.match(html, /dataStatusSummary/);
  assert.match(html, /Trend 분석 범위/);
});

test("Fast Path and Shopping deferral protections remain intact", () => {
  const background = fs.readFileSync("netlify/functions/trend-analysis-background.js", "utf8");
  assert.match(background, /job\.fastPath \? \{ selected: \[\], pending: searchFetchQueue/);
  assert.match(background, /if \(!job\.fastPath && rows\.length\)/);
  assert.match(background, /const shoppingCandidates = rows\.map/);
  assert.match(background, /budgetMode = !job\.fastPath && initialCoveragePct < 90/);
});
