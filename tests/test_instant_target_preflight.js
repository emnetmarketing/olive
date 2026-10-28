const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const preflight = require("../netlify/functions/instant-target-preflight");
const CREATED = "2026-10-27T21:00:00.000Z";
const job = { jobId: "scheduled-fixture", mode: "instant", fastPath: false, triggerSource: "scheduled-primary",
  targetDatePreflightEnabled: true, createdAt: CREATED, targetDataDate: "2026-10-27",
  queryStartDate: "2026-09-28", endDate: "2026-10-28" };
const history = Array.from({ length: 14 }, (_, i) => ({ period: `2026-10-${String(i + 13).padStart(2, "0")}`, ratio: i + 1 }));
const entries = Array.from({ length: 20 }, (_, i) => ({ keyword: `keyword${i}`, category: "beauty", partIndex: 0, offset: i,
  compatible: false, series: history, priority: 100 - i, fetchedAt: "2026-10-26T22:00:00Z" }));

test("automatic preflight freezes five normally nonempty representatives; manual, period and client trigger flag do not enable it", () => {
  const plan = preflight.plan(job, entries);
  assert.equal(plan.samples.length, 5); assert.equal(plan.status, "pending");
  assert.equal(plan.expiresAt, "2026-10-28T15:00:00.000Z");
  for (const patch of [{ targetDatePreflightEnabled: false }, { mode: "period" }, { fastPath: true }, { triggerSource: "manual" }])
    assert.equal(preflight.plan({ ...job, ...patch }, entries), null);
  assert.equal(preflight.plan(job, entries.map(e => ({ ...e, series: [] }))).status, "no-representative-sample");
});

test("target presence must be an actual point in a compatible record, not request end or later point", () => {
  const value = preflight.plan(job, [{ ...entries[0], series: [...history, { period: "2026-10-28", ratio: 1 }], compatible: true }]);
  assert.equal(value.status, "pending");
  assert.equal(preflight.plan(job, [{ ...entries[0], series: [...history, { period: "2026-10-27", ratio: 1 }], compatible: true }]).status, "confirmed-cache");
});

test("unconfirmed sample rechecks at two-hour intervals, at most three attempts, never claims global unavailability", () => {
  let check = preflight.plan(job, entries);
  for (let n = 1; n <= 3; n++) {
    check.attempts++;
    check = preflight.observe(check, Array.from({ length: 5 }, () => ({ success: true, series: history })), check.samples,
      new Date(Date.parse(CREATED) + (n - 1) * preflight.RETRY_MS).toISOString());
    assert.equal(check.targetConfirmedKeywords, 0);
    assert.equal(check.scope, "sample-only-not-provider-wide");
    assert.equal(check.status, n < 3 ? "waiting" : "sample-target-unconfirmed");
    assert.equal(preflight.action(check, Date.parse(check.lastCheckedAt)), n < 3 ? "wait" : "defer");
  }
  assert.equal(check.nextCheckAt, null);
});

test("near-midnight checks stop at frozen observation-day deadline and preserve target", () => {
  const check = { ...preflight.plan(job, entries), attempts: 1 };
  const next = preflight.observe(check, [{ success: true, series: history }], check.samples, "2026-10-28T14:00:00Z");
  assert.equal(next.status, "sample-target-unconfirmed"); assert.equal(next.targetDataDate, "2026-10-27");
});

