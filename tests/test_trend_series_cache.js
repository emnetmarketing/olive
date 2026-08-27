const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const cache = require("../netlify/functions/trend-series-cache");
const quota = require("../netlify/functions/trend-api-quota");
const analysis = require("../netlify/functions/trend-analysis-background")._test;

function historicalRecord(entries, keyword = "테스트키워드") {
  cache.upsert(entries, { keyword, source: "search", startDate: "2026-07-20", endDate: "2026-08-24",
    series: [{ period: "2026-08-23", ratio: 20 }, { period: "2026-08-24", ratio: 100 }], fetchedAt: "2026-08-25T00:00:00.000Z" });
}

test("historical Search Trend cache reuses an exact or covered range", () => {
  const entries = new Map(); historicalRecord(entries);
  const found = cache.lookup(entries, "테스트 키워드", "search", "beauty", "2026-08-23", "2026-08-24", new Date("2026-08-26T00:00:00Z"));
  assert.equal(found.state, "hit");
  assert.equal(found.series.length, 2);
});

test("cache miss and insufficient range are distinguished", () => {
  const entries = new Map(); historicalRecord(entries);
  assert.equal(cache.lookup(entries, "없는키워드", "search", "beauty", "2026-08-23", "2026-08-24").state, "miss");
  assert.equal(cache.lookup(entries, "테스트키워드", "search", "beauty", "2026-07-01", "2026-08-24").state, "stale");
});

test("an empty upstream series is negative-cached", () => {
  const entries = new Map();
  cache.upsert(entries, { keyword: "데이터없음", source: "search", startDate: "2026-08-01", endDate: "2026-08-24", series: [] });
  const found = cache.lookup(entries, "데이터없음", "search", "beauty", "2026-08-01", "2026-08-24", new Date("2026-08-26T00:00:00Z"));
  assert.equal(found.state, "hit");
  assert.deepEqual(found.series, []);
});

test("current-day data must have been fetched on the same Seoul date", () => {
  const entries = new Map();
  cache.upsert(entries, { keyword: "오늘키워드", source: "search", startDate: "2026-08-01", endDate: "2026-08-26",
    series: [{ period: "2026-08-25", ratio: 100 }], fetchedAt: "2026-08-25T00:00:00.000Z" });
  assert.equal(cache.lookup(entries, "오늘키워드", "search", "beauty", "2026-08-01", "2026-08-26", new Date("2026-08-26T12:00:00+09:00")).state, "stale");
});

test("quota preflight blocks work that exceeds the configured remaining budget", () => {
  const previous = process.env.NAVER_SEARCH_TREND_DAILY_BUDGET;
  process.env.NAVER_SEARCH_TREND_DAILY_BUDGET = "1000";
  const usage = { daily: { searchTrend: 700 }, monthly: { searchTrend: 900 }, exhausted: {} };
  assert.equal(quota.statusFor(usage, "searchTrend", 300).sufficient, true);
  assert.equal(quota.statusFor(usage, "searchTrend", 301).sufficient, false);
  if (previous === undefined) delete process.env.NAVER_SEARCH_TREND_DAILY_BUDGET; else process.env.NAVER_SEARCH_TREND_DAILY_BUDGET = previous;
});

test("default Search Trend operating budget is monthly and dynamically capped per Seoul day", () => {
  const modern = process.env.DAILY_TREND_FETCH_BUDGET; const legacy = process.env.NAVER_SEARCH_TREND_DAILY_BUDGET;
  delete process.env.DAILY_TREND_FETCH_BUDGET; delete process.env.NAVER_SEARCH_TREND_DAILY_BUDGET;
  assert.equal(quota.limits().searchTrend.operatingMonthly, 20000);
  assert.equal(quota.limits().searchTrend.dailyCap, 1000);
  const usage = { daily: {}, monthly: {}, exhausted: {} };
  const daily = quota.dynamicDailyLimit(usage, "searchTrend", new Date("2026-08-01T00:00:00+09:00"));
  assert.equal(daily, Math.floor(20000 / 31));
  if (modern !== undefined) process.env.DAILY_TREND_FETCH_BUDGET = modern;
  if (legacy !== undefined) process.env.NAVER_SEARCH_TREND_DAILY_BUDGET = legacy;
});

