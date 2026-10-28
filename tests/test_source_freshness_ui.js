const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { extractFunction } = require("../scripts/verify-deployed-period-display.cjs");
const html = fs.readFileSync("index.html", "utf8");
const now = new Date("2026-10-16T09:10:00.000Z");
function runtime(payload, endpoint = "trend-cache-status") {
  const nodes = new Map(), requests = [];
  const node = id => { if (!nodes.has(id)) nodes.set(id, { textContent: "", innerHTML: "", style: {}, classList: { toggle() {} } }); return nodes.get(id); };
  const context = vm.createContext({ state: { currentAnalysisJob: { jobId: "instant96", results: Array(96).fill({}), analyzedCandidateCount: 5000 },
    currentPeriodAnalysisJob: { jobId: "period439", results: Array(439).fill({}) } }, $: node,
    fetch: async route => { requests.push(route); assert.equal(route, `/.netlify/functions/${endpoint}`); return new Response(JSON.stringify(payload)); } });
  for (const name of ["escapeHtml", "formatDateTimeText", "formatHistoryDate", "sourceFreshnessLabel", "trendFreshnessDisplay", "earlySignalFreshnessDisplay", "loadTrendCacheStatus", "loadTodayEarlySignals"])
    vm.runInContext(extractFunction(html, name), context);
  return { context, node, requests };
}
function trend(overrides = {}) {
  return { latestJob: { jobId: "instant96", latestDataDate: "2026-10-14", analyzedCandidateCount: 5000, trendAvailableCount: 5000 },
    snapshot: { jobId: "instant96", latestDataDate: "2026-10-14", trendCoveragePct: 100 },
    latestAnalysis: { jobId: "instant96", analyzedAt: "2026-10-16T09:06:04Z", publishedAt: "2026-10-16T09:06:11Z" },
    latestCollection: { latestDataDate: "2026-10-11", collectedAt: "2026-10-12T21:13:19Z" },
    schedulerExecution: { state: "dispatched", triggeredAt: "2026-10-15T23:00:00Z" }, ...overrides };
}

test("NAVER summary shows actual valid data date instead of older collection date, and separates coverage from freshness", () => {
  const { context } = runtime(); const display = context.trendFreshnessDisplay(trend(), now);
  assert.equal(display.actualDate, "2026-10-14"); assert.equal(display.targetDate, "2026-10-15"); assert.equal(display.coverage, 100);
  assert.equal(display.status, "delayed"); assert.match(display.summary, /확인 대상일 2026-10-15/);
  assert.match(display.summary, /실제 NAVER 데이터 기준일 2026-10-14/); assert.match(display.summary, /5,000 \/ 5,000 \(100%, 캐시 확보\)/);
  assert.doesNotMatch(display.summary, /정상|100% 분석 완료|데이터 기준일 2026-10-11/);
});

test("collection, calculation and publication timestamps remain independent; dispatched is not called running/completed", () => {
  const display = runtime().context.trendFreshnessDisplay(trend(), now);
  assert.match(display.detail, /마지막 실제 Trend 수집 2026-10-13 06:13/);
  assert.match(display.detail, /마지막 계산 2026-10-16 18:06 · 마지막 게시 2026-10-16 18:06/);
  assert.match(display.summary, /자동 작업 요청 접수/); assert.match(display.summary, /완료 확인 필요/);
  assert.doesNotMatch(display.summary, /진행 중|자동 작업 완료/);
});

