const test = require("node:test");
const assert = require("node:assert/strict");
const { publishInstant, visiblePointer, stagePointer, patchInstantPublication, writeInstantJobGuarded } = require("../netlify/functions/instant-publication");
const snapshots = require("../netlify/functions/signal-snapshot-cache");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function memoryStore() {
  const entries = new Map(); let revision = 0;
  return {
    entries, writes: [], before: null,
    async get(key) { await this.before?.("get", key); return clone(entries.get(key)?.data || null); },
    async getWithMetadata(key) { await this.before?.("metadata", key); return clone(entries.get(key) || null); },
    async setJSON(key, value, condition = {}) {
      await this.before?.("set", key, value);
      const previous = entries.get(key);
      if (condition.onlyIfNew && previous || condition.onlyIfMatch && condition.onlyIfMatch !== previous?.etag) return { modified: false };
      entries.set(key, { data: clone(value), etag: String(++revision) }); this.writes.push({ key, value: clone(value) });
      return { modified: true };
    }
  };
}
function job(id = "new", createdAt = "2026-10-16T06:00:00.000Z") {
  return { jobId: id, mode: "instant", state: "publishing", currentStage: "publishing", createdAt,
    startDate: "2026-09-17", endDate: "2026-10-16", queryStartDate: "2026-09-16",
    completedAt: "2026-10-16T06:05:00.000Z", latestDataDate: "2026-10-14",
    trendCoveragePct: 100, partialAnalysis: false, surgeThreshold: 500, matchThreshold: 70,
    fastPath: false, freshFetchCount: 30, searchTrendApiCallCount: 6,
    results: [{ keyword: "fixture", estimatedSurgeCount: 1234, resultType: "product_match", marketConfidenceScore: 52 }]
  };
}
async function fixture() {
  const analysis = memoryStore(), snapshot = memoryStore();
  const previous = { ...job("old", "2026-10-15T06:00:00.000Z"), state: "completed" };
  await analysis.setJSON("jobs/old", previous);
  await snapshot.setJSON("snapshots/old", snapshots.buildSnapshot(previous));
  for (const key of ["latest-analysis-v1/instant", "latest-analysis-v1", "latest-valid-v1/instant", "latest-valid-v1", "latest-v1", "latest-collection-v1"])
    await snapshot.setJSON(key, { jobId: "old", generatedAt: previous.completedAt });
  for (const key of ["last-success/instant", "last-success/latest", "last-partial/instant", "last-partial/latest"])
    await analysis.setJSON(key, { jobId: "old", mode: "instant", completedAt: previous.completedAt });
  const current = job(); await analysis.setJSON("jobs/new", current);
  const readJob = id => analysis.get(`jobs/${id}`);
  const visible = async (store, key) => visiblePointer(await store.get(key), readJob);
  return { analysis, snapshot, current, previous, readJob, visible,
    options: { analysisStore: analysis, snapshotStore: snapshot } };
}

test("Instant publication stores snapshot and pointers before completed is visible", async () => {
  const f = await fixture(); let beforeComplete = false;
  f.analysis.before = async (op, key, value) => {
    if (op === "set" && key === "jobs/new" && value.state === "completed") {
      beforeComplete = true;
      assert.equal((await f.snapshot.get("snapshots/new")).jobId, "new");
      assert.equal((await f.snapshot.get("latest-valid-v1/instant")).jobId, "new");
      assert.equal((await f.analysis.get("last-success/instant")).jobId, "new");
      assert.equal((await f.visible(f.snapshot, "latest-valid-v1/instant")).jobId, "old");
      assert.equal((await f.visible(f.analysis, "last-success/instant")).jobId, "old");
    }
  };
  const result = await publishInstant(f.current, f.options);
  assert.equal(beforeComplete, true);
  assert.equal(result.state, "completed"); assert.equal(result.publicationState, "published");
  assert.deepEqual(result.results, f.current.results);
  assert.equal((await f.visible(f.snapshot, "latest-valid-v1/instant")).jobId, "new");
  assert.equal((await f.visible(f.analysis, "last-success/instant")).jobId, "new");
});

