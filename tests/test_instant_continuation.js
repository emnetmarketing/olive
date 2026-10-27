const test = require("node:test");
const assert = require("node:assert/strict");
const continuation = require("../netlify/functions/instant-continuation");
const worker = require("../netlify/functions/instant-worker");
const clone = value => value == null ? value : structuredClone(value);

function memoryStore() {
  const records = new Map(); let revision = 0;
  return { records, writes: [], before: null,
    async get(key) { await this.before?.("get", key); return clone(records.get(key)?.data || null); },
    async getWithMetadata(key) { await this.before?.("metadata", key); return clone(records.get(key) || null); },
    async setJSON(key, value, condition = {}) {
      await this.before?.("set", key, value);
      const previous = records.get(key);
      if (condition.onlyIfNew && previous || condition.onlyIfMatch && condition.onlyIfMatch !== previous?.etag) return { modified: false };
      records.set(key, { data: clone(value), etag: String(++revision) }); this.writes.push({ key, value: clone(value) });
      return { modified: true };
    }
  };
}
function newJob(id = "instant-fixture") {
  return { jobId: id, mode: "instant", state: "running", createdAt: "2026-10-16T10:00:00.000Z",
    startDate: "2026-09-17", endDate: "2026-10-16", queryStartDate: "2026-09-16",
    surgeThreshold: 500, matchThreshold: 70, fastPath: false, collectionScope: "search-trend-only" };
}
async function fixture(extra = {}) {
  const store = memoryStore(); let clock = Date.parse("2026-10-16T10:00:00Z");
  const job = { ...newJob(), ...extra }; await store.setJSON(`jobs/${job.jobId}`, job);
  const options = { store, now: () => clock };
  const claimed = await worker.claimInstantWorker(job.jobId, options);
  return { store, options, job: claimed.job, lease: claimed.lease, advance: ms => { clock += ms; } };
}

test("Instant input shards are immutable content-addressed data, readable without provider calls", async () => {
  const f = await fixture();
  const payload = { candidates: ["first", "second"], originalSourceTime: "2026-10-16T09:54:34Z" };
  const first = await continuation.writeArtifact(f.lease, "candidate-shard-0", payload, f.options);
  const count = f.store.writes.length;
  const second = await continuation.writeArtifact(f.lease, "candidate-shard-0", payload, f.options);
  assert.deepEqual(first, second); assert.equal(f.store.writes.length, count);
  assert.deepEqual(await continuation.readArtifact(first, f.options), payload);
  assert.match(first.key, /^jobs\/instant-fixture\/instant-v1\/candidate-shard-0\/[a-f0-9]{64}$/);
  assert.equal([...f.store.records.keys()].every(key => key.startsWith(`jobs/${f.job.jobId}`)), true);
});

test("frozen Instant inputs preserve selection/order/threshold data and cannot be replaced", async () => {
  const f = await fixture(); const inputs = { candidateOrder: ["b", "a"], productsRef: null, calculationVersion: "fixture-v1" };
  const saved = await continuation.writeInputs(f.lease, inputs, f.options);
  assert.deepEqual(await continuation.readInputs(saved, f.options), inputs);
  assert.deepEqual(await continuation.writeInputs(f.lease, inputs, f.options), saved);
  await assert.rejects(continuation.writeInputs(f.lease, { ...inputs, candidateOrder: ["a", "b"] }, f.options), { code: "INSTANT_INPUTS_CHANGED" });
  await assert.rejects(worker.writeOwnedInstantJob(f.lease, { instantInputsKey: "different" }, f.options), { code: "INSTANT_INPUTS_CHANGED" });
});

test("legacy progress 2500 without durable state is not accepted as a checkpoint", async () => {
  const f = await fixture({ processedCount: 2500, totalCount: 4850, progress: 82 });
  assert.equal(await continuation.readState(f.job, f.options), null);
  assert.equal(await continuation.readInputs(f.job, f.options), null);
  const saved = await continuation.writeState(f.lease, { stage: "numeric", calculationCursor: 0, totalCount: 4850 }, f.options);
  assert.equal((await continuation.readState(saved, f.options)).calculationCursor, 0);
});