test("target-date sample wait is not collection failure and selected-result clocks stay separate from the newer attempt", () => {
  const payload = trend({ observation: { lastSourceCheckedAt: "2026-10-16T09:00:00Z",
    preflight: { status: "waiting", targetDataDate: "2026-10-15", sampleSize: 5, attempts: 1,
      lastCheckedAt: "2026-10-16T09:00:00Z", nextCheckAt: "2026-10-16T11:00:00Z" },
    mainSelection: { text: "실제 데이터 날짜가 같아 기존 결과 유지", candidateChanged: true },
    lastAttempt: { jobId: "auto113", resultCount: 113, calculatedAt: "2026-10-16T08:00:00Z", publishedAt: "2026-10-16T08:02:00Z" } } });
  const display = runtime().context.trendFreshnessDisplay(payload, now);
  assert.match(display.summary, /목표일 2026-10-15 미확인 · 마지막 확인 데이터 2026-10-14/);
  assert.match(display.summary, /목표일 표본 재확인 대기/);
  assert.match(display.summary, /확인한 표본에서 목표일 미확인/);
  assert.match(display.summary, /NAVER 전체 미제공 확정 아님/);
  assert.match(display.detail, /마지막 원천 확인 2026-10-16 18:00/);
  assert.match(display.detail, /최근 별도 계산 Job auto113 \(113건\)/);
  assert.match(display.detail, /기존 결과 유지/);
  assert.doesNotMatch(display.summary, /자동 작업 실패|자동 작업 완료/);
});

test("read-only observation metadata reports saved checks and selection reasons without inferring target availability", () => {
  const { observationStatus } = require("../netlify/functions/trend-cache-status");
  const selected = { jobId: "main109", mode: "instant", latestDataDate: "2026-10-26", trendCoveragePct: 100 };
  const analysis = { jobId: "auto113", mode: "instant", state: "completed", latestDataDate: "2026-10-26", trendCoveragePct: 99.9,
    targetDataDate: "2026-10-27", calculatedAt: "2026-10-28T00:00:00Z", publishedAt: "2026-10-28T00:02:00Z", resultCount: 113 };
  const scheduledJob = { targetDatePreflight: { targetDataDate: "2026-10-27", status: "waiting", lastCheckedAt: "2026-10-28T01:00:00Z" } };
  const before = JSON.stringify([selected, analysis, scheduledJob]);
  const status = observationStatus({ selected, latestAnalysis: analysis, scheduledJob, target: "2026-10-27" });
  assert.equal(status.mainSelection.code, "same-date-coverage");
  assert.equal(status.lastSourceCheckedAt, "2026-10-28T01:00:00Z");
  assert.equal(status.lastAttempt.publishedAt, analysis.publishedAt);
  assert.equal(status.lastAttempt.actualDataDate, "2026-10-26");
  assert.equal(JSON.stringify([selected, analysis, scheduledJob]), before);
  assert.equal(observationStatus({ selected, scheduledJob, target: "2026-10-28" }).preflight, null);
});

test("confirmed sample while old main is retained is not mislabeled as target-day absence or full coverage", () => {
  const display = runtime().context.trendFreshnessDisplay(trend({ observation: { preflight: {
    status: "confirmed-sample", targetDataDate: "2026-10-15", sampleSize: 5, attempts: 1, lastCheckedAt: "2026-10-16T09:00:00Z" } } }), now);
  assert.match(display.summary, /표본 또는 저장 캐시에서 목표일 2026-10-15 확인/);
  assert.match(display.summary, /전체 확보·메인 반영과 별도/);
  assert.doesNotMatch(display.summary, /목표일 2026-10-15 미확인|목표일 100%/);
});

test("scheduled unchanged-input disposition is shown as retained result, not unfinished work", () => {
  const display = runtime().context.trendFreshnessDisplay(trend({ schedulerExecution: {
    state: "skipped", stage: "unchanged-input", triggeredAt: "2026-10-16T00:00:00Z" } }), now);
  assert.match(display.summary, /입력 변화 없음 · 기존 정상 결과 유지/);
  assert.doesNotMatch(display.summary, /완료 확인 필요|자동 작업 실패/);
});

test("waiting after sample transport failure is distinct from a successful response without target data", () => {
  const display = runtime().context.trendFreshnessDisplay(trend({ observation: { preflight: {
    status: "waiting", reason: "sample-request-failed", targetDataDate: "2026-10-15", sampleSize: 5, attempts: 1,
    lastCheckedAt: "2026-10-16T09:00:00Z", nextCheckAt: "2026-10-16T11:00:00Z" } } }), now);
  assert.match(display.summary, /표본 조회 오류로 목표일 확인 불가/);
  assert.match(display.summary, /데이터 미제공 판정 아님/);
  assert.doesNotMatch(display.summary, /확인한 표본에서 목표일 미확인/);
});

