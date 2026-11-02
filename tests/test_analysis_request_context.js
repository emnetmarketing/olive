const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { extractFunction } = require("../scripts/verify-deployed-period-display.cjs");

const html = fs.readFileSync("index.html", "utf8");
const clone = value => JSON.parse(JSON.stringify(value));
const endpoint = path => `/.netlify/functions/${path}`;
const currentEndpoint = endpoint("trend-analysis-current");
const startEndpoint = endpoint("trend-analysis-start");
const statusEndpoint = id => endpoint(`trend-analysis-status?jobId=${encodeURIComponent(id)}`);
const instantId = "d4a9b311-2018-4a00-ac02-0baabd499aa2";
const oldPeriodId = "c22c5cea-943d-4e93-a986-299a927f891f";
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => clone(value) };
}
function complete(overrides = {}) {
  return { jobId: instantId, mode: "instant", state: "completed", fastPath: false,
    startDate: "2026-10-04", endDate: "2026-11-02", latestDataDate: "2026-11-01",
    createdAt: "2026-11-01T21:00:54.519Z", completedAt: "2026-11-02T02:48:07.806Z",
    publishedAt: "2026-11-02T02:50:09.439Z", trendCoveragePct: 99, analyzedCandidateCount: 5000,
    trendAvailableCount: 4950, surgeThreshold: 300, matchThreshold: 40,
    results: Array.from({ length: 165 }, (_, i) => ({ keyword: `saved-${i}`, estimatedSurgeCount: 1000 - i,
      estimatedLatest: 2000 - i, estimatedBaseline: 1000, latestDataDate: "2026-11-01" })), ...overrides };
}
function stalePeriod(overrides = {}) {
  return { jobId: oldPeriodId, mode: "period", fastPath: true, state: "running",
    startDate: "2026-11-01", endDate: "2026-11-02", createdAt: "2026-11-02T03:15:15.928Z",
    updatedAt: "2026-11-02T03:15:29.230Z", currentStage: "interrupted", stale: true,
    processedCount: 0, totalCount: 5000, lastCursor: 0, resumable: false,
    resumeEvidence: { available: false, status: "missing", reason: "checkpoint-missing" }, ...overrides };
}
function runtime() {
  const nodes = new Map(), requests = [], queued = new Map(), timers = new Map(), errors = [], displays = [];
  let nextTimer = 1;
  const saved = complete();
  const period = complete({ jobId: "65451706-37ad-4a63-abbb-d09055acd1a5", mode: "period",
    startDate: "2026-10-01", endDate: "2026-10-16", latestDataDate: "2026-10-14",
    results: Array.from({ length: 439 }, (_, i) => ({ keyword: `period-${i}`, estimatedSurgeCount: i })) });
  const getNode = id => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { value: id === "collectionStart" ? "2026-11-01" : id === "collectionEnd" ? "2026-11-02" : "",
        textContent: "", innerHTML: "", disabled: false, hidden: false, style: {}, dataset: {},
        classList: { add: (...values) => values.forEach(value => classes.add(value)),
          remove: (...values) => values.forEach(value => classes.delete(value)), contains: value => classes.has(value),
          toggle(value, enabled) { if (enabled ?? !classes.has(value)) classes.add(value); else classes.delete(value); } } });
    }
    return nodes.get(id);
  };
  const context = vm.createContext({ $: getNode, console, KstTimePresentation: require("../shared/kst-time-presentation"),
    state: { currentUser: { role: "admin" }, operatingSettingsLoaded: true,
      operatingSettings: { surgeThreshold: 300, matchThreshold: 40 }, currentAnalysisJob: clone(saved),
      currentPeriodAnalysisJob: clone(period), results: clone(saved.results), periodResultQuery: "" },
    canOperate: () => true, requireOperate: () => true, canEdit: () => true,
    loadOperatingSettings: async () => {}, clearAnalysisUI: text => { getNode("analysisProgressText").textContent = text; },
    showApiErrors: value => { if (value) errors.push(value); }, log: () => {}, alert: () => {},
    loadTrendCacheStatus: async () => {}, loadMarketDiscoveryNewList: async () => {}, loadTodayEarlySignals: async () => {},
    continuePeriodOneClick: async () => false, render: (...args) => displays.push(args),
    displayPeriodAnalysis: job => { context.state.currentPeriodAnalysisJob = job; getNode("analysisProgressText").textContent = `기간 분석 완료 ${job.jobId}`; return job.results || []; },
    setTimeout: (callback, delay) => { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 1, clearInterval: () => {},
    fetch: async (url, options = {}) => {
      const method = options.method || "GET";
      requests.push({ url, method, body: options.body ? JSON.parse(options.body) : null });
      const key = `${method} ${url}`, pending = queued.get(key);
      if (pending?.length) return pending.shift()();
      if (url === startEndpoint && method === "POST") return response({ jobId: saved.jobId, existing: false, fastPath: true, cachedSnapshot: true });
      if (url === statusEndpoint(saved.jobId)) return response(saved);
      if (url === endpoint("signal-snapshot-latest?mode=instant")) return response({ jobId: saved.jobId,
        latestDataDate: saved.latestDataDate, trendCoveragePct: saved.trendCoveragePct, items: saved.results });
      if (url === currentEndpoint) return response({ running: false, stale: true, resumable: false, job: stalePeriod() });
      if (/trend-analysis-latest\?mode=period&result=(full|partial)$/.test(url)) return response(period);
      throw new Error(`Unexpected fixture request: ${method} ${url}`);
    } });
  vm.runInContext(`let analysisPollTimer = null, currentJobWatchTimer = null, activeAnalysisJobId = null, activePeriodOneClick = null;
    let analysisRequestVersion = 0, analysisContext = null, analysisStatusReadVersion = 0, analysisPollInFlight = null;
    const analysisResultReadVersion = { instant: 0, period: 0 };
    const HISTORICAL_START_MAX_ATTEMPTS = 3, HISTORICAL_START_RETRY_MS = 1500, CURRENT_JOB_WATCH_INTERVAL_MS = 8000;
    let lastMarketTrendStatusLoad = 0;`, context);
  for (const name of ["escapeHtml", "formatHistoryDate", "analysisViewStamp", "beginAnalysisRequest", "isAnalysisRequestCurrent",
    "analysisInterruptionText", "displayUntrackedAnalysisJob", "inclusiveAnalysisDays", "periodSelectionMatchesJob", "analyze", "finishAnalysisControls",
    "displayCompletedAnalysis", "loadLastSuccessfulAnalysis", "pollAnalysis", "loadCurrentAnalysis"])
    vm.runInContext(extractFunction(html, name), context);
  return { context, nodes, node: getNode, requests, timers, errors, displays, saved, period,
    value: source => vm.runInContext(source, context),
    queue(url, value, method = "GET") { const key = `${method} ${url}`; if (!queued.has(key)) queued.set(key, []);
      queued.get(key).push(typeof value === "function" ? value : () => Promise.resolve(value)); },
    start(mode = "instant") { return context.beginAnalysisRequest(mode); },
    currentText: () => getNode("analysisProgressText").textContent };
}