test("checkpoint CAS commits cursor and reference together, then next invocation resumes at saved cursor", async () => {
  const f = await fixture(); const rowsRef = await continuation.writeArtifact(f.lease, "numeric-0", [{ keyword: "first", estimatedSurgeCount: 712 }], f.options);
  const saved = await continuation.writeState(f.lease, { stage: "numeric", calculationCursor: 250, totalCount: 5000, rowsRefs: [rowsRef] }, f.options);
  assert.equal(saved.calculationCursor, 250); assert.equal(saved.instantStateRevision, 1);
  assert.equal(saved.instantStageCursor, 250);
  await worker.releaseInstantWorker(f.lease, { continuationCount: 1 }, f.options);
  const next = await worker.claimInstantWorker(saved.jobId, f.options);
  const state = await continuation.readState(next.job, f.options);
  assert.equal(state.calculationCursor, 250); assert.equal(next.lease.fence, f.lease.fence + 1);
  assert.deepEqual(await continuation.readArtifact(state.rowsRefs[0], f.options), [{ keyword: "first", estimatedSurgeCount: 712 }]);
});

test("5000 candidates finish across bounded invocations without duplicate calculation or changed order", async () => {
  const f = await fixture(); const candidates = Array.from({ length: 5000 }, (_, n) => ({ keyword: `fixture-${n}`, value: n }));
  let current = await continuation.writeInputs(f.lease, { candidates }, f.options), lease = f.lease, invocationCount = 0;
  const visited = new Map(); let rowsRefs = [];
  while (true) {
    invocationCount++;
    const inputs = await continuation.readInputs(current, f.options);
    const previous = await continuation.readState(current, f.options);
    const start = previous?.calculationCursor || 0, end = Math.min(candidates.length, start + continuation.MAX_NUMERIC_CHUNK);
    const rows = inputs.candidates.slice(start, end).map(item => {
      visited.set(item.keyword, Number(visited.get(item.keyword) || 0) + 1);
      return { keyword: item.keyword, estimatedSurgeCount: item.value * 2 };
    });
    rowsRefs = [...(previous?.rowsRefs || []), await continuation.writeArtifact(lease, `numeric-${start}`, rows, f.options)];
    current = await continuation.writeState(lease, { stage: end === candidates.length ? "ratio" : "numeric", calculationCursor: end,
      totalCount: candidates.length, rowsRefs }, f.options);
    if (end === candidates.length) break;
    await worker.releaseInstantWorker(lease, { continuationCount: invocationCount }, f.options);
    const next = await worker.claimInstantWorker(current.jobId, f.options); assert.equal(next.claimed, true);
    current = next.job; lease = next.lease;
  }
  const output = (await Promise.all(rowsRefs.map(ref => continuation.readArtifact(ref, f.options)))).flat();
  assert.equal(invocationCount, 20); assert.equal(output.length, 5000);
  assert.equal([...visited.values()].every(count => count === 1), true);
  assert.deepEqual(output, candidates.map(item => ({ keyword: item.keyword, estimatedSurgeCount: item.value * 2 })));
});

test("time safety and chunk limit request continuation before hard timeout, but not after finished stage", () => {
  const base = { startedAt: 0, cursor: 1, invocationStartCursor: 0, totalCount: 5000 };
  assert.equal(continuation.SAFE_EXECUTION_MS, 240000);
  assert.equal(continuation.shouldContinue({ ...base, now: 239999 }), false);
  assert.equal(continuation.shouldContinue({ ...base, now: 240000 }), true);
  assert.equal(continuation.shouldContinue({ ...base, cursor: 250, now: 1 }), true);
  assert.equal(continuation.shouldContinue({ ...base, cursor: 5000, now: 900000 }), false);
  assert.doesNotThrow(() => continuation.assertContinuationAvailable({ continuationCount: 127 }));
  assert.throws(() => continuation.assertContinuationAvailable({ continuationCount: 128 }), { code: "INSTANT_CONTINUATION_LIMIT" });
});