function pollRuntime(job) {
  const rt = runtime(); const calls = [], timers = [];
  rt.context.fetch = async route => { calls.push(route); return new Response(JSON.stringify(job)); };
  rt.context.setTimeout = (fn, ms) => { timers.push(ms); return 1; };
  rt.context.finishAnalysisControls = () => calls.push("controls-finished");
  rt.context.loadLastSuccessfulAnalysis = async mode => { calls.push(`read-selected-${mode}`); return rt.context.state.currentAnalysisJob; };
  rt.context.loadTrendCacheStatus = async () => calls.push("read-existing-freshness");
  rt.context.showApiErrors = () => { throw new Error("Unexpected error UI"); };
  rt.context.loadMarketDiscoveryNewList = rt.context.loadTodayEarlySignals = async () => {};
  rt.context.log = () => {};
  vm.runInContext(extractFunction(html, "pollAnalysis"), rt.context);
  return { ...rt, calls, timers };
}

test("Instant source wait never overwrites selected main metadata and needs no additional endpoint", async () => {
  const rt = pollRuntime({ jobId: "waiting-job", mode: "instant", state: "running", currentStage: "waiting-for-source",
    message: "예약 재확인 대기", updatedAt: "2026-10-16T09:00:00Z", targetDatePreflight: { status: "waiting" } });
  const before = JSON.stringify(rt.context.state);
  await rt.context.pollAnalysis("waiting-job");
  assert.equal(JSON.stringify(rt.context.state), before);
  assert.deepEqual(rt.calls, ["/.netlify/functions/trend-analysis-status?jobId=waiting-job"]);
  assert.deepEqual(rt.timers, [3000]);
});

test("deferred Instant restores only existing result/status and does not report completion or failure", async () => {
  for (const outcome of ["target-date-unconfirmed", "unchanged-input"]) {
    const rt = pollRuntime({ jobId: "deferred-job", mode: "instant", state: "deferred", outcome, currentStage: "waiting-for-source" });
    const before = JSON.stringify(rt.context.state);
    await rt.context.pollAnalysis("deferred-job");
    assert.equal(JSON.stringify(rt.context.state), before);
    assert.deepEqual(rt.calls, ["/.netlify/functions/trend-analysis-status?jobId=deferred-job",
      "read-selected-instant", "read-existing-freshness", "controls-finished"]);
    assert.equal(rt.timers.length, 0);
    assert.match(rt.node("analysisProgressText").textContent, /기존 정상 게시 결과 유지/);
    assert.doesNotMatch(rt.node("analysisProgressText").textContent, /분석 완료|분석 실패/);
  }
});

test("NAVER normal/partial/failed/no-data states do not treat valid cache coverage as current data", () => {
  const context = runtime().context;
  const fresh = trend({ snapshot: { latestDataDate: "2026-10-15", trendCoveragePct: 100 } });
  assert.equal(context.trendFreshnessDisplay(fresh, now).status, "normal");
  fresh.latestJob.trendAvailableCount = 3000;
  assert.equal(context.trendFreshnessDisplay(fresh, now).status, "partial");
  fresh.freshness = { status: "failed", actualDataDate: "2026-10-15" };
  assert.equal(context.trendFreshnessDisplay(fresh, now).status, "failed");
  const empty = context.trendFreshnessDisplay({}, now);
  assert.equal(empty.status, "no_data"); assert.match(empty.summary, /실제 NAVER 데이터 기준일 확인 불가/);
});