test("old stale Period response arriving after cached Instant completion cannot replace its result or completion context", async () => {
  const rt = runtime(), delayed = deferred(), originalPeriod = JSON.stringify(rt.context.state.currentPeriodAnalysisJob);
  rt.node("periodAnalysisBody").innerHTML = "기존 기간 439건 표";
  rt.queue(currentEndpoint, () => delayed.promise);
  const oldRead = rt.context.loadCurrentAnalysis();
  await rt.context.analyze("instant");
  assert.match(rt.currentText(), /조건이 같아 저장된 최신 결과를 표시했습니다/);
  assert.match(rt.currentText(), /2026-11-01/);
  assert.match(rt.currentText(), /2026-11-02 11:48:07/);
  const completeText = rt.currentText();
  assert.equal(rt.value("activeAnalysisJobId"), null);
  assert.equal(rt.value("analysisContext.busy"), false);
  delayed.resolve(response({ running: false, stale: true, resumable: false, job: stalePeriod() }));
  await oldRead;
  assert.equal(rt.currentText(), completeText);
  await rt.context.loadCurrentAnalysis();
  assert.equal(rt.currentText(), completeText);
  assert.match(rt.node("periodPreviousJobNotice").textContent, /이전 기간 분석 중단.*재개 지점 없음/);
  assert.equal(rt.context.state.currentAnalysisJob.jobId, instantId);
  assert.equal(rt.context.state.results.length, 165);
  assert.equal(JSON.stringify(rt.context.state.currentPeriodAnalysisJob), originalPeriod);
  assert.equal(rt.node("periodAnalysisBody").innerHTML, "기존 기간 439건 표");
  assert.equal(rt.timers.size, 0);
  assert.equal(rt.node("runBtn").disabled, false);
  assert.equal(rt.node("instantRunBtn").disabled, false);
  assert.equal(rt.requests.filter(item => item.method === "POST").length, 1);
  assert.equal(rt.requests.filter(item => item.url === statusEndpoint(instantId)).length, 1);
});