test("duplicate delivery cannot claim a live Instant worker", async () => {
  const f = await fixture(); const duplicate = await worker.claimInstantWorker(f.job.jobId, f.options);
  assert.equal(duplicate.claimed, false); assert.equal(duplicate.reason, "worker-active");
  await continuation.writeState(f.lease, { stage: "collection", collectionCursor: 5 }, f.options);
  assert.equal((await f.store.get(`jobs/${f.job.jobId}`)).invocationCount, 1);
});

test("late duplicate cannot bypass a failed publication; explicit adopted pending delivery may resume", async () => {
  const f = await fixture();
  await worker.releaseInstantWorker(f.lease, { state: "publication_failed", instantStateKey: "saved-state",
    continuationDispatch: { ticket: "publication-ticket", state: "entered", enteredAt: new Date(f.options.now()).toISOString() } }, f.options);
  const delayed = await worker.claimInstantWorker(f.job.jobId, { ...f.options, continuationTicket: "publication-ticket" });
  assert.equal(delayed.claimed, false); assert.equal(delayed.reason, "publication-requires-explicit-resume");
  const saved = await f.store.get(`jobs/${f.job.jobId}`);
  await f.store.setJSON(`jobs/${f.job.jobId}`, { ...saved, continuationDispatch: { ...saved.continuationDispatch,
    state: "pending", adoptedAt: new Date(f.options.now()).toISOString() } });
  const resumed = await worker.claimInstantWorker(f.job.jobId, { ...f.options, continuationTicket: "publication-ticket" });
  assert.equal(resumed.claimed, true); assert.equal(resumed.job.state, "publication_failed");
});

test("accepted but delayed continuation can resume its matching interrupted pending dispatch", async () => {
  const f = await fixture(); await continuation.writeState(f.lease, { stage: "numeric", calculationCursor: 250 }, f.options);
  await worker.releaseInstantWorker(f.lease, { state: "interrupted", resumable: true,
    continuationDispatch: { ticket: "delivery-1", state: "pending", number: 1 } }, f.options);
  assert.equal((await worker.claimInstantWorker(f.job.jobId, f.options)).claimed, false);
  assert.equal((await worker.claimInstantWorker(f.job.jobId, { ...f.options, continuationTicket: "wrong" })).reason, "stale-continuation-delivery");
  const resumed = await worker.claimInstantWorker(f.job.jobId, { ...f.options, continuationTicket: "delivery-1", owner: "delayed-runtime" });
  assert.equal(resumed.claimed, true); assert.equal(resumed.job.state, "running");
  assert.equal(resumed.job.calculationCursor, 250); assert.equal(resumed.job.continuationDispatch.state, "entered");
  assert.equal(resumed.job.continuationDispatch.invocationId, "delayed-runtime");
  assert.ok(resumed.job.continuationDispatch.enteredAt);
});

test("duplicate or older continuation tickets cannot reclaim an entered or newer dispatch", async () => {
  const f = await fixture(); await continuation.writeState(f.lease, { stage: "numeric", calculationCursor: 250 }, f.options);
  await worker.releaseInstantWorker(f.lease, { continuationDispatch: { ticket: "delivery-1", state: "pending", number: 1 } }, f.options);
  const first = await worker.claimInstantWorker(f.job.jobId, { ...f.options, continuationTicket: "delivery-1" });
  assert.equal(first.claimed, true);
  assert.equal((await worker.claimInstantWorker(f.job.jobId, { ...f.options, continuationTicket: "delivery-1" })).reason, "continuation-already-entered");
  await worker.releaseInstantWorker(first.lease, { continuationDispatch: { ticket: "delivery-2", state: "pending", number: 2 } }, f.options);
  assert.equal((await worker.claimInstantWorker(f.job.jobId, { ...f.options, continuationTicket: "delivery-1" })).reason, "stale-continuation-delivery");
  const second = await worker.claimInstantWorker(f.job.jobId, { ...f.options, continuationTicket: "delivery-2" });
  assert.equal(second.claimed, true); assert.equal(second.job.calculationCursor, 250);
});