test("target-day observations and valid/empty series are separate from cache coverage and do not infer errors", () => {
  const payload = trend({ freshness: { targetDataDate: "2026-10-15", actualDataDate: "2026-10-15", status: "normal",
    targetDataCandidateCount: 3200, targetDataCoveragePct: 64, validSeriesCount: 4904, emptySeriesCount: 96 } });
  const display = runtime().context.trendFreshnessDisplay(payload, now);
  assert.equal(display.status, "normal"); assert.equal(display.coverage, 100);
  assert.match(display.summary, /5,000 \/ 5,000 \(100%, 캐시 확보\)/);
  assert.match(display.summary, /목표일 관측 후보 3,200 \/ 5,000 \(64%\)/);
  assert.match(display.summary, /유효 시계열 4,904 · 빈 시계열 96/);
  assert.match(display.detail, /희소·빈 시계열의 목표일 미관측은 수집 오류를 뜻하지 않습니다/);
  assert.doesNotMatch(display.summary, /갱신 실패/);
});

test("unavailable observation counts remain unknown and Job sourceFreshness fallback is supported", () => {
  const rt = runtime(); const unknown = rt.context.trendFreshnessDisplay(trend(), now);
  assert.match(unknown.summary, /목표일 관측 후보 확인 불가/); assert.match(unknown.summary, /빈 시계열 확인 불가/);
  const payload = trend(); payload.latestJob.sourceFreshness = { actualDataDate: "2026-10-15", targetDataDate: "2026-10-15",
    status: "normal", targetDataCandidateCount: 0, targetDataCoveragePct: 0, validSeriesCount: 4904, emptySeriesCount: 96 };
  const known = rt.context.trendFreshnessDisplay(payload, now);
  assert.match(known.summary, /목표일 관측 후보 0 \/ 5,000 \(0%\)/); assert.equal(known.status, "normal");
});

test("direct Instant completion rendering includes saved source observation counts without touching Period results", () => {
  const rt = runtime(); rt.context.render = () => {};
  vm.runInContext(extractFunction(html, "displayCompletedAnalysis"), rt.context);
  const periodBefore = JSON.stringify(rt.context.state.currentPeriodAnalysisJob);
  rt.context.displayCompletedAnalysis({ jobId: "completed-instant", mode: "instant", results: [], latestDataDate: "2026-10-15",
    analyzedCandidateCount: 5000, trendAvailableCount: 5000, trendCoveragePct: 100,
    sourceFreshness: { targetDataDate: "2026-10-15", targetDataCandidateCount: 3200, targetDataCoveragePct: 64, validSeriesCount: 4904, emptySeriesCount: 96 } });
  assert.match(rt.node("yesterdaySurgeMeta").textContent, /목표일 2026-10-15 관측 후보 3,200 \/ 5,000 \(64%\)/);
  assert.match(rt.node("yesterdaySurgeMeta").textContent, /유효 시계열 4,904 · 빈 시계열 96/);
  assert.equal(JSON.stringify(rt.context.state.currentPeriodAnalysisJob), periodBefore);
});

test("today signal date and generation are never synthesized when cache metadata is absent", () => {
  const display = runtime().context.earlySignalFreshnessDisplay({ count: 0, items: [] }, now);
  assert.match(display, /신호 기준일 확인 불가/); assert.match(display, /생성 기록 없음/); assert.match(display, /상태 데이터 없음/);
  assert.match(display, /YouTube 수집 성공 기록 없음/); assert.match(display, /Search Ad 수집 성공 기록 없음/);
  assert.doesNotMatch(display, /2026-10-16|상태 정상/);
});

test("old signal date stays old and delayed even when rows are available", () => {
  const display = runtime().context.earlySignalFreshnessDisplay({ signalDate: "2026-10-13", generatedAt: "2026-10-13T03:00:00Z", count: 8,
    freshness: { sourceSuccessTimes: { youtube: "2026-10-13T02:00:00Z", searchAd: "2026-10-13T02:00:00Z" } } }, now);
  assert.match(display, /신호 기준일 2026-10-13/); assert.match(display, /상태 갱신 지연/); assert.match(display, /저장 신호 8건/);
  assert.doesNotMatch(display, /신호 기준일 2026-10-16|상태 정상/);
});

