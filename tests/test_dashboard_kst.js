const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { extractFunction } = require("../scripts/verify-deployed-period-display.cjs");

const html = fs.readFileSync("index.html", "utf8");
const helper = fs.readFileSync("shared/kst-time-presentation.js", "utf8");
const statusHelper = fs.readFileSync("shared/naver-status-presentation.js", "utf8");
const stamp = "2026-11-01T15:02:03.456Z";
const shown = "2026-11-02 00:02:03";

function runtime(names = [], payload = {}) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: "", innerHTML: "", style: {}, classList: { toggle() {}, add() {}, remove() {} } });
    return nodes.get(id);
  };
  const requests = [];
  const context = vm.createContext({ state: { marketDiscoveryRows: [], downloadHistory: [] }, $: node,
    canEdit: () => true, canOperate: () => true, searchAdStatusTimer: null, candidateStatusTimer: null, marketDiscoveryStatusTimer: null,
    TREND_STATUS_LABELS: { completed: "정상 cache 사용 가능" },
    document: { querySelectorAll: () => [] }, legacyDownloadHistory: () => [],
    fetch: async route => { requests.push(route); return new Response(JSON.stringify(payload)); } });
  vm.runInContext(helper, context);
  vm.runInContext(statusHelper, context);
  for (const name of ["escapeHtml", "formatDateTimeText", "formatHistoryDate", "formatDateTime", "formatFileDate", "formatDuration", "sourceFreshnessLabel", ...names])
    vm.runInContext(extractFunction(html, name), context);
  return { context, node, requests };
}

test("dashboard loads the shared KST formatter before application code and explains its timezone", () => {
  assert.match(html, /<script src="\/shared\/kst-time-presentation\.js"><\/script>\s*<script src="\/shared\/naver-status-presentation\.js"><\/script>\s*<script>/);
  assert.match(html, /모든 시각은 한국시간\(KST\)으로 표시합니다/);
  assert.match(html, /마지막 분석 시간 · 한국시간\(KST\)/);
  assert.match(html, /\$\("statLastRun"\)\.innerHTML = formatDateTime\(completedAt\)/);
  assert.doesNotMatch(html, /formatDateTime\(completedAt \|\| new Date\(\)\)/);
  assert.doesNotMatch(html, /new Date\([^\n]+\)\.toLocale(?:String|TimeString|DateString)\(/);
});

test("dashboard timestamp format is identical in UTC and a non-Korean browser timezone", () => {
  const script = `const fs=require('fs'),vm=require('vm');
    const {extractFunction}=require('./scripts/verify-deployed-period-display.cjs');
    const html=fs.readFileSync('index.html','utf8'),ctx=vm.createContext({});
    vm.runInContext(fs.readFileSync('shared/kst-time-presentation.js','utf8'),ctx);
    vm.runInContext(extractFunction(html,'formatHistoryDate'),ctx);
    process.stdout.write(ctx.formatHistoryDate('${stamp}'));`;
  for (const TZ of ["UTC", "America/Los_Angeles", "Asia/Seoul"])
    assert.equal(execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ }, encoding: "utf8" }), shown);
});