test("ticket cannot revive an interrupted Job without a durable checkpoint", async () => {
  const f = await fixture();
  await worker.releaseInstantWorker(f.lease, { state: "interrupted", resumable: true,
    continuationDispatch: { ticket: "delivery-1", state: "pending" } }, f.options);
  assert.equal((await worker.claimInstantWorker(f.job.jobId, { ...f.options, continuationTicket: "delivery-1" })).reason, "not-runnable");
});

test("same latest entered ticket can resume an expired worker from its durable checkpoint, but not a live worker", async () => {
  const f = await fixture(); await continuation.writeState(f.lease, { stage: "numeric", calculationCursor: 250 }, f.options);
  await worker.releaseInstantWorker(f.lease, { continuationDispatch: { ticket: "delivery-1", state: "pending", number: 1 } }, f.options);
  const first = await worker.claimInstantWorker(f.job.jobId, { ...f.options, continuationTicket: "delivery-1", owner: "first-delivery" });
  await continuation.writeState(first.lease, { stage: "numeric", calculationCursor: 500 }, f.options);
  assert.equal((await worker.claimInstantWorker(f.job.jobId, { ...f.options, continuationTicket: "delivery-1" })).claimed, false);
  f.advance(worker.LEASE_MS + 1);
  const resumed = await worker.claimInstantWorker(f.job.jobId, { ...f.options, continuationTicket: "delivery-1", owner: "redelivered" });
  assert.equal(resumed.claimed, true); assert.equal(resumed.job.calculationCursor, 500);
  assert.equal(resumed.lease.fence, first.lease.fence + 1); assert.equal(resumed.job.continuationDispatch.redeliveryCount, 1);
  assert.equal(resumed.job.continuationDispatch.firstEnteredAt, first.job.continuationDispatch.enteredAt);
  await assert.rejects(continuation.writeState(first.lease, { stage: "numeric", calculationCursor: 750 }, f.options), { code: "INSTANT_WORKER_LOST" });
});

test("expired worker cannot write state, shards or replace the new fenced cursor", async () => {
  const f = await fixture(); f.advance(worker.LEASE_MS + 1);
  const next = await worker.claimInstantWorker(f.job.jobId, f.options);
  await continuation.writeState(next.lease, { stage: "numeric", calculationCursor: 500, totalCount: 5000 }, f.options);
  await assert.rejects(continuation.writeState(f.lease, { stage: "numeric", calculationCursor: 250 }, f.options), { code: "INSTANT_WORKER_LOST" });
  await assert.rejects(continuation.writeArtifact(f.lease, "old-shard", [] , f.options), { code: "INSTANT_WORKER_LOST" });
  assert.equal((await f.store.get(`jobs/${f.job.jobId}`)).calculationCursor, 500);
});

test("a delayed matching delivery cannot automatically revive an explicit calculation failure", async () => {
  const f = await fixture();
  await continuation.writeState(f.lease, { stage: "numeric", cursor: 250, calculationCursor: 250 }, f.options);
  await worker.releaseInstantWorker(f.lease, { state: "interrupted", resumable: true, errorCode: "INSTANT_INPUT_INCOMPATIBLE",
    continuationDispatch: { ticket: "queued-before-failure", state: "entered", enteredAt: new Date(f.options.now()).toISOString() } }, f.options);
  const claimed = await worker.claimInstantWorker(f.job.jobId, { ...f.options, continuationTicket: "queued-before-failure" });
  assert.equal(claimed.claimed, false); assert.equal(claimed.reason, "not-runnable");
  assert.equal((await f.store.get(`jobs/${f.job.jobId}`)).calculationCursor, 250);
});

