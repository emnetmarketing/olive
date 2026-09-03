const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ExcelJS = require("exceljs");
const cache = require("../netlify/functions/trend-series-cache");
const quota = require("../netlify/functions/trend-api-quota");
const snapshots = require("../netlify/functions/signal-snapshot-cache");
const { toBuffer } = require("../netlify/functions/unified-excel");

test("period exact-window cache hits and misses remain distinguishable", () => {
  const entries = new Map();
  cache.upsert(entries, { keyword: "기간키워드", source: "search", startDate: "2026-08-02", endDate: "2026-09-01",
    series: [{ period: "2026-09-01", ratio: 100 }], fetchedAt: "2026-09-03T00:00:00Z", cacheScope: "historical" });
  assert.equal(cache.lookup(entries, "기간키워드", "search", "beauty", "2026-08-02", "2026-09-01").state, "hit");
  assert.equal(cache.lookup(entries, "기간키워드", "search", "beauty", "2026-07-01", "2026-09-01").state, "window-unavailable");
});

test("historical cache does not replace the rolling latest cache and is reusable", () => {
  const entries = new Map();
  cache.upsert(entries, { keyword: "공존", source: "search", startDate: "2026-08-04", endDate: "2026-09-03", series: [], cacheScope: "latest" });
  cache.upsert(entries, { keyword: "공존", source: "search", startDate: "2026-08-02", endDate: "2026-09-01", series: [], cacheScope: "historical" });
  const entry = entries.get("공존"); assert.equal(entry.search.requestEndDate, "2026-09-03");
  assert.ok(entry.searchWindows[cache.windowKey("2026-08-02", "2026-09-01")]);
  assert.equal(cache.lookup(entries, "공존", "search", "beauty", "2026-08-02", "2026-09-01").state, "hit");
});

test("historical quota is bounded separately while remaining inside global usage", () => {
  const usage = { daily: { searchTrend: 10, searchTrendHistorical: 40 }, monthly: { searchTrend: 100, searchTrendHistorical: 400 }, exhausted: {} };
  const status = quota.historicalRemaining(usage); assert.equal(status.remaining, 160);
  quota.applyUsage(usage, { searchTrend: { calls: 5, historicalCalls: 5 } });
  assert.equal(usage.daily.searchTrend, 15); assert.equal(usage.daily.searchTrendHistorical, 45);
});

test("period collection can never advance the instant latest collection pointer", () => {
  assert.equal(snapshots.shouldAdvanceCollection({ mode: "period", fastPath: false, freshFetchCount: 500 }), false);
});

test("period UI exposes an explicit API collection state without changing instant analysis", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /선택 기간 데이터 준비 필요|선택 기간 데이터 준비 중/);
  assert.match(html, /trend-period-data-collection-start/);
  assert.match(html, /NAVER Search Trend API와 기간 분석 전용 quota를 사용합니다/);
  assert.match(html, /matchingPeriodJobId/);
});

test("historical endpoint shares the slow core and atomic analysis lock", () => {
  const endpoint = fs.readFileSync("netlify/functions/trend-period-data-collection-start.js", "utf8");
  const start = fs.readFileSync("netlify/functions/trend-analysis-start.js", "utf8");
  assert.match(endpoint, /handle\(event, \{ fastPath: false \}\)/);
  assert.match(start, /acquireJob/);
});

test("zero-result period export always contains selected dates, status and sheet", async () => {
  const periodRequest = { startDate: "2026-08-30", endDate: "2026-09-01" };
  const periodJob = { jobId: "period-zero", mode: "period", state: "completed", ...periodRequest, queryStartDate: "2026-08-02",
    trendCoveragePct: 0, trendAvailableCount: 0, analyzedCandidateCount: 5000, cacheWindowUnavailableCount: 4851, partialAnalysis: true, results: [] };
  const instantJob = { jobId: "instant", latestDataDate: "2026-09-02", results: [] };
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await toBuffer({ generatedAt: new Date().toISOString(), instantJob, periodJob, periodRequest }));
  const summary = book.getWorksheet("00_요약"); const summaryValues = summary.getColumn(1).values.map(String);
  assert.ok(summaryValues.includes("선택 분석 시작일")); assert.ok(summaryValues.includes("선택 분석 종료일"));
  const period = book.getWorksheet("07_선택기간분석"); assert.equal(period.getCell("B2").value, "2026-09-01");
  assert.equal(period.getCell("A12").value, "분석 결과 없음"); assert.match(String(period.getCell("B9").value), /cache window 부족/);
});

test("download endpoint requires the UI period job id and exact matching dates", () => {
  const source = fs.readFileSync("netlify/functions/download-history.js", "utf8");
  assert.match(source, /input\.periodJobId/); assert.match(source, /periodJob\.startDate !== periodRequest\.startDate/);
  assert.doesNotMatch(source.slice(source.indexOf('downloadType === "unified_results"')), /newest\("period"\)/);
});

test("historical implementation does not call YouTube Search Ad Shopping or News", () => {
  const endpoint = fs.readFileSync("netlify/functions/trend-period-data-collection-start.js", "utf8");
  const background = fs.readFileSync("netlify/functions/trend-analysis-background.js", "utf8");
  assert.doesNotMatch(endpoint, /youtube|keywordstool|shopping|news|search-ad/i);
  assert.match(background, /!job\.historicalCollection && rows\.length/);
  assert.match(background, /job\.fastPath \|\| job\.historicalCollection \? \[\]/);
});