for (const failureStage of ["snapshot", "snapshot-pointer", "last-pointer", "completion"]) {
  test(`Instant ${failureStage} failure preserves previous result; retry publishes without calculation`, async () => {
    const f = await fixture(); let fired = false;
    const fail = async (op, key, value) => {
      if (fired || op !== "set") return;
      const match = failureStage === "snapshot" && key === "snapshots/new"
        || failureStage === "snapshot-pointer" && key === "latest-valid-v1/instant"
        || failureStage === "last-pointer" && key === "last-success/instant"
        || failureStage === "completion" && key === "jobs/new" && value.state === "completed";
      if (match) { fired = true; throw new Error("injected publication failure"); }
    };
    f.analysis.before = f.snapshot.before = fail;
    await assert.rejects(publishInstant(f.current, f.options), /injected/);
    assert.equal(fired, true);
    assert.equal((await f.readJob("new")).state, "publication_failed");
    assert.equal((await f.visible(f.snapshot, "latest-valid-v1/instant")).jobId, "old");
    assert.equal((await f.visible(f.analysis, "last-success/instant")).jobId, "old");
    assert.deepEqual((await f.readJob("new")).results, f.current.results);
    f.analysis.before = f.snapshot.before = null;
    await publishInstant(await f.readJob("new"), f.options);
    assert.equal((await f.readJob("new")).state, "completed");
    assert.equal((await f.visible(f.snapshot, "latest-valid-v1/instant")).jobId, "new");
    assert.equal((await f.visible(f.analysis, "last-success/instant")).jobId, "new");
  });
}

test("Instant retry is idempotent after successful publication and never changes Period pointers", async () => {
  const f = await fixture(); await f.analysis.setJSON("last-success/period", { jobId: "period" });
  await f.snapshot.setJSON("latest-valid-v1/period", { jobId: "period" });
  const first = await publishInstant(f.current, f.options);
  const writes = f.analysis.writes.length + f.snapshot.writes.length;
  const again = await publishInstant(first, f.options);
  assert.equal(first.publishedAt, again.publishedAt);
  assert.equal(f.analysis.writes.length + f.snapshot.writes.length, writes);
  assert.equal((await f.analysis.get("last-success/period")).jobId, "period");
  assert.equal((await f.snapshot.get("latest-valid-v1/period")).jobId, "period");
});

test("Low-coverage Instant completion cannot replace the latest valid snapshot", async () => {
  const f = await fixture(); f.current.trendCoveragePct = 0; f.current.partialAnalysis = true; f.current.results = [];
  await f.analysis.setJSON("jobs/new", f.current);
  await publishInstant(f.current, f.options);
  assert.equal((await f.visible(f.snapshot, "latest-valid-v1/instant")).jobId, "old");
  assert.equal((await f.visible(f.analysis, "last-partial/instant")).jobId, "new");
  assert.equal((await f.visible(f.snapshot, "latest-analysis-v1/instant")).jobId, "new");
});

test("An older Instant worker cannot regress newer staged pointers", async () => {
  const f = await fixture(); const newest = { jobId: "future", generation: Date.parse("2026-10-17T00:00:00Z"), requiresCompleted: true,
    previous: { jobId: "old" } };
  await f.snapshot.setJSON("latest-valid-v1/instant", newest);
  const answer = await stagePointer(f.snapshot, "latest-valid-v1/instant", { jobId: "new", generation: Date.parse(f.current.createdAt) }, f.readJob);
  assert.equal(answer.skippedNewer, true); assert.deepEqual(await f.snapshot.get("latest-valid-v1/instant"), newest);
});

test("Instant publication rejects changed rows/settings and rejects incomplete running calculations", async () => {
  const f = await fixture();
  await assert.rejects(publishInstant({ ...f.current, surgeThreshold: 999 }, f.options), { code: "INSTANT_CALCULATION_CHANGED" });
  await assert.rejects(publishInstant({ ...f.current, results: [] }, f.options), { code: "INSTANT_CALCULATION_CHANGED" });
  await assert.rejects(publishInstant({ ...f.current, state: "running" }, f.options), { code: "INVALID_INSTANT_PUBLICATION" });
  assert.equal((await f.readJob("new")).state, "publishing");
});

