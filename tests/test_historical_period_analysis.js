const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ExcelJS = require("exceljs");
const cache = require("../netlify/functions/trend-series-cache");
const quota = require("../netlify/functions/trend-api-quota");
const snapshots = require("../netlify/functions/signal-snapshot-cache");
const { toBuffer } = require("../netlify/functions/unified-excel");
const startHelpers = require("../netlify/functions/trend-analysis-start")._test;

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

test("period UI exposes one-click collection while keeping manual recovery under admin controls", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /선택 기간 분석 준비 중|NAVER 기간 데이터 수집 준비 중/);
  assert.match(html, /trend-period-data-collection-start/);
  assert.match(html, /NAVER Search Trend API와 기간 분석 전용 quota를 사용합니다/);
  assert.match(html, /선택 기간 데이터 수집 복구/);
  assert.match(html, /matchingPeriodJobId/);
});

test("period analysis chains cache check collection and final fast analysis without a second click", () => {
  const html = fs.readFileSync("index.html", "utf8");
  const flow = html.slice(html.indexOf("async function startPeriodOneClickStep"), html.indexOf("function displayCompletedAnalysis"));
  assert.match(flow, /phase === "initial-fast"/);
  assert.match(flow, /available < total/);
  assert.match(flow, /trend-period-data-collection-start/);
  assert.match(flow, /phase === "historical-collection"/);
  assert.match(flow, /trend-analysis-start/);
  assert.match(flow, /"final-fast"/);
});

test("period one-click collects at most once per user run and recovers with cached partial data", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /!flow\.collectionAttempted/);
  assert.match(html, /flow\.collectionAttempted = true/);
  assert.match(html, /user-period-one-click-recovery-fast/);
  assert.match(html, /기존 cache로 부분 결과를 계산합니다/);
});

test("period cached snapshots are looked up on the period pointer", () => {
  const source = fs.readFileSync("netlify/functions/trend-analysis-start.js", "utf8");
  assert.match(source, /readLatestSnapshot\(mode\)/);
});

test("normal period UI no longer asks users to press the historical collection button", () => {
  const html = fs.readFileSync("index.html", "utf8");
  const panel = html.slice(html.indexOf('<section class="panel" id="periodAnalysisPanel"'), html.indexOf('<section class="panel" id="brandSignalPanel"'));
  assert.doesNotMatch(panel, /collectPeriodDataBtn/);
  const admin = html.slice(html.indexOf('<details id="adminDataManagement"'), html.indexOf('</details>', html.indexOf('<details id="adminDataManagement"')));
  assert.match(admin, /collectPeriodDataBtn/);
});

test("period one-click progress distinguishes collection from local analysis", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /NAVER 기간 데이터 수집 중/);
  assert.match(html, /기간 분석 중/);
  assert.match(html, /기간 분석 부분 완료/);
});

test("a complete period cache finishes without starting historical collection", () => {
  const html = fs.readFileSync("index.html", "utf8");
  const flow = html.slice(html.indexOf("async function continuePeriodOneClick"), html.indexOf("function displayCompletedAnalysis"));
  assert.match(flow, /available < total/);
  assert.match(flow, /flow\.active = false/);
});

test("partial historical collection keeps the existing miss-only server planner", () => {
  const background = fs.readFileSync("netlify/functions/trend-analysis-background.js", "utf8");
  assert.match(background, /cached\.state === "hit"/);
  assert.match(background, /searchFetchQueue\.push/);
  assert.match(background, /planTrendFetch\(searchFetchQueue/);
});

test("one-click historical collection retains dedicated daily and monthly safety budgets", () => {
  const status = quota.historicalRemaining({ daily: {}, monthly: {} });
  assert.equal(status.dailyCap, 200);
  assert.equal(status.monthlyCap, 2000);
});

test("duplicate period clicks are blocked in the browser and the server lock is retained", () => {
  const html = fs.readFileSync("index.html", "utf8");
  const cacheSource = fs.readFileSync("netlify/functions/trend-analysis-cache.js", "utf8");
  assert.match(html, /activePeriodOneClick\?\.active/);
  assert.match(cacheSource, /acquireJob/);
  assert.match(cacheSource, /Duplicate analysis start was prevented/);
});

test("historical failure persists successful dirty cache batches before partial recovery", () => {
  const background = fs.readFileSync("netlify/functions/trend-analysis-background.js", "utf8");
  assert.match(background, /if \(seriesCache && dirtyTrendKeys\.size\) await writeDirtyTrendSeries/);
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /user-period-one-click-recovery-fast/);
});