test("late old polling success cannot replace a newer request or clear its busy controls", async () => {
  const rt = runtime(), delayed = deferred();
  const old = rt.start(); old.jobId = "old-running";
  rt.queue(statusEndpoint(old.jobId), () => delayed.promise);
  const oldPoll = rt.context.pollAnalysis(old.jobId, null, old);
  const newer = rt.start(); newer.jobId = "new-running";
  rt.node("analysisProgressText").textContent = "새 작업 진행 중";
  rt.node("instantRunBtn").disabled = true;
  delayed.resolve(response(complete({ jobId: old.jobId })));
  await oldPoll;
  assert.equal(rt.currentText(), "새 작업 진행 중");
  assert.equal(rt.node("instantRunBtn").disabled, true);
  assert.equal(rt.value("analysisContext.jobId"), "new-running");
  assert.equal(rt.value("analysisContext.busy"), true);
  assert.equal(rt.context.state.currentAnalysisJob.jobId, instantId);
  assert.equal(rt.timers.size, 0);
});

test("late old polling failure cannot report a false error or finish the newer request", async () => {
  const rt = runtime(), delayed = deferred(), old = rt.start(); old.jobId = "old-failure";
  rt.queue(statusEndpoint(old.jobId), () => delayed.promise);
  const oldPoll = rt.context.pollAnalysis(old.jobId, null, old);
  const newer = rt.start(); newer.jobId = "new-running";
  rt.node("analysisProgressText").textContent = "새 작업 정상 진행";
  delayed.reject(new Error("old transport failure")); await oldPoll;
  assert.equal(rt.currentText(), "새 작업 정상 진행");
  assert.equal(rt.value("analysisContext.busy"), true);
  assert.equal(rt.errors.length, 0);
});

test("two immediate recalculate clicks issue one start request and one cached-result status read", async () => {
  const rt = runtime(), delayed = deferred();
  rt.context.state.operatingSettingsLoaded = false;
  rt.context.loadOperatingSettings = () => delayed.promise;
  const first = rt.context.analyze("instant"), duplicate = rt.context.analyze("instant");
  delayed.resolve(); await Promise.all([first, duplicate]);
  assert.equal(rt.requests.filter(item => item.url === startEndpoint).length, 1);
  assert.equal(rt.requests.filter(item => item.url === statusEndpoint(instantId)).length, 1);
  assert.equal(rt.timers.size, 0);
  assert.equal(rt.value("analysisContext.busy"), false);
});

test("overlapping poll attempts for the same current Job create one request and one timer", async () => {
  const rt = runtime(), delayed = deferred(), ctx = rt.start(); ctx.jobId = "running-instant";
  rt.queue(statusEndpoint(ctx.jobId), () => delayed.promise);
  const first = rt.context.pollAnalysis(ctx.jobId, null, ctx), duplicate = rt.context.pollAnalysis(ctx.jobId, null, ctx);
  delayed.resolve(response({ jobId: ctx.jobId, mode: "instant", state: "running", currentStage: "calculation-matching",
    processedCount: 1000, totalCount: 4850, progress: 70, updatedAt: new Date().toISOString() }));
  await Promise.all([first, duplicate]);
  assert.equal(rt.requests.filter(item => item.url === statusEndpoint(ctx.jobId)).length, 1);
  assert.equal(rt.timers.size, 1);
  assert.match(rt.currentText(), /1,000 \/ 4,850/);
  assert.doesNotMatch(rt.currentText(), /기간 분석 중단/);
});