test("delayed 202 delivery cannot bypass the bounded dispatcher attempt limit", async () => {
  const f = await fixture();
  await continuation.writeState(f.lease, { stage: "numeric", cursor: 250, calculationCursor: 250 }, f.options);
  await worker.releaseInstantWorker(f.lease, { continuationDispatch: { ticket: "exhausted-ticket", state: "blocked", attemptsExhausted: true } }, f.options);
  const claimed = await worker.claimInstantWorker(f.job.jobId, { ...f.options, continuationTicket: "exhausted-ticket" });
  assert.equal(claimed.claimed, false); assert.equal(claimed.reason, "continuation-dispatch-blocked");
});

test("cursor, stage, immutable scope and continuation counter cannot regress", async () => {
  const f = await fixture(); await continuation.writeState(f.lease, { stage: "ratio", calculationCursor: 5000, ratioCursor: 10 }, f.options);
  await assert.rejects(continuation.writeState(f.lease, { stage: "ratio", calculationCursor: 4999 }, f.options), { code: "INSTANT_CURSOR_REGRESSION" });
  await assert.rejects(continuation.writeState(f.lease, { stage: "numeric", calculationCursor: 5000 }, f.options), { code: "INSTANT_STAGE_REGRESSION" });
  await assert.rejects(worker.writeOwnedInstantJob(f.lease, { ratioCursor: 9 }, f.options), { code: "INSTANT_CURSOR_REGRESSION" });
  await assert.rejects(worker.writeOwnedInstantJob(f.lease, { collectionScope: null }, f.options), { code: "INSTANT_IDENTITY_CHANGED" });
  await worker.writeOwnedInstantJob(f.lease, { continuationCount: 2 }, f.options);
  await assert.rejects(worker.writeOwnedInstantJob(f.lease, { continuationCount: 1 }, f.options), { code: "INSTANT_CURSOR_REGRESSION" });
});

test("state rejects another Job or window and invalid cursor totals", async () => {
  const f = await fixture();
  for (const value of [{ stage: "collection", jobId: "another" }, { stage: "numeric", requiredWindow: "2026-08-02:2026-09-01" }])
    await assert.rejects(continuation.writeState(f.lease, value, f.options), { code: "INSTANT_ARTIFACT_IDENTITY" });
  for (const value of [{ stage: "numeric", calculationCursor: -1 }, { stage: "ratio", ratioCursor: 4, ratioTotalCount: 3 }])
    await assert.rejects(continuation.writeState(f.lease, value, f.options), { code: "INSTANT_STATE_CURSOR" });
});

test("generic stage cursor cannot regress but may reset on a forward stage transition", async () => {
  const f = await fixture();
  await continuation.writeState(f.lease, { stage: "collection", cursor: 250, collectionCursor: 250 }, f.options);
  await assert.rejects(continuation.writeState(f.lease, { stage: "collection", cursor: 249 }, f.options), { code: "INSTANT_CURSOR_REGRESSION" });
  await assert.rejects(continuation.writeState(f.lease, { stage: "numeric", cursor: -1 }, f.options), { code: "INSTANT_STATE_CURSOR" });
  const saved = await continuation.writeState(f.lease, { stage: "numeric", cursor: 0 }, f.options);
  const state = await continuation.readState(saved, f.options);
  assert.equal(state.cursor, 0); assert.equal(state.collectionCursor, 250); assert.equal(saved.instantStageCursor, 0);
});