function harness() {
  let now = Date.parse(CREATED), calls = 0, budget = 1000, respondsWithTarget = false, revision = 0;
  let failCacheOnce = false;
  const saved = [], updates = [], blobs = new Map();
  const input = { totalCount: 20, targetDataDate: job.targetDataDate, queue: entries.map(({ keyword, category, partIndex, offset }) => ({ keyword, category, partIndex, offset })),
    targetDatePreflight: preflight.plan(job, entries), parts: ["part"] };
  const part = entries.map(e => ({ candidate: { keyword: e.keyword }, data: null, shopping: [], freshness: { state: "window-unavailable", shouldFetch: true }, trace: {} }));
  blobs.set("part", part);
  const metrics = () => ({ calls: 0, retries: 0, keywords: 0, http200: 0, http429: 0, httpOther: 0 });
  const state = { version: 1, stage: "collection", cursor: 0, parts: input.parts.slice(), responsesSaved: 0, apiMetrics: {
    searchTrend: metrics(), shoppingInsight: metrics(), news: metrics() }, targetDatePreflight: structuredClone(input.targetDatePreflight) };
  const artifacts = { readArtifact: async ref => structuredClone(blobs.get(ref)), writeArtifact: async (_, label, value) => {
    const ref = `${label}-${++revision}`; blobs.set(ref, structuredClone(value)); return ref;
  } };
  const records = new Map();
  const cacheStore = { getWithMetadata: async key => records.has(key) ? { data: records.get(key), etag: "v" } : null,
    setJSON: async (key, value) => {
      if (failCacheOnce) { failCacheOnce = false; throw new Error("fixture crash after response receipt"); }
      records.set(key, structuredClone(value)); updates.push(value); return { modified: true };
    } };
  const quota = { readUsage: async () => ({ jobs: {} }), emergencyStatus: () => ({ exists: false }),
    statusFor: () => ({ remaining: budget - calls, exhausted: false }),
    recordUsageBatch: async m => { assert.ok(m.searchTrend.calls >= 0); } };
  const root = path.resolve(__dirname, "../netlify/functions");
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const exported = { exports: {} };
  const modules = { "./instant-continuation": artifacts, "./instant-worker": { assertInstantWorker: async () => job },
    "./trend-api-quota": quota, "./blob-store-compat": { getCompatibleStore: () => cacheStore } };
  vm.runInNewContext(fs.readFileSync(path.join(root, "instant-pipeline.js"), "utf8"), {
    require: name => modules[name] || require(name.startsWith(".") ? path.join(root, name) : name),
    module: exported, process, Buffer, structuredClone, Date: Clock, console,
    setTimeout: fn => { fn(); return 0; }
  });
  const context = { job, lease: { owner: "fixture-worker" }, input, state, started: now,
    save: async () => { saved.push(structuredClone(state)); }, patch: async patch => Object.assign(job, patch), log() {},
    core: { api: async (url, options) => {
      assert.equal(url, "/search-trend/v1/search"); assert.ok(calls < budget);
      calls++; options.metrics.calls++; await options.onMetrics();
      const data = respondsWithTarget ? [...history, { period: "2026-10-27", ratio: 20 }] : history;
      options.metrics.http200++; await options.onMetrics();
      return { results: options.body.keywordGroups.map(g => ({ title: g.groupName, data })) };
    } } };
  return { state, input, blobs, saved, updates, context, pipeline: exported.exports, calls: () => calls,
    failCacheOnce() { failCacheOnce = true; },
    budget(value) { budget = value; }, target(value) { respondsWithTarget = value; },
    advance(ms) { now += ms; context.started = now; },
    collect: () => exported.exports.collect(context) };
}

test("real collect loop stores sample and waits without bulk or calculation; deferred invocation before due makes no calls", async () => {
  const f = harness(); await f.collect();
  assert.equal(f.calls(), 1); assert.equal(f.state.stage, "collection"); assert.equal(f.state.cursor, 0);
  assert.equal(f.state.targetDatePreflight.status, "waiting"); assert.equal(f.state.responsesSaved, 5);
  assert.ok(f.updates.length > 0); assert.equal(f.saved.at(-1).targetDatePreflight.status, "waiting");
  await f.collect(); assert.equal(f.calls(), 1);
});

test("real collect loop confirms second sample and reuses its five successful responses in bulk", async () => {
  const f = harness(); await f.collect(); f.advance(preflight.RETRY_MS); f.target(true); await f.collect();
  assert.equal(f.calls(), 5, "2 sample calls +3 bulk calls; successful sample keywords are not fetched a third time");
  assert.equal(f.state.stage, "numeric"); assert.equal(f.state.collectionCursor, 20);
  assert.equal(f.state.targetDatePreflight.status, "confirmed-sample");
  const final = await Promise.all(f.state.parts.map(async ref => f.blobs.get(ref)));
  assert.equal(final.flat().filter(e => e.data?.some(p => p.period === "2026-10-27")).length, 20);
});

test("zero remaining budget makes no probe or full computation and does not reset source counters", async () => {
  const f = harness(); f.budget(0); await f.collect();
  assert.equal(f.calls(), 0); assert.equal(f.state.stage, "collection");
  assert.equal(f.state.targetDatePreflight.status, "budget-limited"); assert.equal(f.state.cursor, 0);
});

test("three unconfirmed samples end bounded readiness checks without starting whole collection", async () => {
  const f = harness();
  for (let n = 0; n < 3; n++) { if (n) f.advance(preflight.RETRY_MS); await f.collect(); }
  assert.equal(f.calls(), 3); assert.equal(f.state.cursor, 0); assert.equal(f.state.stage, "collection");
  assert.equal(f.state.targetDatePreflight.status, "sample-target-unconfirmed");
});