test("a real current Instant failure remains visible and restores controls and the last published 165 rows", async () => {
  const rt = runtime(), ctx = rt.start(); ctx.jobId = "failed-instant";
  rt.queue(statusEndpoint(ctx.jobId), response({ jobId: ctx.jobId, mode: "instant", state: "failed", errors: ["fixture current error"] }));
  await rt.context.pollAnalysis(ctx.jobId, null, ctx);
  assert.match(rt.currentText(), /실패.*fixture current error/);
  assert.equal(rt.errors.length, 1);
  assert.equal(rt.value("analysisContext.busy"), false);
  assert.equal(rt.node("instantRunBtn").disabled, false);
  assert.equal(rt.context.state.currentAnalysisJob.jobId, instantId);
  assert.equal(rt.context.state.results.length, 165);
});

test("an old completed-result lookup cannot render after a newer request starts", async () => {
  const rt = runtime(), delayed = deferred();
  rt.queue(endpoint("signal-snapshot-latest?mode=instant"), () => delayed.promise);
  const priorRead = rt.context.loadLastSuccessfulAnalysis("instant");
  const current = rt.start(); current.jobId = "newer-request";
  rt.node("analysisProgressText").textContent = "새 요청 계산 중";
  delayed.resolve(response({ jobId: instantId, latestDataDate: "2026-11-01", trendCoveragePct: 99, items: rt.saved.results }));
  await priorRead;
  assert.equal(rt.currentText(), "새 요청 계산 중");
  assert.equal(rt.value("analysisContext.jobId"), current.jobId);
  assert.equal(rt.displays.length, 0);
});

test("missing checkpoint never becomes resumable merely because a stale flag or cached records exist", () => {
  const rt = runtime();
  for (const job of [stalePeriod(), stalePeriod({ resumable: true, historicalCollection: true }),
    stalePeriod({ resumeEvidence: { available: false, status: "incompatible" }, calculationCursor: 2500 })]) {
    const text = rt.context.analysisInterruptionText(job, { previous: true });
    assert.doesNotMatch(text, /저장된 지점에서 재개 가능|checkpoint\/cache에서 재개 가능/);
    assert.match(text, /재개 지점 없음|재개.*확인 불가/);
  }
});

test("cachedSnapshot response cannot masquerade as a successful result when its Job is incomplete or a different mode", async () => {
  for (const mismatch of [{ state: "running" }, { mode: "period" }, { jobId: "wrong-job" }]) {
    const rt = runtime();
    rt.queue(statusEndpoint(instantId), response(complete(mismatch)));
    await rt.context.analyze("instant");
    assert.doesNotMatch(rt.currentText(), /조건이 같아 저장된 최신 결과를 표시했습니다/);
    assert.ok(rt.errors.length > 0);
    assert.equal(rt.node("instantRunBtn").disabled, false);
    assert.equal(rt.timers.size, 0);
  }
});

test("stale status JSON resolving after request replacement cannot change the new context", async () => {
  const rt = runtime(), json = deferred();
  rt.queue(currentEndpoint, { ok: true, status: 200, json: () => json.promise });
  const read = rt.context.loadCurrentAnalysis(); await turn();
  const ctx = rt.start(); ctx.jobId = "fresh-running";
  rt.node("analysisProgressText").textContent = "새 작업의 진행 안내";
  json.resolve({ running: false, stale: true, job: stalePeriod() }); await read;
  assert.equal(rt.currentText(), "새 작업의 진행 안내");
  assert.equal(rt.value("analysisContext.jobId"), ctx.jobId);
});