test("history, analysis statistic and browser file clock retain seconds and do not infer naive timestamp zones", () => {
  const { context } = runtime();
  assert.equal(context.formatDateTimeText(stamp), shown);
  assert.equal(context.formatHistoryDate("2026-11-02T00:02:03+09:00"), shown);
  assert.equal(context.formatHistoryDate("2026-11-01T07:02:03-08:00"), shown);
  assert.equal(context.formatDateTime(stamp).replace(/<[^>]+>/g, ""), shown);
  assert.equal(context.formatFileDate(stamp), "261102-0002");
  for (const input of ["2026-11-02 00:02:03", "2026-11-02T00:02:03", "invalid"])
    assert.equal(context.formatHistoryDate(input), "시간대 미확인");
  assert.equal(context.formatHistoryDate(null), "—");
  assert.equal(context.formatDateTime(null), "—");
  assert.doesNotMatch(html, /formatDateTime\(completedAt \? new Date\(completedAt\)/);
});

test("cache product, candidate and Discovery refresh timestamps use the same explicit KST boundary", () => {
  const rt = runtime(["renderSearchAdCacheStatus", "renderCandidateStatus", "renderMarketDiscoveryStatus"]);
  const payload = { cacheExists: true, cache: { refreshedAt: stamp, candidateCount: 5000, uniqueProducts: 100 }, status: { state: "completed" } };
  const before = JSON.stringify(payload);
  rt.context.renderSearchAdCacheStatus(payload);
  rt.context.renderCandidateStatus(payload);
  rt.context.renderMarketDiscoveryStatus(payload);
  for (const id of ["searchAdCacheSummary", "candidateCacheSummary", "marketDiscoverySummary"])
    assert.ok(rt.node(id).textContent.includes(shown));
  assert.equal(JSON.stringify(payload), before);
  assert.equal(rt.requests.length, 0);
});

test("Early Signal source collection and generation timestamps stay independent without changing signal dates", () => {
  const { context } = runtime(["earlySignalFreshnessDisplay"]);
  const payload = { signalDate: "2026-11-01", generatedAt: stamp, count: 58, freshness: { status: "partial", sourceSuccessTimes: {
    youtube: "2026-11-01T14:50:01Z", searchAd: "2026-11-01T13:00:02Z" } } };
  const before = JSON.stringify(payload);
  const output = context.earlySignalFreshnessDisplay(payload, new Date("2026-11-02T01:00:00Z"));
  assert.match(output, /신호 기준일 2026-11-01 · 생성 2026-11-02 00:02:03/);
  assert.match(output, /YouTube 수집 성공 2026-11-01 23:50:01/);
  assert.match(output, /Search Ad 수집 성공 2026-11-01 22:00:02/);
  assert.equal(JSON.stringify(payload), before);
});

test("NAVER summary preserves target, actual dates and counts while rendering source/calculation/publication in KST", () => {
  const { context } = runtime(["trendFreshnessDisplay"]);
  const payload = { latestJob: { jobId: "instant", latestDataDate: "2026-10-31", analyzedCandidateCount: 5000, trendAvailableCount: 4985 },
    snapshot: { jobId: "instant", latestDataDate: "2026-10-31", trendCoveragePct: 99.7 },
    latestAnalysis: { jobId: "instant", analyzedAt: "2026-11-02T01:02:03Z", publishedAt: "2026-11-02T01:03:04Z" },
    latestCollection: { collectedAt: "2026-11-02T00:04:05Z" }, observation: { lastSourceCheckedAt: "2026-11-02T00:05:06Z" },
    freshness: { targetDataDate: "2026-11-01", actualDataDate: "2026-10-31" } };
  const before = JSON.stringify(payload);
  const output = context.trendFreshnessDisplay(payload, new Date("2026-11-02T02:00:00Z"));
  assert.equal(output.actualDate, "2026-10-31"); assert.equal(output.targetDate, "2026-11-01");
  assert.equal(output.coverage, 99.7); assert.equal(output.status, "delayed");
  assert.match(output.detail, /마지막 실제 Trend 수집 2026-11-02 09:04:05/);
  assert.match(output.detail, /마지막 계산 2026-11-02 10:02:03 · 마지막 게시 2026-11-02 10:03:04/);
  assert.match(output.detail, /마지막 원천 확인 2026-11-02 09:05:06/);
  assert.equal(JSON.stringify(payload), before);
});

test("discovered, last-seen and Trend-fetch row timestamps use KST with no additional requests", async () => {
  const payload = { items: [{ keyword: "fixture", rank: 1, discoveredAt: stamp,
    lastSeenAt: "2026-11-02T01:00:01Z", trendFetchedAt: "2026-11-02T02:00:02Z", trendStatus: "completed",
    naverStatus: { data: { state: "target-observed", actualDataDate: "2026-11-01", fetchedAt: "2026-11-02T02:00:02Z" } } }] };
  const rt = runtime(["earlyBrandContextSummary", "sourceComparisonNames", "sourceComparisonTime", "sourceNaverBadges", "sourceComparisonFacts", "discoveryComparisonRow", "loadMarketDiscoveryNewList"], payload);
  let detail; rt.context.comparisonRow = row => { detail = row.detail; return row.cells.join(""); };
  const before = JSON.stringify(payload);
  await rt.context.loadMarketDiscoveryNewList();
  assert.match(rt.node("marketDiscoveryNewBody").innerHTML, /2026-11-02 00:02:03/);
  assert.match(detail, /2026-11-02 10:00:01/);
  assert.match(detail, /2026-11-02 11:00:02/);
  assert.doesNotMatch(rt.node("marketDiscoveryNewBody").innerHTML, /2026-11-02 (10:00:01|11:00:02)/);
  assert.equal(JSON.stringify(payload), before);
  assert.deepEqual(rt.requests, ["/.netlify/functions/market-discovery-list?window=24h&limit=100"]);
});

test("download history renders saved timestamp in KST and keeps the original analysis date range", async () => {
  const payload = { items: [{ id: "saved-download", mode: "unified", filename: "fixture.xlsx", downloadedAt: stamp,
    dataDate: "2026-11-01", startDate: "2026-10-01", endDate: "2026-10-16", status: "completed" }] };
  const rt = runtime(["renderDownloadHistoryShared"], payload);
  const before = JSON.stringify(payload);
  await rt.context.renderDownloadHistoryShared();
  const output = rt.node("downloadHistoryList").innerHTML;
  assert.match(output, /생성: 2026-11-02 00:02:03/);
  assert.match(output, /기준일: 2026-11-01/);
  assert.match(output, /선택기간: 2026-10-01 ~ 2026-10-16/);
  assert.equal(JSON.stringify(payload), before);
  assert.deepEqual(rt.requests, ["/.netlify/functions/download-history"]);
});

test("analysis input/date-only values and stored ISO generation are not rewritten by the display helper", () => {
  const { context } = runtime(["instantRowDateSummary"]);
  context.state.currentAnalysisJob = { targetDataDate: "2026-11-01" };
  assert.match(context.instantRowDateSummary({ latestDataDate: "2026-10-31" }), /NAVER 기준 2026-10-31 · 목표일 이전 관측/);
  assert.match(html, /config\.savedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(html, /downloadedAt: new Date\(\)\.toISOString\(\)/);
  assert.match(html, /progressAgeMs >= 12 \* 60 \* 1000/);
  assert.match(html, /job\.startDate === \$\("collectionStart"\)\.value/);
});
