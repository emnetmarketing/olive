const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
function fixtureRuntime() {
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
    const absolute = path.resolve(__dirname, "../netlify/functions", file);
    if (modules.has(absolute)) return modules.get(absolute).exports;
    const module = { exports: {} }; modules.set(absolute, module);
    const wrapper = vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(absolute, "utf8")}\n})`, { filename: absolute });
    wrapper((id) => id === "@netlify/blobs" ? { connectLambda() {}, getStore }
      : id.startsWith("./") ? load(`${id.slice(2)}.js`) : require(id), module, module.exports);
    return module.exports;
  }
  return { stores, getStore, cache: load("trend-analysis-cache.js"), snapshots: load("signal-snapshot-cache.js"), publication: load("period-publication.js") };
}
function job(jobId, createdAt = "2026-10-16T05:22:00.000Z", partial = false) {
  return { jobId, mode: "period", state: "publishing", publicationState: "prepared", createdAt,
    updatedAt: new Date().toISOString(), startDate: "2026-10-01", endDate: "2026-10-16", queryStartDate: "2026-09-16",
    calculatedAt: "2026-10-16T06:00:00.000Z", completedAt: "2026-10-16T06:00:00.000Z",
    latestDataDate: "2026-10-15", trendCoveragePct: partial ? 80 : 100, partialAnalysis: partial,
    resultCount: 1, results: [{ keyword: "fixture-keyword", resultType: "product_match", estimatedSurgeCount: 1000,
      periodMarketConfidenceScore: 70, periodMarketConfidenceGrade: "strong", periodMarketEvidence: { youtube: { status: "no_data" } } }] };
}
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