test("a current Instant's running status is followed, not hidden as an unrelated Period notice", async () => {
  const rt = runtime(), ctx = rt.start(); ctx.jobId = "current-instant";
  const running = { jobId: ctx.jobId, mode: "instant", state: "running", currentStage: "calculation-matching",
    processedCount: 1250, totalCount: 4850, progress: 75, updatedAt: new Date().toISOString() };
  rt.queue(currentEndpoint, response({ running: true, stale: false, job: running }));
  rt.queue(statusEndpoint(ctx.jobId), response(running));
  await rt.context.loadCurrentAnalysis(); await turn();
  assert.match(rt.currentText(), /1,250 \/ 4,850/);
  assert.doesNotMatch(rt.currentText(), /이전 기간|중단/);
  assert.equal(rt.timers.size, 1);
  assert.equal(rt.node("instantRunBtn").disabled, true);
});

test("two watcher responses for the same Job cannot regress a newer read to older stale state", async () => {
  const rt = runtime(), ctx = rt.start(), older = deferred(); ctx.jobId = "same-job";
  const running = { jobId: ctx.jobId, mode: "instant", state: "running", currentStage: "calculation-matching",
    processedCount: 2000, totalCount: 4850, progress: 78, updatedAt: new Date().toISOString() };
  rt.queue(currentEndpoint, () => older.promise);
  rt.queue(currentEndpoint, response({ running: true, stale: false, job: running }));
  rt.queue(statusEndpoint(ctx.jobId), response(running));
  const first = rt.context.loadCurrentAnalysis();
  await rt.context.loadCurrentAnalysis(); await turn();
  const newestText = rt.currentText();
  older.resolve(response({ running: false, stale: true, job: { ...running, processedCount: 0 } }));
  await first;
  assert.equal(rt.currentText(), newestText);
  assert.match(rt.currentText(), /2,000/);
  assert.equal(rt.value("analysisContext.busy"), true);
});

test("a saved-result response cannot publish its reuse message after the request has been replaced", async () => {
  const rt = runtime(), delayed = deferred();
  rt.queue(statusEndpoint(instantId), () => delayed.promise);
  const previous = rt.context.analyze("instant"); await turn();
  const newer = rt.start("period"); newer.jobId = "new-period";
  rt.node("analysisProgressText").textContent = "새 기간 요청 진행";
  delayed.resolve(response(complete())); await previous;
  assert.equal(rt.currentText(), "새 기간 요청 진행");
  assert.equal(rt.value("analysisContext.jobId"), "new-period");
  assert.equal(rt.value("analysisContext.busy"), true);
});

test("only verified checkpoint evidence permits the saved-position resume wording", () => {
  const rt = runtime();
  const text = rt.context.analysisInterruptionText(stalePeriod({
    resumeEvidence: { verified: true, status: "verified", cursor: 1750, totalCount: 4850 }
  }));
  assert.match(text, /저장된 지점에서 재개 가능/);
  assert.match(text, /1,750 \/ 4,850/);
  assert.doesNotMatch(text, /0 \/ 5,000/);
});

test("starting and polling a Period Job preserves both completed Instant rows and the prior exportable Period Job", async () => {
  const rt = runtime(), instantBefore = JSON.stringify(rt.context.state.currentAnalysisJob),
    rowsBefore = JSON.stringify(rt.context.state.results), periodBefore = JSON.stringify(rt.context.state.currentPeriodAnalysisJob);
  rt.queue(startEndpoint, response({ jobId: "new-period-running", mode: "period", existing: false, fastPath: true }), "POST");
  rt.queue(statusEndpoint("new-period-running"), response({ jobId: "new-period-running", mode: "period", state: "running",
    startDate: "2026-11-01", endDate: "2026-11-02", updatedAt: new Date().toISOString(),
    currentStage: "calculation-matching", processedCount: 500, totalCount: 4850, progress: 50 }));
  await rt.context.analyze("period");
  assert.equal(JSON.stringify(rt.context.state.currentAnalysisJob), instantBefore);
  assert.equal(JSON.stringify(rt.context.state.results), rowsBefore);
  assert.equal(JSON.stringify(rt.context.state.currentPeriodAnalysisJob), periodBefore);
  assert.match(rt.currentText(), /기간 분석 중/);
  assert.match(rt.currentText(), /500 \/ 4,850/);
  assert.equal(rt.timers.size, 1);
});