test("Actual snapshot and last-result readers show previous results while Instant publication is incomplete", async () => {
  const f = await fixture();
  const load = name => {
    const filename = path.resolve("netlify/functions", name); const module = { exports: {} };
    const getStore = input => (typeof input === "string" ? input : input.name) === "trend-analysis" ? f.analysis : f.snapshot;
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module, exports: module.exports, console, Date,
      require: id => id === "@netlify/blobs" ? { getStore }
        : id === "./blob-store-compat" ? { getCompatibleStore: getStore, connectLambda() {} }
          : id.startsWith(".") ? require(path.resolve(path.dirname(filename), id)) : require(id) }, { filename });
    return module.exports;
  };
  const snapshotReaders = load("signal-snapshot-cache.js"), analysisReaders = load("trend-analysis-cache.js");
  let fired = false;
  f.analysis.before = async (op, key, value) => {
    if (!fired && op === "set" && key === "jobs/new" && value.state === "completed") {
      fired = true; throw new Error("final marker unavailable");
    }
  };
  await assert.rejects(publishInstant(f.current, f.options), /final marker unavailable/);
  assert.equal((await snapshotReaders.readLatest("instant")).jobId, "old");
  assert.equal((await snapshotReaders.readLatestAnalysis("instant")).jobId, "old");
  assert.equal((await snapshotReaders.readLatestCollection()).jobId, "old");
  assert.equal((await analysisReaders.readLastSuccess("instant")).jobId, "old");
  f.analysis.before = null;
  await publishInstant(await f.readJob("new"), f.options);
  assert.equal((await snapshotReaders.readLatest("instant")).jobId, "new");
  assert.equal((await snapshotReaders.readLatestCollection()).jobId, "new");
  assert.equal((await analysisReaders.readLastSuccess("instant")).jobId, "new");
});

test("Lost continuation response cannot replace a newer completed Instant publication", async () => {
  const f = await fixture(); const completed = await publishInstant(f.current, f.options);
  const writes = f.analysis.writes.length;
  const late = await patchInstantPublication("new", { state: "publication_failed", errors: ["response lost"] }, { store: f.analysis });
  assert.equal(late.modified, false); assert.deepEqual(late.job, completed);
  assert.equal(f.analysis.writes.length, writes);
  await assert.rejects(writeInstantJobGuarded("new", { ...f.current, state: "running", progress: 75 }, { store: f.analysis }),
    { code: "INSTANT_WRITE_PROTECTED" });
  await assert.rejects(writeInstantJobGuarded("new", { ...f.current, state: "failed" }, { store: f.analysis }),
    { code: "INSTANT_WRITE_PROTECTED" });
  assert.deepEqual(await f.readJob("new"), completed);
});

test("Instant retry CAS losing to a completed worker re-reads rather than rolling completion back", async () => {
  const f = await fixture(); let raced = false;
  const completed = { ...f.current, state: "completed", publicationState: "published", progress: 100 };
  f.analysis.before = async (op, key, value) => {
    if (!raced && op === "set" && key === "jobs/new" && value.state === "publication_failed") {
      raced = true; f.analysis.before = null;
      await f.analysis.setJSON(key, completed);
    }
  };
  const answer = await patchInstantPublication("new", { state: "publication_failed", errors: ["response lost"] }, { store: f.analysis });
  assert.equal(raced, true); assert.equal(answer.modified, false); assert.deepEqual(answer.job, completed);
  assert.deepEqual(await f.readJob("new"), completed);
});

test("Instant publication retry controls cannot alter results or regress continuation counters", async () => {
  const f = await fixture();
  await patchInstantPublication("new", { state: "publishing", continuationCount: 3, publicationAttempt: 2 }, { store: f.analysis });
  const late = await patchInstantPublication("new", { state: "publication_failed", continuationCount: 1, publicationAttempt: 1 }, { store: f.analysis });
  assert.equal(late.job.continuationCount, 3); assert.equal(late.job.publicationAttempt, 2);
  await assert.rejects(patchInstantPublication("new", { results: [] }, { store: f.analysis }), { code: "INVALID_INSTANT_PUBLICATION_PATCH" });
  await assert.rejects(writeInstantJobGuarded("new", { ...f.current, state: "failed" }, { store: f.analysis }), { code: "INSTANT_WRITE_PROTECTED" });
  assert.deepEqual((await f.readJob("new")).results, f.current.results);
});