test("one-click historical work stays separate from instant collection and Early Signal", () => {
  const background = fs.readFileSync("netlify/functions/trend-analysis-background.js", "utf8");
  assert.match(background, /await writeSnapshot\(job\)/);
  assert.match(background, /job\.historicalCollection/);
  const snapshotSource = fs.readFileSync("netlify/functions/signal-snapshot-cache.js", "utf8");
  assert.match(snapshotSource, /job\?\.mode === "instant" && !job\?\.fastPath/);
});

test("one-click period result remains the workbook period source automatically", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /state\.currentPeriodAnalysisJob = job/);
  assert.match(html, /periodJobId: matchingPeriodJobId/);
  const workbook = fs.readFileSync("netlify/functions/unified-excel.js", "utf8");
  assert.match(workbook, /07_선택기간분석/);
});

test("a completed zero-coverage fast job cannot match a historical collection request", () => {
  const request = { mode: "period", fastPath: false, historicalCollection: true, startDate: "2026-08-30", endDate: "2026-09-01", queryStartDate: "2026-08-02" };
  const staleFast = { ...request, jobId: "fast-zero", state: "completed", fastPath: true, historicalCollection: false };
  assert.equal(startHelpers.matchesRequestedJob(staleFast, request), false);
});

test("only the same historical job type and exact required window can dedupe", () => {
  const request = { mode: "period", fastPath: false, historicalCollection: true, startDate: "2026-08-30", endDate: "2026-09-01", queryStartDate: "2026-08-02" };
  assert.equal(startHelpers.matchesRequestedJob({ ...request, jobId: "historical-running", state: "running" }, request), true);
  assert.equal(startHelpers.matchesRequestedJob({ ...request, queryStartDate: "2026-08-03" }, request), false);
  assert.equal(startHelpers.matchesRequestedJob({ ...request, endDate: "2026-09-02" }, request), false);
});

test("server rejects an incompatible existing job as a retryable conflict", () => {
  const source = fs.readFileSync("netlify/functions/trend-analysis-start.js", "utf8");
  assert.match(source, /if \(historicalCollection && !matchesRequestedJob/);
  assert.match(source, /INCOMPATIBLE_ACTIVE_JOB/);
  assert.match(source, /retryable: true/);
  assert.match(source, /return json\(409/);
});

test("historical start validates returned type dates and required window", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /payload\.historicalCollection === true/);
  assert.match(html, /payload\.fastPath === false/);
  assert.match(html, /payload\.startDate === flow\.startDate/);
  assert.match(html, /payload\.queryStartDate === flow\.requiredWindowStart/);
});

test("historical stale-lock retry is short and bounded", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /HISTORICAL_START_MAX_ATTEMPTS = 3/);
  assert.match(html, /HISTORICAL_START_RETRY_MS = 1500/);
  assert.match(html, /attempt <= attempts/);
});

test("retry exhaustion reports collection start failure rather than period completion", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /error\.periodCollectionStartFailed = collecting/);
  assert.match(html, /기간 데이터 수집 시작 실패 · 현재 coverage/);
  assert.match(html, /잠시 후 재시도 가능/);
});

test("initial zero-coverage result is not rendered as final before collection chaining", () => {
  const html = fs.readFileSync("index.html", "utf8");
  const poll = html.slice(html.indexOf("async function pollAnalysis"), html.indexOf("async function loadCurrentAnalysis"));
  assert.ok(poll.indexOf("continuePeriodOneClick(job, periodFlow)") < poll.indexOf("displayCompletedAnalysis(job)"));
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