test("checkpoint timestamp records the latest successful save instead of retaining the initial timestamp", async () => {
  const f = await fixture();
  const first = await continuation.writeState(f.lease, { stage: "numeric", cursor: 250, calculationCursor: 250 }, f.options);
  const state = await continuation.readState(first, f.options); f.advance(1000);
  const second = await continuation.writeState(f.lease, { ...state, cursor: 500, calculationCursor: 500 }, f.options);
  assert.equal(Date.parse(second.checkpointUpdatedAt) - Date.parse(first.checkpointUpdatedAt), 1000);
});

test("legacy jobs freeze target date and calculation version once, then prevent mutation", async () => {
  const f = await fixture();
  await worker.writeOwnedInstantJob(f.lease, { targetDataDate: "2026-10-15", calculationVersion: "fixture-v1",
    orderedCandidateHash: "order-a", productVersionHash: "product-a" }, f.options);
  await worker.writeOwnedInstantJob(f.lease, { targetDataDate: "2026-10-15", calculationVersion: "fixture-v1" }, f.options);
  await assert.rejects(worker.writeOwnedInstantJob(f.lease, { targetDataDate: "2026-10-16" }, f.options), { code: "INSTANT_IDENTITY_CHANGED" });
  await assert.rejects(worker.writeOwnedInstantJob(f.lease, { calculationVersion: "different" }, f.options), { code: "INSTANT_IDENTITY_CHANGED" });
  await assert.rejects(worker.writeOwnedInstantJob(f.lease, { orderedCandidateHash: "order-b" }, f.options), { code: "INSTANT_IDENTITY_CHANGED" });
  await assert.rejects(worker.writeOwnedInstantJob(f.lease, { productVersionHash: "product-b" }, f.options), { code: "INSTANT_IDENTITY_CHANGED" });
});

test("missing or corrupt durable inputs/state fail closed instead of rereading live candidates", async () => {
  const f = await fixture(); let saved = await continuation.writeInputs(f.lease, { candidates: ["saved"] }, f.options);
  f.store.records.delete(saved.instantInputsKey);
  await assert.rejects(continuation.readInputs(saved, f.options), { code: "INSTANT_ARTIFACT_INTEGRITY" });
  saved = await continuation.writeState(f.lease, { stage: "evidence", evidenceCursor: 1 }, f.options);
  f.store.records.get(saved.instantStateKey).data.value.evidenceCursor = 999;
  await assert.rejects(continuation.readState(saved, f.options), { code: "INSTANT_ARTIFACT_INTEGRITY" });
});

test("artifact references cannot cross Jobs or escape their job-specific prefix", async () => {
  const f = await fixture(); const ref = await continuation.writeArtifact(f.lease, "rows", [], f.options);
  await assert.rejects(continuation.readArtifact({ ...ref, key: "latest-valid-v1/instant" }, f.options), { code: "INSTANT_ARTIFACT_IDENTITY" });
  await assert.rejects(continuation.readArtifact(ref, { ...f.options, jobId: "another" }), { code: "INSTANT_ARTIFACT_IDENTITY" });
  await assert.rejects(continuation.writeArtifact(f.lease, "../rows", [], f.options), { code: "INSTANT_ARTIFACT_LABEL" });
  await assert.rejects(continuation.readArtifact({ ...ref, label: "../rows", key: `jobs/${ref.jobId}/instant-v1/../rows/${ref.hash}` }, f.options),
    { code: "INSTANT_ARTIFACT_IDENTITY" });
});

