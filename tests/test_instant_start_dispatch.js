const test = require("node:test");
const assert = require("node:assert/strict");
const { recordInstantDispatchFailure } = require("../netlify/functions/trend-analysis-start")._test;
const worker = require("../netlify/functions/instant-worker");
const clone = value => value == null ? value : structuredClone(value);
function memoryStore() {
  const entries = new Map(); let version = 0;
  return { before: null,
    async get(key) { return clone(entries.get(key)?.data || null); },
    async getWithMetadata(key) { return clone(entries.get(key) || null); },
    async setJSON(key, data, condition = {}) {
      await this.before?.(key, data);
      const old = entries.get(key);
      if (condition.onlyIfNew && old || condition.onlyIfMatch && condition.onlyIfMatch !== old?.etag) return { modified: false };
      entries.set(key, { etag: String(++version), data: clone(data) }); return { modified: true };
    }
  };
}
const fixtureJob = () => ({ jobId: "initial-dispatch", mode: "instant", state: "running", progress: 0, processedCount: 0,
  createdAt: "2026-10-16T12:00:00Z", updatedAt: "2026-10-16T12:00:00Z" });

test("ambiguous initial acceptance preserves a runnable Job for a delayed first invocation", async () => {
  const store = memoryStore(), job = fixtureJob(); await store.setJSON(`jobs/${job.jobId}`, job);
  const saved = await recordInstantDispatchFailure(job, new TypeError("network response lost"), { store, ambiguous: true });
  assert.equal(saved.job.state, "running"); assert.equal(saved.job.dispatchState, "unknown");
  const claimed = await worker.claimInstantWorker(job.jobId, { store });
  assert.equal(claimed.claimed, true); assert.equal(claimed.job.state, "running");
});

test("a definite initial HTTP rejection marks only an untouched Instant Job failed", async () => {
  const store = memoryStore(), job = fixtureJob(); await store.setJSON(`jobs/${job.jobId}`, job);
  const saved = await recordInstantDispatchFailure(job, new Error("HTTP 403"), { store, ambiguous: false });
  assert.equal(saved.job.state, "failed"); assert.equal(saved.job.dispatchState, "rejected");
  assert.equal((await worker.claimInstantWorker(job.jobId, { store })).claimed, false);
});

for (const progressed of [
  { instantWorker: { token: "worker", fence: 1, expiresAt: Date.now() + 1000 } },
  { instantStateKey: "saved-checkpoint", calculationCursor: 250, processedCount: 250 },
  { state: "publishing", results: [{ keyword: "saved" }] },
  { state: "completed", publicationState: "published", results: [{ keyword: "published" }] },
  { updatedAt: "2026-10-16T12:00:01Z", progress: 5 }
]) test(`late start failure preserves advanced ${Object.keys(progressed)[0]} state`, async () => {
  const store = memoryStore(), job = fixtureJob(), advanced = { ...job, ...progressed };
  await store.setJSON(`jobs/${job.jobId}`, advanced);
  const saved = await recordInstantDispatchFailure(job, new Error("start response failed"), { store, ambiguous: false });
  assert.equal(saved.modified, false); assert.deepEqual(await store.get(`jobs/${job.jobId}`), advanced);
});

test("initial failure CAS losing to worker progress rereads and preserves the new cursor", async () => {
  const store = memoryStore(), job = fixtureJob(); await store.setJSON(`jobs/${job.jobId}`, job);
  let raced = false;
  store.before = async (key, value) => {
    if (!raced && value.state === "failed") {
      raced = true;
      await store.setJSON(key, { ...job, instantStateKey: "new-state", calculationCursor: 500, progress: 76 });
    }
  };
  const saved = await recordInstantDispatchFailure(job, new Error("HTTP error"), { store });
  assert.equal(raced, true); assert.equal(saved.reason, "worker-progressed");
  assert.equal((await store.get(`jobs/${job.jobId}`)).calculationCursor, 500);
});

test("Instant dispatch safeguard never writes a Period Job", async () => {
  const store = memoryStore(), job = { ...fixtureJob(), mode: "period" }; await store.setJSON(`jobs/${job.jobId}`, job);
  const saved = await recordInstantDispatchFailure(job, new Error("fixture"), { store });
  assert.equal(saved.modified, false); assert.deepEqual(await store.get(`jobs/${job.jobId}`), job);
});