test("checkpointed sample receipt resumes storage after interruption without another provider request", async () => {
  const f = harness(); f.failCacheOnce();
  await assert.rejects(f.collect(), /fixture crash/);
  assert.equal(f.calls(), 1); assert.ok(f.state.inflight.receipt);
  assert.equal(f.state.targetDatePreflight.attempts, 1);
  const observedAt = f.blobs.get(f.state.inflight.receipt).observedAt;
  f.advance(60 * 60 * 1000);
  await f.collect();
  assert.equal(f.calls(), 1); assert.equal(f.state.responsesSaved, 5);
  assert.equal(f.state.targetDatePreflight.status, "waiting"); assert.equal(f.state.inflight, null);
  assert.equal(f.state.targetDatePreflight.lastCheckedAt, observedAt, "receipt replay must not relabel old observation as current");
});

test("sample calls consume the same bounded allowance as main calls; partial coverage is not hidden", async () => {
  const f = harness(); f.budget(3); await f.collect();
  f.advance(preflight.RETRY_MS); f.target(true); await f.collect();
  assert.equal(f.calls(), 3); assert.equal(f.state.stage, "numeric"); assert.equal(f.state.budgetLimited, true);
  const entries = f.state.parts.flatMap(ref => f.blobs.get(ref));
  assert.equal(entries.filter(e => e.data !== null).length, 10, "two sample calls reused five +one bulk call adds five");
});

test("published self-derived tier/confirmation does not invalidate identical inputs, while source changes do", async () => {
  const f = harness(); const pipeline = f.pipeline;
  const before = [{ keyword: "same", candidateTier: "B", monthlyTotalSearches: 1000 }];
  const after = [{ ...before[0], candidateTier: "A" }];
  assert.equal(pipeline.candidateFingerprint(before), pipeline.candidateFingerprint(after));
  assert.notEqual(pipeline.candidateFingerprint(before), pipeline.candidateFingerprint([{ ...after[0], monthlyTotalSearches: 1001 }]));
  const early = [{ normalizedKeyword: "same", earlySignalDate: "2026-10-27", score: 50 }];
  assert.equal(pipeline.evidenceFingerprint(early), pipeline.evidenceFingerprint([{ ...early[0], confirmation: { confirmedAt: CREATED } }]));
  assert.notEqual(pipeline.evidenceFingerprint(early), pipeline.evidenceFingerprint([{ ...early[0], score: 51 }]));
  f.input.recoveryFingerprint = { version: 1, candidatesHash: pipeline.candidateFingerprint(before) };
  const old = f.blobs.get("part"); old[0].shopping = [{ period: "2026-10-26", ratio: 2 }];
  const observed = [{ period: "2026-10-26", ratio: 3 }];
  f.state.fingerprintShoppingOverrides = { keyword0: observed };
  const published = await pipeline.currentRecoveryFingerprint(f.input, f.state);
  const current = structuredClone(old); current[0].shopping = observed; f.blobs.set("new-part", current);
  const recovery = await pipeline.currentRecoveryFingerprint(f.input, { parts: ["new-part"] });
  assert.equal(published.sourceHash, recovery.sourceHash, "the primary's own saved Shopping response is already in its completion fingerprint");
  current[1].data = [{ period: "2026-10-27", ratio: 1 }];
  assert.notEqual(published.sourceHash, (await pipeline.currentRecoveryFingerprint(f.input, { parts: ["new-part"] })).sourceHash);
});