test("quota usage for both API families is merged in one document", () => {
  const usage = { daily: {}, monthly: {}, exhausted: {} };
  quota.applyUsage(usage, { searchTrend: { calls: 20, retries: 15, exhausted: true }, shoppingInsight: { calls: 7, retries: 1 } });
  assert.equal(usage.daily.searchTrend, 20);
  assert.equal(usage.daily.shoppingInsight, 7);
  assert.equal(usage.daily.searchTrendRetries, 15);
  assert.equal(usage.exhausted.searchTrend, true);
});

test("market discovery and new Search Ad candidates receive fetch priority", () => {
  const prior = new Map([["이력후보", { estimatedSurgeCount: 800 }]]);
  const market = analysis.trendFetchPriority({ keyword: "시장후보", marketDiscovery: true, sources: [] }, prior);
  const searchAd = analysis.trendFetchPriority({ keyword: "신규유입", sources: ["searchad-new-query"] }, prior);
  const history = analysis.trendFetchPriority({ keyword: "이력후보", sources: [] }, prior);
  const ordinary = analysis.trendFetchPriority({ keyword: "일반", sources: [] }, prior);
  assert.ok(market > searchAd && searchAd > history && history > ordinary);
});

test("an empty 5,000-keyword cache schedules only the internal daily budget", () => {
  const queue = Array.from({ length: 5000 }, (_, index) => ({ keyword: `후보${index}` }));
  const plan = analysis.planTrendFetch(queue, { remaining: 300, dailyRemaining: 300 });
  assert.equal(plan.expectedCalls, 300);
  assert.equal(plan.selected.length, 1500);
  assert.equal(plan.pending.length, 3500);
});

test("an exhausted provider quota schedules no API calls and leaves all candidates pending", () => {
  const queue = Array.from({ length: 5000 }, (_, index) => ({ keyword: `후보${index}` }));
  const plan = analysis.planTrendFetch(queue, { remaining: 300, dailyRemaining: 300, exhausted: true });
  assert.equal(plan.expectedCalls, 0);
  assert.equal(plan.selected.length, 0);
  assert.equal(plan.pending.length, 5000);
});

test("a later run continues from cache misses and a complete cache needs zero calls", () => {
  const remaining = Array.from({ length: 700 }, (_, index) => ({ keyword: `미완료${index}` }));
  const continued = analysis.planTrendFetch(remaining, { remaining: 300, dailyRemaining: 300 });
  assert.equal(continued.selected.length, 700);
  assert.equal(continued.expectedCalls, 140);
  const complete = analysis.planTrendFetch([], { remaining: 300, dailyRemaining: 300 });
  assert.equal(complete.expectedCalls, 0);
});

test("period surge calculation remains unchanged by cache integration", () => {
  const series = [100, 100, 100, 100, 100, 100, 100, 500].map((estimated, index) => ({ period: `2026-08-${String(index + 1).padStart(2, "0")}`, estimated }));
  const result = analysis.periodMetrics(series, "2026-08-08", "2026-08-08");
  assert.equal(Math.round(result.peakDailyLift), 400);
  assert.equal(Math.round(result.surgeCount), 400);
});

test("persistent 429 stops safely and preserves completed cache work and last-success publication order", () => {
  const source = fs.readFileSync("netlify/functions/trend-analysis-background.js", "utf8");
  assert.match(source, /response\.status === 429 && metrics[\s\S]*metrics\.exhausted = true/);
  assert.match(source, /response\.status === 429 && retryAfterSeconds <= 0/);
  assert.match(source, /metrics\?\.exhausted[\s\S]*NAVER 일일 호출 한도 소진 상태/);
  assert.match(source, /catch \(error\)[\s\S]*writeDirtyTrendSeries\(seriesCache, dirtyTrendKeys\)/);
  assert.match(source, /await persist\(\{ state: "completed"[\s\S]*await writeLastSuccess\(job\)/);
});

test("partial analysis records pending coverage instead of failing the job", () => {
  const source = fs.readFileSync("netlify/functions/trend-analysis-background.js", "utf8");
  assert.match(source, /const pendingTrendCacheCount = Math\.max/);
  assert.match(source, /const partialAnalysis = pendingTrendCacheCount > 0/);
  assert.match(source, /state: "completed"[\s\S]*partialAnalysis, trendAvailableCount, pendingTrendCacheCount, trendCoveragePct/);
  assert.doesNotMatch(source, /잔여 한도가 부족합니다[\s\S]*throw new Error/);
});