test("today source success times distinguish normal, partial, delayed and failed without substituting generatedAt", () => {
  const context = runtime().context;
  const payload = { signalDate: "2026-10-16", generatedAt: "2026-10-16T09:00:00Z", freshness: { status: "normal", sourceSuccessTimes: {
    youtube: "2026-10-16T08:30:00Z", searchAd: "2026-10-16T08:20:00Z" } } };
  assert.match(context.earlySignalFreshnessDisplay(payload, now), /상태 정상/);
  payload.freshness.sourceSuccessTimes.searchAd = null;
  payload.freshness.status = "partial";
  const partial = context.earlySignalFreshnessDisplay(payload, now); assert.match(partial, /상태 부분/); assert.match(partial, /Search Ad 수집 성공 기록 없음/);
  payload.freshness.sourceSuccessTimes.youtube = "2026-10-16T00:00:00Z";
  payload.freshness.status = "delayed";
  assert.match(context.earlySignalFreshnessDisplay(payload, now), /상태 갱신 지연/);
  payload.freshness.status = "failed";
  assert.match(context.earlySignalFreshnessDisplay(payload, now), /상태 갱신 실패/);
});

test("source timestamps alone do not certify normal freshness or impose an invented source cadence", () => {
  const display = runtime().context.earlySignalFreshnessDisplay({ signalDate: "2026-10-16", generatedAt: "2026-10-16T09:00:00Z",
    sourceSuccessTimes: { youtube: "2026-10-16T08:30:00Z", searchAd: "2026-10-15T17:00:00Z" } }, now);
  assert.match(display, /상태 부분/); assert.doesNotMatch(display, /상태 정상|상태 갱신 지연/);
});

test("backend source-aware freshness statuses are mapped without overriding its source cadence policy", () => {
  const context = runtime().context;
  const payload = { signalDate: "2026-10-16", generatedAt: "2026-10-16T00:00:00Z",
    freshness: { status: "current", sourceSuccessTimes: { youtube: "2026-10-16T00:00:00Z", searchAd: "2026-10-15T17:00:00Z" } } };
  assert.match(context.earlySignalFreshnessDisplay(payload, now), /상태 정상/);
  payload.freshness.status = "stale"; assert.match(context.earlySignalFreshnessDisplay(payload, now), /상태 갱신 지연/);
  payload.freshness.status = "missing"; assert.match(context.earlySignalFreshnessDisplay(payload, now), /상태 데이터 없음/);
  payload.freshness.status = "partial"; payload.sourceErrors = ["fixture source failure"];
  payload.sourceObservationPolicy = { searchAd: "refresh_observation_window_unspecified" };
  const text = context.earlySignalFreshnessDisplay(payload, now);
  assert.match(text, /상태 부분/); assert.match(text, /일부 소스 갱신 오류/); assert.match(text, /당일 검색량이 아닙니다/);
  assert.doesNotMatch(text, /fixture source failure/);
});

test("existing read endpoints update freshness labels without modifying 96 Instant rows or 439 Period rows", async () => {
  const rt = runtime(trend()); const before = JSON.stringify(rt.context.state);
  await rt.context.loadTrendCacheStatus();
  assert.equal(JSON.stringify(rt.context.state), before); assert.equal(rt.requests.length, 1);
  assert.match(rt.node("latestDataDate").textContent, /2026-10-14/);
  assert.doesNotMatch(rt.node("dataStatusSummary").textContent, /데이터 기준일 2026-10-11/);
});

test("today empty state does not claim there are no market signals and only existing GET endpoint is used", async () => {
  const rt = runtime({ signalDate: null, generatedAt: null, items: [], count: 0 }, "today-early-signals");
  const before = JSON.stringify(rt.context.state); await rt.context.loadTodayEarlySignals();
  assert.match(rt.node("todayEarlySignalMeta").textContent, /기준일 확인 불가/);
  assert.match(rt.node("todayEarlySignalBody").innerHTML, /시장 신호가 없다는 뜻이 아닙니다/);
  assert.equal(JSON.stringify(rt.context.state), before); assert.equal(rt.requests.length, 1);
});