test("an incompatible existing Period start response cannot become an Instant polling target", async () => {
  const rt = runtime(), periodBefore = JSON.stringify(rt.context.state.currentPeriodAnalysisJob);
  rt.queue(startEndpoint, response({ jobId: oldPeriodId, mode: "period", existing: true, fastPath: true }), "POST");
  await rt.context.analyze("instant");
  assert.equal(rt.requests.some(item => item.url === statusEndpoint(oldPeriodId)), false);
  assert.match(rt.currentText(), /다른 종류의 작업/);
  assert.equal(rt.context.state.currentAnalysisJob.jobId, instantId);
  assert.equal(JSON.stringify(rt.context.state.currentPeriodAnalysisJob), periodBefore);
  assert.equal(rt.timers.size, 0);
  assert.equal(rt.node("instantRunBtn").disabled, false);
});

test("date edits during operating-settings loading cannot mix frozen Period context with a different request window", async () => {
  const rt = runtime(), settings = deferred();
  rt.context.state.operatingSettingsLoaded = false;
  rt.context.loadOperatingSettings = () => settings.promise;
  rt.queue(startEndpoint, response({ jobId: "frozen-period", mode: "period", fastPath: true }), "POST");
  rt.queue(statusEndpoint("frozen-period"), response({ jobId: "frozen-period", mode: "period", state: "running",
    startDate: "2026-11-01", endDate: "2026-11-02", updatedAt: new Date().toISOString(),
    currentStage: "calculation-matching", processedCount: 500, totalCount: 4850 }));
  const pending = rt.context.analyze("period");
  rt.node("collectionStart").value = "2026-10-01";
  rt.node("collectionEnd").value = "2026-10-16";
  settings.resolve(); await pending;
  const sent = rt.requests.find(item => item.url === startEndpoint).body;
  assert.equal(sent.startDate, "2026-11-01");
  assert.equal(sent.endDate, "2026-11-02");
  assert.equal(rt.value("analysisContext.startDate"), sent.startDate);
  assert.equal(rt.value("activePeriodOneClick.startDate"), sent.startDate);
  assert.equal(rt.errors.length, 0);
  assert.equal(rt.timers.size, 1);
});

test("current Period stale watcher releases only its active One-Click UI flow so the next request is not permanently blocked", async () => {
  const rt = runtime(), ctx = rt.start("period"); ctx.jobId = oldPeriodId;
  rt.value('activePeriodOneClick = { active: true, phase: "initial-fast", startDate: "2026-11-01", endDate: "2026-11-02" };');
  await rt.context.loadCurrentAnalysis();
  assert.equal(rt.value("analysisContext.busy"), false);
  assert.equal(rt.value("activePeriodOneClick"), null);
  assert.equal(rt.node("runBtn").disabled, false);
  assert.match(rt.currentText(), /기간 분석 중단 · 재개 지점 없음/);
  rt.queue(startEndpoint, response({ jobId: "next-period", mode: "period", fastPath: true }), "POST");
  rt.queue(statusEndpoint("next-period"), response({ jobId: "next-period", mode: "period", state: "running",
    startDate: "2026-11-01", endDate: "2026-11-02", updatedAt: new Date().toISOString(), currentStage: "preparing" }));
  await rt.context.analyze("period");
  assert.equal(rt.requests.filter(item => item.url === startEndpoint).length, 1);
  assert.equal(rt.value("analysisContext.jobId"), "next-period");
  assert.equal(rt.value("activePeriodOneClick.active"), true);
});

test("settings lookup rejection restores request controls and does not leave a busy UI lock", async () => {
  const rt = runtime();
  rt.context.state.operatingSettingsLoaded = false;
  rt.context.loadOperatingSettings = async () => { throw new Error("fixture settings failure"); };
  await rt.context.analyze("instant");
  assert.equal(rt.value("analysisContext.busy"), false);
  assert.equal(rt.node("instantRunBtn").disabled, false);
  assert.equal(rt.requests.filter(item => item.method === "POST").length, 0);
  assert.ok(rt.errors.length > 0);
});
