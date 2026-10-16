const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
function fixtureRuntime(overrides = {}) {
  const stores = new Map(); const modules = new Map(); let revision = 0;
  function getStore(nameOrOptions) {
    const name = typeof nameOrOptions === "string" ? nameOrOptions : nameOrOptions.name;
    if (!stores.has(name)) {
      const records = new Map();
      stores.set(name, {
        records, writes: [], fail: null,
        async get(key) { if (this.fail) this.fail("get", key); return clone(records.get(key)?.data || null); },
        async getWithMetadata(key) { if (this.fail) this.fail("get", key); return clone(records.get(key) || null); },
        async setJSON(key, value, condition = {}) {
          if (this.fail) this.fail("set", key);
          const previous = records.get(key);
          if (condition.onlyIfNew && previous || condition.onlyIfMatch && condition.onlyIfMatch !== previous?.etag) return { modified: false };
          records.set(key, { data: clone(value), etag: String(++revision) }); this.writes.push(key);
          return { modified: true };
        }
      });
    }
    return stores.get(name);
  }
  function load(file) {
    if (overrides[file]) return overrides[file];
    const absolute = path.resolve(__dirname, "../netlify/functions", file);
    if (modules.has(absolute)) return modules.get(absolute).exports;
    const module = { exports: {} }; modules.set(absolute, module);
    const wrapper = vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(absolute, "utf8")}\n})`, { filename: absolute });
    wrapper((id) => id === "@netlify/blobs" ? { connectLambda() {}, getStore }
      : id.startsWith("./") ? load(`${id.slice(2)}.js`) : require(id), module, module.exports);
    return module.exports;
  }
  return { stores, getStore, load, cache: load("trend-analysis-cache.js"), snapshots: load("signal-snapshot-cache.js"), publication: load("period-publication.js") };
}
function job(jobId, createdAt = "2026-10-16T05:22:00.000Z", partial = false) {
  return { jobId, mode: "period", state: "publishing", publicationState: "prepared", createdAt,
    updatedAt: new Date().toISOString(), startDate: "2026-10-01", endDate: "2026-10-16", queryStartDate: "2026-09-16",
    calculatedAt: "2026-10-16T06:00:00.000Z", completedAt: "2026-10-16T06:00:00.000Z",
    latestDataDate: "2026-10-15", trendCoveragePct: partial ? 80 : 100, partialAnalysis: partial,
    resultCount: 1, results: [{ keyword: "fixture-keyword", resultType: "product_match", estimatedSurgeCount: 1000,
      periodMarketConfidenceScore: 70, periodMarketConfidenceGrade: "strong", periodMarketEvidence: { youtube: { status: "no_data" } } }] };
}
function workerFixture(value = job("worker")) {
  const runtime = fixtureRuntime();
  const now = { value: Date.parse("2026-10-16T06:00:00Z") };
  const options = { store: runtime.getStore("trend-analysis"), recoveryStore: runtime.getStore("trend-period-recovery"), now: () => now.value };
  return { runtime, now, options, value: { ...value, state: "running", updatedAt: new Date(now.value).toISOString() } };
}

test("duplicate period invocations acquire only one CAS worker lease", async () => {
  const { runtime, options, value } = workerFixture(); await runtime.cache.writeJob(value.jobId, value);
  const claims = await Promise.all([runtime.cache.claimPeriodWorker(value.jobId, options), runtime.cache.claimPeriodWorker(value.jobId, options)]);
  assert.equal(claims.filter(item => item.claimed).length, 1);
  assert.equal(claims.find(item => !item.claimed).reason, "worker-active");
});

test("expired period worker cannot overwrite a newer claimant's progress or checkpoint", async () => {
  const { runtime, options, now, value } = workerFixture(); await runtime.cache.writeJob(value.jobId, value);
  const first = await runtime.cache.claimPeriodWorker(value.jobId, options);
  now.value += runtime.cache.PERIOD_WORKER_LEASE_MS + 1;
  const second = await runtime.cache.claimPeriodWorker(value.jobId, options);
  assert.equal(second.lease.fence, first.lease.fence + 1);
  await runtime.cache.writeOwnedPeriodJob(second.lease, { processedCount: 1000 }, options);
  await assert.rejects(runtime.cache.writeOwnedPeriodJob(first.lease, { processedCount: 0 }, options), { code: "PERIOD_WORKER_LOST" });
  await assert.rejects(runtime.cache.writePeriodCheckpoint(first.lease, { calculationCursor: 500 }, options), { code: "PERIOD_WORKER_LOST" });
  assert.equal((await runtime.cache.readRawJob(value.jobId)).processedCount, 1000);
});

test("continuation handoff releases one owner and prevents its late catch from failing the new owner", async () => {
  const { runtime, options, value } = workerFixture(); await runtime.cache.writeJob(value.jobId, value);
  const first = await runtime.cache.claimPeriodWorker(value.jobId, options);
  await runtime.cache.releasePeriodWorker(first.lease, { continuationCount: 1 }, options);
  const next = await runtime.cache.claimPeriodWorker(value.jobId, options);
  assert.equal(next.claimed, true);
  await assert.rejects(runtime.cache.writeOwnedPeriodJob(first.lease, { state: "failed" }, options), { code: "PERIOD_WORKER_LOST" });
  await assert.rejects(runtime.cache.writeJob(value.jobId, { ...value, state: "failed" }), { code: "PERIOD_WORKER_REQUIRED" });
  assert.equal((await runtime.cache.readRawJob(value.jobId)).workerLease.token, next.lease.token);
});

test("period checkpoints are immutable job-specific references, survive handoff, and reject cursor regression", async () => {
  const { runtime, options, value } = workerFixture(); await runtime.cache.writeJob(value.jobId, value);
  const first = await runtime.cache.claimPeriodWorker(value.jobId, options);
  const checkpoint = { jobId: value.jobId, calculationCursor: 1000, totalCount: 4850, rows: value.results };
  const saved = await runtime.cache.writePeriodCheckpoint(first.lease, checkpoint, options);
  assert.match(saved.calculationCheckpointKey, /^jobs\/worker\/checkpoints\/1000-/);
  assert.deepEqual(await runtime.cache.readPeriodCheckpoint(saved, options), checkpoint);
  await runtime.cache.releasePeriodWorker(first.lease, {}, options);
  const second = await runtime.cache.claimPeriodWorker(value.jobId, options);
  assert.deepEqual(await runtime.cache.readPeriodCheckpoint(second.job, options), checkpoint);
  await assert.rejects(runtime.cache.writePeriodCheckpoint(second.lease, { ...checkpoint, calculationCursor: 500 }, options), { code: "PERIOD_CURSOR_REGRESSION" });
  assert.equal((await runtime.cache.readRawJob(value.jobId)).calculationCheckpointKey, saved.calculationCheckpointKey);
  options.store.records.get(saved.calculationCheckpointKey).data.rows[0].keyword = "corrupt";
  await assert.rejects(runtime.cache.readPeriodCheckpoint(saved, options), { code: "PERIOD_ARTIFACT_INTEGRITY" });
});

test("frozen period inputs cannot silently change when current candidates or products rotate", async () => {
  const { runtime, options, value } = workerFixture(); await runtime.cache.writeJob(value.jobId, value);
  const first = await runtime.cache.claimPeriodWorker(value.jobId, options);
  const inputs = { candidates: [{ keyword: "original" }], products: [{ product: "original-product" }], early: { history: [] } };
  const frozen = await runtime.cache.writePeriodInputs(first.lease, inputs, options);
  const reused = await runtime.cache.writePeriodInputs(first.lease, { candidates: [{ keyword: "new" }] }, options);
  assert.equal(reused.periodInputsKey, frozen.periodInputsKey);
  assert.deepEqual(await runtime.cache.readPeriodInputs(reused, options), inputs);
  await assert.rejects(runtime.cache.writeOwnedPeriodJob(first.lease, { periodInputsKey: "other" }, options), { code: "PERIOD_INPUTS_CHANGED" });
});

test("period checkpoint storage finishing after lease expiry preserves the prior reference", async () => {
  const { runtime, options, now, value } = workerFixture(); await runtime.cache.writeJob(value.jobId, value);
  const first = await runtime.cache.claimPeriodWorker(value.jobId, options);
  const initial = { jobId: value.jobId, calculationCursor: 1000, totalCount: 4850, rows: value.results };
  const saved = await runtime.cache.writePeriodCheckpoint(first.lease, initial, options);
  options.store.fail = (operation, key) => {
    if (operation === "set" && key.includes("/checkpoints/2000-")) now.value += runtime.cache.PERIOD_WORKER_LEASE_MS + 1;
  };
  await assert.rejects(runtime.cache.writePeriodCheckpoint(first.lease, { ...initial, calculationCursor: 2000 }, options), { code: "PERIOD_WORKER_LOST" });
  const raw = await runtime.cache.readRawJob(value.jobId);
  assert.equal(raw.calculationCheckpointKey, saved.calculationCheckpointKey);
  assert.equal(raw.calculationCursor, 1000);
  assert.deepEqual(await runtime.cache.readPeriodCheckpoint(raw, options), initial);
});

test("period checkpoint rejects a different Job or window before saving artifacts", async () => {
  const { runtime, options, value } = workerFixture(); await runtime.cache.writeJob(value.jobId, value);
  const first = await runtime.cache.claimPeriodWorker(value.jobId, options);
  for (const extra of [{ jobId: "another-job" }, { requiredWindow: "2026-01-01:2026-01-31" }])
    await assert.rejects(runtime.cache.writePeriodCheckpoint(first.lease, { jobId: value.jobId, calculationCursor: 10, totalCount: 50, ...extra }, options), { code: "PERIOD_CHECKPOINT_IDENTITY" });
  assert.equal(options.store.writes.filter(key => key.includes("/checkpoints/")).length, 0);
});

test("recovery fence blocks a live normal period worker's writes and future claims", async () => {
  const { runtime, options, value } = workerFixture(); await runtime.cache.writeJob(value.jobId, value);
  const first = await runtime.cache.claimPeriodWorker(value.jobId, options);
  await options.recoveryStore.setJSON(`jobs/${value.jobId}/control-v1`, { jobId: value.jobId, generation: Date.now() });
  await assert.rejects(runtime.cache.writeOwnedPeriodJob(first.lease, { processedCount: 1000 }, options), { code: "PERIOD_WORKER_LOST" });
  assert.equal((await runtime.cache.claimPeriodWorker(value.jobId, options)).reason, "recovery-fenced");
});

test("stale cleanup cannot mark a newly progressed period worker failed from an old read", async () => {
  const runtime = fixtureRuntime(); const value = { ...job("stale-race"), state: "running",
    updatedAt: new Date(Date.now() - 2 * runtime.cache.STALE_JOB_MS).toISOString() };
  await runtime.cache.writeJob(value.jobId, value);
  const blobStore = runtime.getStore("trend-analysis");
  await blobStore.setJSON(runtime.cache.CURRENT_JOB_KEY, { jobId: value.jobId });
  const originalRead = blobStore.getWithMetadata;
  blobStore.getWithMetadata = async function (key) {
    if (key === `jobs/${value.jobId}`) {
      blobStore.records.get(key).data.updatedAt = new Date().toISOString();
      blobStore.records.get(key).data.processedCount = 1500;
    }
    return originalRead.call(this, key);
  };
  const current = await runtime.cache.readCurrentJob({ markStale: true });
  assert.equal(current.state, "running");
  assert.equal(current.processedCount, 1500);
  assert.equal((await runtime.cache.readRawJob(value.jobId)).state, "running");
});

test("new period publication requires the current worker token, not only a running Job flag", async () => {
  const { runtime, options, value } = workerFixture(); await runtime.cache.writeJob(value.jobId, value);
  const first = await runtime.cache.claimPeriodWorker(value.jobId, options);
  const ready = await runtime.cache.writeOwnedPeriodJob(first.lease, { state: "publishing" }, options);
  const snapshot = runtime.snapshots.buildSnapshot(ready);
  await assert.rejects(runtime.cache.publishCompletedPeriod(ready, snapshot), { code: "PERIOD_LEASE_LOST" });
  const result = await runtime.cache.publishCompletedPeriod(ready, snapshot, { lease: first.lease, now: options.now });
  assert.equal(result.job.state, "completed");
});

test("publication-only retry after canonical receipt failure can claim a new lease without recalculation", async () => {
  const { runtime, options, value } = workerFixture(); await runtime.cache.writeJob(value.jobId, value);
  const first = await runtime.cache.claimPeriodWorker(value.jobId, options);
  const ready = await runtime.cache.writeOwnedPeriodJob(first.lease, { state: "publishing" }, options);
  const publication = runtime.getStore("trend-period-publications"); let fail = true;
  publication.fail = (operation, key) => { if (fail && operation === "set" && key.startsWith("published-jobs/")) throw new Error("receipt failure"); };
  await assert.rejects(runtime.cache.publishCompletedPeriod(ready, runtime.snapshots.buildSnapshot(ready), { lease: first.lease, now: options.now }), /receipt failure/);
  await runtime.cache.releasePeriodWorker(first.lease, { state: "publication_failed", errors: ["receipt failure"] }, options);
  const retry = await runtime.cache.claimPeriodWorker(value.jobId, options); fail = false;
  const beforePrepared = publication.writes.filter(key => key.startsWith("prepared/")).length;
  const result = await runtime.cache.publishCompletedPeriod(retry.job, runtime.snapshots.buildSnapshot(retry.job), { lease: retry.lease, now: options.now });
  assert.equal(result.job.state, "completed");
  assert.deepEqual(result.job.results, value.results);
  assert.equal(publication.writes.filter(key => key.startsWith("prepared/")).length, beforePrepared);
});

function backgroundFixture({ chunkSize = 1, historical = false } = {}) {
  const sourceReads = { candidates: 0, products: 0, series: 0, early: 0 };
  const quotaWrites = [];
  const quotaInvocations = new Map();
  const candidates = ["라카트윈립", "메디힐비타민씨세럼", "제로이드포밍클렌저"].map(keyword => ({
    keyword, category: "beauty", monthlyTotalSearches: 120000, sources: ["keywordstool"],
    firstSeenAt: "2026-09-01T00:00:00Z", priorityScore: 50, monthlyVolumeStatus: "available" }));
  const products = [{ product: "라카 퍼펙트 트윈 립 4.7g", account: "fixture" },
    { product: "메디힐 비타민씨 세럼", brand: "메디힐", account: "fixture" },
    { product: "제로이드 포밍 클렌저 200ml", brand: "제로이드", account: "fixture" }];
  const normalize = require("../netlify/functions/trend-series-cache").normalizedKeyword;
  const series = Array.from({ length: 31 }, (_, index) => ({
    period: new Date(Date.UTC(2026, 8, 16 + index)).toISOString().slice(0, 10), ratio: index < 28 ? 1 : 15 }));
  const entries = new Map(candidates.map(candidate => [normalize(candidate.keyword), {
    requestStartDate: "2026-09-16", requestEndDate: "2026-10-16", rawRatioSeries: series, fetchedAt: "2026-10-16T05:00:00Z" }]));
  if (historical) entries.clear();
  const continuation = require("../netlify/functions/historical-continuation");
  const deniedWrite = async () => { throw new Error("Unexpected provider/instant cache mutation"); };
  const runtime = fixtureRuntime({
    "keyword-candidate-cache.js": { readCandidateCache: async () => { sourceReads.candidates++; return { candidates: clone(candidates) }; } },
    "market-discovery-cache.js": { readCache: async () => ({ items: [] }) },
    "search-ad-cache.js": { readCache: async () => { sourceReads.products++; return { items: clone(products) }; } },
    "trend-series-cache.js": { connect() {}, normalizedKeyword: normalize,
      assessSearchFreshness: require("../netlify/functions/trend-series-cache").assessSearchFreshness,
      summarizeDateCoverage: require("../netlify/functions/trend-series-cache").summarizeDateCoverage,
      readCache: async () => { sourceReads.series++; return { entries: new Map(entries) }; },
      lookup(map, keyword, source) { const record = map.get(normalize(keyword)); return source === "search" && record
        ? { state: "hit", record, series: record.rawRatioSeries } : { state: "miss", record: null }; },
      upsert: historical ? (map, input) => { const key = normalize(input.keyword); map.set(key, {
        requestStartDate: input.startDate, requestEndDate: input.endDate, rawRatioSeries: input.series, fetchedAt: input.fetchedAt }); return key; } : deniedWrite,
      writeDirty: historical ? async () => {} : deniedWrite },
    "trend-api-quota.js": { connect() {}, readUsage: async () => ({}), recordUsageBatch: historical ? async (metrics, options) => {
      const previous = quotaInvocations.get(options.invocationId) || {};
      quotaWrites.push(require("../netlify/functions/trend-api-quota").cumulativeDelta(metrics, previous));
      quotaInvocations.set(options.invocationId, { ...previous, ...clone(metrics) });
    } : deniedWrite,
      statusFor: () => ({ exhausted: false, remaining: 1000, monthlyRemaining: 20000 }), historicalRemaining: () => ({ remaining: 1000 }) },
    "today-early-signal-cache.js": { readCache: async () => { sourceReads.early++; return { history: [], items: [] }; },
      writeCache: deniedWrite, confirmSignals: deniedWrite },
    "market-discovery-history-cache.js": { readHistory: async () => ({ records: new Map() }), writeHistory: deniedWrite,
      mergeSignalHistory: deniedWrite, mergeEarlySignalHistory: deniedWrite },
    "historical-continuation.js": { ...continuation,
      shouldContinue: ({ cursor, invocationStartCursor, totalCount }) => cursor < totalCount && cursor - invocationStartCursor >= chunkSize },
  });
  return { runtime, sourceReads, candidates, products, entries, historical, series, quotaWrites };
}

async function runBackgroundFixture(fixture, id) {
  const { runtime } = fixture;
  const value = { ...job(id), state: "running", currentStage: "preparing", fastPath: !fixture.historical, historicalCollection: fixture.historical,
    startDate: "2026-10-14", endDate: "2026-10-16", queryStartDate: "2026-09-16", surgeThreshold: 300, matchThreshold: 40 };
  delete value.results; delete value.completedAt; delete value.resultCount;
  await runtime.cache.writeJob(id, value);
  const background = runtime.load("trend-analysis-background.js");
  const queue = [id]; const calls = []; const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push(String(url));
    if (fixture.historical && String(url).endsWith("/search-trend/v1/search")) return { ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ results: JSON.parse(options.body).keywordGroups.map(group => ({ title: group.groupName, data: fixture.series })) }) };
    assert.match(String(url), /\/\.netlify\/functions\/trend-analysis-background$/);
    queue.push(JSON.parse(options.body).jobId); return { ok: true, status: 202 };
  };
  let invocations = 0;
  try {
    while (queue.length) {
      assert.ok(++invocations <= 10, "continuation must be bounded");
      await background.handler({ body: JSON.stringify({ jobId: queue.shift() }) }, { awsRequestId: `${id}-${invocations}` });
      // A live source rotation between invocations must not affect the frozen
      // generation or produce additional source-cache reads.
      if (invocations === 1) { fixture.candidates.length = 0; fixture.products.length = 0; fixture.entries.clear(); }
    }
  } finally { global.fetch = originalFetch; }
  return { job: await runtime.cache.readJob(id), raw: await runtime.cache.readRawJob(id), invocations, calls };
}

test("cache-only Period background freezes inputs and continues from checkpoints with unchanged final results", async () => {
  const chunkedFixture = backgroundFixture({ chunkSize: 1 });
  const chunked = await runBackgroundFixture(chunkedFixture, "chunked-period");
  assert.equal(chunked.job.state, "completed", JSON.stringify(chunked.raw.errors));
  assert.equal(chunked.job.trendCoveragePct, 100);
  assert.ok(chunked.job.results.length > 0);
  assert.ok(chunked.invocations >= 4);
  assert.equal(chunked.raw.calculationCursor, 3);
  assert.deepEqual(chunkedFixture.sourceReads, { candidates: 1, products: 1, series: 1, early: 1 });
  const single = await runBackgroundFixture(backgroundFixture({ chunkSize: 1000 }), "single-period");
  assert.equal(single.job.state, "completed", JSON.stringify(single.raw.errors));
  assert.deepEqual(chunked.job.results, single.job.results);
  assert.equal(chunked.job.searchTrendApiCallCount, 0);
  assert.equal(chunked.job.shoppingInsightApiCallCount, 0);
});

test("saved Period publishing body takes publication-only background branch before any source-cache reads", async () => {
  const fixture = backgroundFixture(); const value = { ...job("publish-only"), currentStage: "publishing" };
  await fixture.runtime.cache.writeJob(value.jobId, value);
  const originalFetch = global.fetch; global.fetch = async () => { throw new Error("No API or continuation required"); };
  try { await fixture.runtime.load("trend-analysis-background.js").handler({ body: JSON.stringify({ jobId: value.jobId }) }); }
  finally { global.fetch = originalFetch; }
  const result = await fixture.runtime.cache.readJob(value.jobId);
  assert.equal(result.state, "completed");
  assert.deepEqual(result.results, value.results);
  assert.deepEqual(fixture.sourceReads, { candidates: 0, products: 0, series: 0, early: 0 });
});

test("collection HTTP counters survive later cache-only continuations without double charging quota", async () => {
  const oldId = process.env.NAVER_CLIENT_ID; const oldSecret = process.env.NAVER_CLIENT_SECRET;
  process.env.NAVER_CLIENT_ID = "mock-only"; process.env.NAVER_CLIENT_SECRET = "mock-only";
  const fixture = backgroundFixture({ chunkSize: 1, historical: true });
  try {
    const result = await runBackgroundFixture(fixture, "historical-metrics");
    assert.equal(result.job.state, "completed", JSON.stringify(result.raw.errors));
    assert.equal(result.job.searchTrendApiCallCount, 1);
    assert.equal(result.job.searchTrendHttp200Count, 1);
    assert.equal(result.job.searchTrendHttp429Count, 0);
    assert.equal(result.job.historicalRequiredCalls, 1);
    assert.equal(result.calls.filter(url => url.endsWith("/search-trend/v1/search")).length, 1);
    assert.equal(fixture.quotaWrites.reduce((sum, delta) => sum + Number(delta.searchTrend?.calls || 0), 0), 1);
    assert.equal(result.job.trendCoveragePct, 100);
  } finally {
    if (oldId === undefined) delete process.env.NAVER_CLIENT_ID; else process.env.NAVER_CLIENT_ID = oldId;
    if (oldSecret === undefined) delete process.env.NAVER_CLIENT_SECRET; else process.env.NAVER_CLIENT_SECRET = oldSecret;
  }
});

test("background retries a missing exact-Job receipt even when canonical reads already report completed", async () => {
  const fixture = backgroundFixture(); const value = { ...job("receipt-background"), currentStage: "publishing" };
  const { runtime } = fixture; await runtime.cache.writeJob(value.jobId, value);
  const publication = runtime.getStore("trend-period-publications"); let fail = true;
  publication.fail = (operation, key) => { if (fail && operation === "set" && key.startsWith("published-jobs/")) throw new Error("receipt failure"); };
  const originalFetch = global.fetch; global.fetch = async () => { throw new Error("No provider calls for publication repair"); };
  try {
    const background = runtime.load("trend-analysis-background.js");
    await background.handler({ body: JSON.stringify({ jobId: value.jobId }) });
    assert.equal((await runtime.cache.readJob(value.jobId)).state, "completed");
    assert.equal((await runtime.cache.readRawJob(value.jobId)).state, "publication_failed");
    fail = false;
    await background.handler({ body: JSON.stringify({ jobId: value.jobId }) });
  } finally { global.fetch = originalFetch; }
  assert.ok(publication.records.get(`published-jobs/${value.jobId}`), "verified publication must retain an exact-Job receipt");
  assert.equal((await runtime.cache.readRawJob(value.jobId)).state, "completed");
  assert.deepEqual(fixture.sourceReads, { candidates: 0, products: 0, series: 0, early: 0 });
});
async function seedLegacy(runtime, value) {
  const completed = { ...value, state: "completed" };
  await runtime.cache.writeJob(completed.jobId, completed);
  if (completed.partialAnalysis) await runtime.cache.writeLastPartial(completed);
  else await runtime.cache.writeLastSuccess(completed);
  await runtime.snapshots.writeSnapshot(completed);
  return completed;
}
async function publish(runtime, value) {
  await runtime.cache.writeJob(value.jobId, value);
  return runtime.cache.publishCompletedPeriod(value, runtime.snapshots.buildSnapshot(value));
}

test("legacy period and instant reads remain available before the publication store exists", async () => {
  const runtime = fixtureRuntime(); const period = await seedLegacy(runtime, job("legacy-period"));
  const instant = await seedLegacy(runtime, { ...job("legacy-instant"), mode: "instant" });
  assert.equal((await runtime.cache.readLastSuccess("period")).jobId, period.jobId);
  assert.equal((await runtime.snapshots.readLatest("period")).jobId, period.jobId);
  assert.equal((await runtime.cache.readLastSuccess("instant")).jobId, instant.jobId);
  assert.equal((await runtime.snapshots.readLatest("instant")).jobId, instant.jobId);
});

test("normal period helper publishes once and all exact/latest readers agree on that Job", async () => {
  const runtime = fixtureRuntime(); const value = job("current-period");
  const result = await publish(runtime, value);
  assert.equal(result.commit.generation, Date.parse(value.createdAt));
  assert.equal((await runtime.cache.readJob(value.jobId)).state, "completed");
  assert.equal((await runtime.cache.readLastSuccess("period")).jobId, value.jobId);
  assert.equal((await runtime.snapshots.readLatest("period")).jobId, value.jobId);
  assert.equal((await runtime.snapshots.readLatestAnalysis("period")).jobId, value.jobId);
  assert.deepEqual((await runtime.cache.readJob(value.jobId)).results, value.results);
  assert.equal(runtime.getStore("trend-analysis").records.get(`jobs/${value.jobId}`).data.state, "publishing");
});

test("failed preparation keeps raw Job publishing and all latest readers on earlier valid result", async () => {
  const runtime = fixtureRuntime(); await seedLegacy(runtime, job("previous", "2026-10-15T05:00:00Z"));
  const value = job("next"); await runtime.cache.writeJob(value.jobId, value);
  runtime.getStore("trend-period-publications").fail = (op, key) => {
    if (op === "set" && key.includes("snapshot-")) throw new Error("injected storage failure");
  };
  await assert.rejects(runtime.cache.publishCompletedPeriod(value, runtime.snapshots.buildSnapshot(value)), /injected storage failure/);
  assert.equal((await runtime.cache.readJob("next")).state, "publishing");
  assert.equal((await runtime.cache.readLastSuccess("period")).jobId, "previous");
  assert.equal((await runtime.snapshots.readLatest("period")).jobId, "previous");
});

test("publishing Job retains the analysis lock until verified canonical publication", async () => {
  const runtime = fixtureRuntime(); const value = job("active-publishing");
  await runtime.cache.writeJob(value.jobId, value);
  await runtime.getStore("trend-analysis").setJSON(runtime.cache.CURRENT_JOB_KEY, { jobId: value.jobId });
  assert.equal((await runtime.cache.readCurrentJob()).jobId, value.jobId);
  assert.equal((await runtime.cache.acquireJob({ mode: "period" })).existing, true);
  await runtime.cache.publishCompletedPeriod(value, runtime.snapshots.buildSnapshot(value));
  assert.equal(await runtime.cache.readCurrentJob(), null);
});

test("partial canonical period uses the partial reader and never the instant reader", async () => {
  const runtime = fixtureRuntime(); await seedLegacy(runtime, { ...job("instant"), mode: "instant" });
  await publish(runtime, job("partial-period", undefined, true));
  assert.equal((await runtime.cache.readLastPartial("period")).jobId, "partial-period");
  assert.equal(await runtime.cache.readLastSuccess("period"), null);
  assert.equal((await runtime.cache.readLastSuccess("instant")).jobId, "instant");
  assert.equal((await runtime.snapshots.readLatest("instant")).jobId, "instant");
});

test("normal publication never mutates legacy/global/instant pointers", async () => {
  const runtime = fixtureRuntime(); await seedLegacy(runtime, { ...job("instant"), mode: "instant" });
  const beforeAnalysis = clone([...runtime.getStore("trend-analysis").records]);
  const beforeSnapshots = clone([...runtime.getStore("trend-signal-snapshots").records]);
  await publish(runtime, job("period"));
  const filteredAnalysis = [...runtime.getStore("trend-analysis").records].filter(([key]) => key !== "jobs/period");
  assert.deepEqual(clone(filteredAnalysis), beforeAnalysis);
  assert.deepEqual(clone([...runtime.getStore("trend-signal-snapshots").records]), beforeSnapshots);
});

test("recovery fence prevents an old normal worker from publishing even with complete rows", async () => {
  const runtime = fixtureRuntime(); const value = job("fenced");
  await runtime.cache.writeJob(value.jobId, value);
  await runtime.getStore("trend-period-recovery").setJSON(`jobs/${value.jobId}/control-v1`, { generation: Date.now(), state: "running" });
  await assert.rejects(runtime.cache.publishCompletedPeriod(value, runtime.snapshots.buildSnapshot(value)), { code: "PERIOD_LEASE_LOST" });
  assert.equal(runtime.getStore("trend-period-publications").writes.length, 0);
});

test("interrupted or failed raw Job cannot publish from stale in-memory results", async () => {
  for (const state of ["interrupted", "failed", "continuation_failed"]) {
    const runtime = fixtureRuntime(); const value = job(`stopped-${state}`);
    await runtime.cache.writeJob(value.jobId, { ...value, state });
    await assert.rejects(runtime.cache.publishCompletedPeriod(value, runtime.snapshots.buildSnapshot(value)), { code: "PERIOD_LEASE_LOST" });
  }
});

test("newer legacy period result is not frozen out by an older canonical result", async () => {
  const runtime = fixtureRuntime(); await publish(runtime, job("canonical-old", "2026-10-14T05:00:00Z"));
  await seedLegacy(runtime, job("legacy-new", "2026-10-16T05:00:00Z"));
  assert.equal((await runtime.cache.readLastSuccess("period")).jobId, "legacy-new");
  assert.equal((await runtime.snapshots.readLatest("period")).jobId, "legacy-new");
});

test("late completion of older legacy Job cannot displace newer canonical generation", async () => {
  const runtime = fixtureRuntime(); await publish(runtime, job("canonical-new", "2026-10-16T05:00:00Z"));
  await seedLegacy(runtime, { ...job("legacy-old", "2026-10-14T05:00:00Z"), completedAt: "2026-10-17T12:00:00Z" });
  assert.equal((await runtime.cache.readLastSuccess("period")).jobId, "canonical-new");
  assert.equal((await runtime.snapshots.readLatest("period")).jobId, "canonical-new");
});

test("legacy snapshots without createdAt compare the original Job creation generation", async () => {
  const runtime = fixtureRuntime(); await publish(runtime, job("canonical", "2026-10-16T05:00:00Z"));
  const legacy = await seedLegacy(runtime, { ...job("old", "2026-10-14T05:00:00Z"), completedAt: "2026-10-17T12:00:00Z" });
  const records = runtime.getStore("trend-signal-snapshots").records;
  delete records.get(`snapshots/${legacy.jobId}`).data.createdAt;
  assert.equal((await runtime.snapshots.readLatest("period")).jobId, "canonical");
});

test("canonical integrity failures propagate instead of falsely reporting an older completed body", async () => {
  const runtime = fixtureRuntime(); await seedLegacy(runtime, job("legacy", "2026-10-14T05:00:00Z"));
  const result = await publish(runtime, job("canonical"));
  runtime.getStore("trend-period-publications").records.get(result.commit.bodyKey).data.results[0].keyword = "corrupt";
  await assert.rejects(runtime.cache.readJob("canonical"), { code: "PERIOD_PUBLICATION_INTEGRITY" });
  await assert.rejects(runtime.cache.readLastSuccess("period"), { code: "PERIOD_PUBLICATION_INTEGRITY" });
  await assert.rejects(runtime.snapshots.readLatest("period"), { code: "PERIOD_PUBLICATION_INTEGRITY" });
});

test("period readers cannot fall back to instant when no period publication exists", async () => {
  const runtime = fixtureRuntime(); await seedLegacy(runtime, { ...job("only-instant"), mode: "instant" });
  assert.equal(await runtime.cache.readLastSuccess("period"), null);
  assert.equal(await runtime.snapshots.readLatest("period"), null);
});

test("canonical exact Job remains available for Excel after a newer period is published", async () => {
  const runtime = fixtureRuntime(); const first = job("excel-first", "2026-10-15T05:00:00Z");
  await publish(runtime, first); await publish(runtime, job("second"));
  assert.equal((await runtime.cache.readLastSuccess("period")).jobId, "second");
  assert.deepEqual((await runtime.cache.readJob("excel-first")).results, first.results);
});

test("recovery status is a read-only overlay and published results take precedence", async () => {
  const runtime = fixtureRuntime(); const value = { ...job("recovering-target"), state: "interrupted" };
  await runtime.cache.writeJob(value.jobId, value);
  const recovery = runtime.getStore("trend-period-recovery");
  await recovery.setJSON(`jobs/${value.jobId}/control-v1`, { jobId: value.jobId, generation: "recovery-epoch",
    stage: "numeric", status: "running", calculationCursor: 4100, ratioCursor: 0, evidenceCursor: 0,
    totalCount: 4850, updatedAt: new Date().toISOString(), resumable: true });
  const writes = recovery.writes.length;
  const overlay = await runtime.cache.readJob(value.jobId);
  assert.equal(overlay.state, "recovering"); assert.equal(overlay.processedCount, 4100); assert.equal(overlay.totalCount, 4850);
  assert.equal((await runtime.cache.readRawJob(value.jobId)).state, "interrupted");
  assert.equal(recovery.writes.length, writes);
  await runtime.publication.publishPeriod({ job: value, snapshot: runtime.snapshots.buildSnapshot(value), generation: Date.now() }, { assertLease: async () => true });
  assert.equal((await runtime.cache.readJob(value.jobId)).state, "completed");
});

test("stale recovery status reads cannot mark the original Job failed", async () => {
  const runtime = fixtureRuntime(); const value = { ...job("old-recovery"), state: "interrupted" };
  await runtime.cache.writeJob(value.jobId, value);
  await runtime.getStore("trend-analysis").setJSON(runtime.cache.CURRENT_JOB_KEY, { jobId: value.jobId });
  await runtime.getStore("trend-period-recovery").setJSON(`jobs/${value.jobId}/control-v1`, { jobId: value.jobId,
    stage: "numeric", status: "running", calculationCursor: 4100, updatedAt: "2020-01-01T00:00:00Z" });
  const writes = runtime.getStore("trend-analysis").writes.length;
  assert.equal(await runtime.cache.readCurrentJob({ markStale: true }), null);
  assert.equal((await runtime.cache.readRawJob(value.jobId)).state, "interrupted");
  assert.equal(runtime.getStore("trend-analysis").writes.length, writes);
});

test("future full and partial canonical publications retain independent last-result readers", async () => {
  const runtime = fixtureRuntime();
  const full = job("canonical-full", "2026-10-15T05:00:00Z");
  const partial = job("canonical-partial", "2026-10-16T05:00:00Z", true);
  await publish(runtime, full); await publish(runtime, partial);
  assert.equal((await runtime.cache.readLastSuccess("period")).jobId, full.jobId);
  assert.equal((await runtime.cache.readLastPartial("period")).jobId, partial.jobId);
  assert.equal((await runtime.snapshots.readLatest("period")).jobId, partial.jobId);
  const newerFull = job("newer-full", "2026-10-17T05:00:00Z");
  await publish(runtime, newerFull);
  assert.equal((await runtime.cache.readLastSuccess("period")).jobId, newerFull.jobId);
  assert.equal((await runtime.cache.readLastPartial("period")).jobId, partial.jobId);
  assert.deepEqual((await runtime.cache.readJob(full.jobId)).results, full.results);
});

test("zero-coverage period keeps canonical latest-valid while latest analysis reports the new zero result", async () => {
  const runtime = fixtureRuntime();
  const valid = job("valid-partial", "2026-10-15T05:00:00Z", true);
  await publish(runtime, valid);
  const zero = { ...job("zero-partial", "2026-10-16T05:00:00Z", true),
    latestDataDate: null, trendCoveragePct: 0, results: [], resultCount: 0 };
  await publish(runtime, zero);
  assert.equal((await runtime.snapshots.readLatest("period")).jobId, valid.jobId);
  assert.equal((await runtime.snapshots.readLatestAnalysis("period")).jobId, zero.jobId);
  assert.equal((await runtime.cache.readLastPartial("period")).jobId, zero.jobId);
  assert.equal((await runtime.cache.readJob(zero.jobId)).resultCount, 0);
  assert.deepEqual((await runtime.cache.readJob(valid.jobId)).results, valid.results);
  assert.equal(await runtime.snapshots.readLatest("instant"), null);
});

test("publication retry after post-commit failure uses committed payload despite mutable failed Job status", async () => {
  const runtime = fixtureRuntime(); const value = job("receipt-retry");
  await runtime.cache.writeJob(value.jobId, value);
  const publicationStore = runtime.getStore("trend-period-publications");
  publicationStore.fail = (op, key) => {
    if (op === "set" && key === runtime.publication.receiptKey(value.jobId)) throw Error("receipt unavailable");
  };
  await assert.rejects(runtime.cache.publishCompletedPeriod(value, runtime.snapshots.buildSnapshot(value)), /receipt unavailable/);
  // Mirrors the background catch: calculated rows survive but failure metadata
  // changes after the canonical commit has already succeeded.
  const failed = { ...value, state: "publication_failed", publicationState: "pending", resumable: true,
    failedAt: "2026-10-16T07:01:00Z", updatedAt: "2026-10-16T07:01:00Z", message: "게시 재시도 필요", errors: ["receipt unavailable"] };
  await runtime.cache.writeJob(failed.jobId, failed);
  publicationStore.fail = null;
  const result = await runtime.cache.publishCompletedPeriod(failed, runtime.snapshots.buildSnapshot(failed));
  assert.equal(result.job.state, "completed");
  assert.deepEqual(result.job.results, value.results);
  assert.equal((await runtime.cache.readJob(value.jobId)).publicationState, "published");
  assert.equal(publicationStore.records.get(runtime.publication.receiptKey(value.jobId)).data.jobId, value.jobId);
  assert.equal(publicationStore.writes.filter(key => key === runtime.publication.LATEST_KEY).length, 1);
});

test("status, latest API, snapshot API and unified Excel use one verified Period Job without provider calls", async () => {
  const excelInputs = []; const downloads = [];
  const runtime = fixtureRuntime({
    "unified-excel.js": { toBuffer: async data => { excelInputs.push(clone(data)); return Buffer.from("fixture-xlsx"); } },
    "download-history-cache.js": { connect() {}, readHistory: async () => downloads,
      appendHistory: async item => { downloads.push(item); return item; }, writeFile: async () => {}, readFile: async () => null }
  });
  const instant = await seedLegacy(runtime, { ...job("instant-stays"), mode: "instant" });
  const period = job("verified-period"); await publish(runtime, period);
  const originalFetch = global.fetch; let providerCalls = 0;
  global.fetch = async () => { providerCalls += 1; throw Error("Provider API forbidden"); };
  try {
    const status = await runtime.load("trend-analysis-status.js").handler({ httpMethod: "GET", queryStringParameters: { jobId: period.jobId } });
    const latest = await runtime.load("trend-analysis-latest.js").handler({ httpMethod: "GET", queryStringParameters: { mode: "period", result: "full" } });
    const snapshot = await runtime.load("signal-snapshot-latest.js").handler({ httpMethod: "GET", queryStringParameters: { mode: "period" } });
    for (const response of [status, latest, snapshot]) {
      assert.equal(response.statusCode, 200); assert.equal(JSON.parse(response.body).jobId, period.jobId);
    }
    assert.deepEqual(JSON.parse(status.body).results, period.results);
    assert.deepEqual(JSON.parse(latest.body).results, period.results);
    const exported = await runtime.load("download-history.js").handler({ httpMethod: "POST", body: JSON.stringify({
      downloadType: "unified_results", periodJobId: period.jobId,
      periodStartDate: period.startDate, periodEndDate: period.endDate
    }) });
    assert.equal(exported.statusCode, 201);
    assert.equal(excelInputs[0].periodJob.jobId, period.jobId);
    assert.deepEqual(excelInputs[0].periodJob.results, JSON.parse(status.body).results);
    assert.equal(excelInputs[0].instantJob.jobId, instant.jobId);
    assert.equal(downloads[0].periodJobId, period.jobId);
    assert.equal(providerCalls, 0);
  } finally { global.fetch = originalFetch; }
});

test("unpublished prepared rows are not exported as a completed Period result", async () => {
  const excelInputs = [];
  const runtime = fixtureRuntime({
    "unified-excel.js": { toBuffer: async data => { excelInputs.push(clone(data)); return Buffer.from("fixture-xlsx"); } },
    "download-history-cache.js": { connect() {}, readHistory: async () => [],
      appendHistory: async item => item, writeFile: async () => {}, readFile: async () => null }
  });
  await seedLegacy(runtime, { ...job("instant-stays"), mode: "instant" });
  const period = job("not-yet-published"); await runtime.cache.writeJob(period.jobId, period);
  const exported = await runtime.load("download-history.js").handler({ httpMethod: "POST", body: JSON.stringify({
    downloadType: "unified_results", periodJobId: period.jobId,
    periodStartDate: period.startDate, periodEndDate: period.endDate
  }) });
  assert.equal(exported.statusCode, 201);
  assert.equal(excelInputs[0].periodJob, null);
  assert.equal(JSON.parse(exported.body).periodStatus, "not_analyzed");
  assert.equal((await runtime.cache.readJob(period.jobId)).state, "publishing");
});