test("two concurrent checkpoints cannot silently overwrite each other under the same worker", async () => {
  const f = await fixture();
  const settled = await Promise.allSettled([250, 500].map(calculationCursor => continuation.writeState(f.lease,
    { stage: "numeric", calculationCursor, totalCount: 5000 }, f.options)));
  assert.equal(settled.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(settled.find(item => item.status === "rejected").reason.code, "INSTANT_STATE_CONFLICT");
  const job = await f.store.get(`jobs/${f.job.jobId}`), state = await continuation.readState(job, f.options);
  assert.equal(job.instantStateRevision, 1); assert.equal(state.calculationCursor, job.calculationCursor);
});

test("crash after artifact write but before Job CAS preserves the previous checkpoint", async () => {
  const f = await fixture(); const previous = await continuation.writeState(f.lease, { stage: "numeric", calculationCursor: 250 }, f.options);
  let crashed = false;
  f.store.before = async (op, key, value) => {
    if (!crashed && op === "set" && key === `jobs/${f.job.jobId}` && value.instantStateRevision === 2) {
      crashed = true; throw new Error("fixture process stopped before checkpoint commit");
    }
  };
  await assert.rejects(continuation.writeState(f.lease, { stage: "numeric", calculationCursor: 500 }, f.options), /fixture process stopped/);
  const raw = await f.store.get(`jobs/${f.job.jobId}`);
  assert.equal(raw.instantStateKey, previous.instantStateKey); assert.equal(raw.calculationCursor, 250);
  assert.equal((await continuation.readState(raw, f.options)).calculationCursor, 250);
  assert.equal([...f.store.records.keys()].filter(key => key.includes("/instant-v1/state/")).length, 2);
});

test("lease loss during immutable write may leave an orphan but cannot commit a stale cursor", async () => {
  const f = await fixture(); let replace = true;
  f.store.before = async (op, key) => {
    if (replace && op === "set" && key.includes("/instant-v1/state/")) {
      replace = false; f.advance(worker.LEASE_MS + 1);
      await worker.claimInstantWorker(f.job.jobId, f.options);
    }
  };
  await assert.rejects(continuation.writeState(f.lease, { stage: "numeric", calculationCursor: 250 }, f.options), { code: "INSTANT_WORKER_LOST" });
  assert.equal((await f.store.get(`jobs/${f.job.jobId}`)).instantStateKey, undefined);
});

test("enrichment/evidence/finalize/publishing state retains finished numeric rows and metrics references", async () => {
  const f = await fixture(); const refs = { rows: await continuation.writeArtifact(f.lease, "numeric-rows", [{ keyword: "a" }], f.options),
    metrics: await continuation.writeArtifact(f.lease, "metrics", { searchTrend: { calls: 7, http200: 7 } }, f.options) };
  let saved;
  for (const stage of ["numeric", "ratio", "enrichment", "evidence", "finalize", "publishing"])
    saved = await continuation.writeState(f.lease, { stage, calculationCursor: 5000, totalCount: 5000, refs }, f.options);
  const state = await continuation.readState(saved, f.options);
  assert.equal(state.stage, "publishing"); assert.equal(state.calculationCursor, 5000);
  assert.deepEqual(await continuation.readArtifact(state.refs.metrics, f.options), { searchTrend: { calls: 7, http200: 7 } });
  assert.equal([...f.store.records.keys()].every(key => key.startsWith(`jobs/${f.job.jobId}`)), true);
});

test("stale Instant progress reports its durable current stage, never a completed numeric cursor", () => {
  const { checkpointProgress } = require("../netlify/functions/trend-analysis-cache");
  const base = { mode: "instant", instantStateKey: "saved-state", calculationCursor: 4850, processedCount: 2,
    totalCount: 20, instantStageCursor: 2, instantStage: "evidence", currentStage: "instant-evidence" };
  assert.deepEqual(checkpointProgress(base), { checkpointStage: "evidence", lastCursor: 2, checkpointTotalCount: 20, remainingCount: 18 });
  assert.deepEqual(checkpointProgress({ ...base, instantStage: "finalize", instantStageCursor: 0 }),
    { checkpointStage: "finalize", lastCursor: 0, checkpointTotalCount: null, remainingCount: null });
  assert.equal(checkpointProgress({ ...base, instantStage: "enrichment", instantStageTotalCount: 25 }).remainingCount, 23);
  assert.equal(checkpointProgress({ mode: "period", calculationCursor: 4000, totalCount: 4850 }).remainingCount, 850);
});