test("actual run keeps an unchanged published result without entering calculation or writing snapshots/pointers", async () => {
  const root = path.resolve(__dirname, "../netlify/functions");
  const { digest } = require("../netlify/functions/period-publication");
  const previousJobId = "previous-published-result";
  let current = { ...job, targetDatePreflightEnabled: false, state: "running", recoveryOfJobId: previousJobId,
    startDate: "2026-09-29", surgeThreshold: 500, matchThreshold: 70,
    calculationVersion: 1, instantInputsKey: "inputs", instantInputsHash: "fixture", instantStateRevision: 1,
    instantStage: "collection", schedulerExecutionId: "recovery-execution" };
  const entry = { candidate: { keyword: "savedkeyword" }, data: [{ period: "2026-10-27", ratio: 20 }], shopping: [],
    sourceRecord: { requestStartDate: current.queryStartDate, requestEndDate: current.endDate },
    freshness: { state: "target-confirmed", shouldFetch: false }, trace: { cacheHit: true } };
  const sourceHash = digest([digest([{ keyword: entry.candidate.keyword, data: entry.data, shopping: [],
    requestStartDate: current.queryStartDate, requestEndDate: current.endDate }])]);
  const recoveryFingerprint = { version: 1, targetDataDate: current.targetDataDate, startDate: current.startDate,
    endDate: current.endDate, queryStartDate: current.queryStartDate, surgeThreshold: 500, matchThreshold: 70,
    calculationVersion: 1, candidatesHash: digest([entry.candidate]), productHash: digest({ products: "fixture" }),
    sourceHash, evidenceHash: digest([]) };
  const input = { jobId: current.jobId, calculationVersion: 1, startDate: current.startDate, endDate: current.endDate,
    queryStartDate: current.queryStartDate, targetDataDate: current.targetDataDate, surgeThreshold: 500, matchThreshold: 70,
    totalCount: 1, numericCount: 1, ratioCount: 0, queue: [], parts: ["part"], recoveryFingerprint };
  const metrics = () => ({ calls: 0, retries: 0, keywords: 0, http200: 0, http429: 0, httpOther: 0 });
  const state = { version: 1, stage: "collection", cursor: 0, parts: ["part"], outputs: [], responsesSaved: 0,
    apiMetrics: { searchTrend: metrics(), shoppingInsight: metrics(), news: metrics() } };
  const oldResult = { jobId: previousJobId, state: "completed", publicationState: "published",
    results: [{ keyword: "savedkeyword", estimatedSurgeCount: 500 }], recoveryFingerprint };
  const untouched = structuredClone(oldResult);
  let calculationCalls = 0, publicationCalls = 0, sourceCalls = 0, pointerWrites = 0, checkpointWrites = 0;
  const schedulerUpdates = [], logs = [];
  const lease = { jobId: current.jobId, owner: "fixture-runtime", fence: 1 };
  const artifacts = { readInputs: async () => structuredClone(input), readState: async () => state,
    readArtifact: async ref => { assert.equal(ref, "part"); return [structuredClone(entry)]; },
    writeState: async (_, value) => { checkpointWrites++; assert.equal(value.stage, "numeric");
      current = { ...current, instantStateRevision: current.instantStateRevision + 1 }; return current; },
    writeArtifact: async () => { pointerWrites++; throw new Error("unchanged result must not create another result artifact"); } };
  const worker = { claimInstantWorker: async () => ({ claimed: true, job: current, lease }),
    assertInstantWorker: async () => current,
    writeOwnedInstantJob: async (_, patch) => (current = { ...current, ...patch }),
    releaseInstantWorker: async (_, patch = {}) => (current = { ...current, ...patch }) };
  const modules = { "./instant-continuation": artifacts, "./instant-worker": worker,
    "./trend-analysis-cache": { readRawJob: async id => { assert.equal(id, previousJobId); return structuredClone(oldResult); } },
    "./trend-api-quota": { readUsage: async () => ({ jobs: {} }), emergencyStatus: () => ({ exists: false }) },
    "./instant-dispatch": { registerJob: async id => assert.equal(id, current.jobId) },
    "./instant-publication": { publishInstant: async () => { publicationCalls++; throw new Error("unexpected publication"); } },
    "./trend-scheduler-execution-cache": { updateById: async (_, patch) => schedulerUpdates.push(patch) },
    "./trend-analysis-background": { _test: { api: async () => { sourceCalls++; throw new Error("unexpected source request"); } },
      calculation: { calculateNumericCandidate() { calculationCalls++; throw new Error("unexpected numeric calculation"); } } },
    "./instant-execution-budget": { runCalculationChunks: async () => { calculationCalls++; throw new Error("unexpected calculation batch"); } },
    "./blob-store-compat": { getCompatibleStore: () => ({ setJSON: async () => { pointerWrites++; throw new Error("unexpected pointer write"); } }) } };
  const exported = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, "instant-pipeline.js"), "utf8"), {
    require: name => modules[name] || require(name.startsWith(".") ? path.join(root, name) : name),
    module: exported, process, Buffer, structuredClone, Date, console: { log: text => logs.push(JSON.parse(text)) }, setTimeout
  });
  await exported.exports.run(current, { awsRequestId: "fixture-runtime" });
  assert.equal(current.state, "deferred"); assert.equal(current.outcome, "unchanged-input");
  assert.equal(current.resultJobId, previousJobId); assert.equal(current.recoveryInputComparison.unchanged, true);
  assert.equal(calculationCalls, 0); assert.equal(publicationCalls, 0); assert.equal(sourceCalls, 0); assert.equal(pointerWrites, 0);
  assert.equal(checkpointWrites, 1, "the decision preserves a durable boundary instead of inventing completed results");
  assert.equal(schedulerUpdates.at(-1).stage, "unchanged-input");
  assert.ok(logs.some(item => item.event === "instant-unchanged-result-maintained" && item.resultJobId === previousJobId));
  assert.deepEqual(oldResult, untouched);
});
