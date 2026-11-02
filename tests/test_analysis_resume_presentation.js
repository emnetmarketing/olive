const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { withResumeEvidence } = require("../netlify/functions/analysis-resume-presentation");
const { digest: periodDigest } = require("../netlify/functions/period-publication");
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const copy = value => value == null ? value : structuredClone(value);
function fixture(mode) {
  const records = new Map(), reads = [];
  const store = { async get(key) { reads.push(key); return copy(records.get(key) || null); },
    async setJSON() { throw new Error("Display audit must never write"); },
    async delete() { throw new Error("Display audit must never delete"); } };
  const job = { jobId: `${mode}-fixture`, mode, state: "interrupted", stale: true, resumable: true,
    startDate: "2026-10-04", endDate: "2026-11-02", queryStartDate: "2026-10-03",
    targetDataDate: "2026-11-01", surgeThreshold: 300, matchThreshold: 40,
    calculationVersion: 1, calculationCursor: 1, processedCount: 1, totalCount: 2 };
  function artifact(label, value) {
    const body = { version: 1, jobId: job.jobId, label, value }, hash = digest(body);
    const key = `jobs/${job.jobId}/instant-v1/${label}/${hash}`; records.set(key, body);
    return { version: 1, jobId: job.jobId, label, key, hash };
  }
  function pinned(kind, value) {
    const ref = artifact(kind.toLowerCase(), value);
    job[`instant${kind}Key`] = ref.key; job[`instant${kind}Hash`] = ref.hash;
  }
  return { job, records, reads, store, artifact, pinned, options: { store, now: Date.parse("2026-11-02T07:00:00Z") } };
}
function periodFixture() {
  const f = fixture("period");
  const input = { calculationVersion: 1, selection: { selected: [{ keyword: "가" }, { keyword: "나" }] } };
  const checkpoint = { version: 1, jobId: f.job.jobId, selectedStartDate: f.job.startDate,
    selectedEndDate: f.job.endDate, queryStartDate: f.job.queryStartDate,
    requiredWindow: `${f.job.queryStartDate}:${f.job.endDate}`, eligibleKeywords: ["가", "나"],
    calculationCursor: 1, processedCount: 1, totalCount: 2, rows: [], calculated: [], matchedDiagnostics: [],
    boundaryRelated: [], analysisTrace: [{ keyword: "가", finalIncluded: false }], updatedAt: "2026-11-02T03:15:29Z" };
  for (const [label, value] of [["periodInputs", input], ["calculationCheckpoint", checkpoint]]) {
    const hash = periodDigest(value), key = `jobs/${f.job.jobId}/${label}/${hash}`;
    f.job[`${label}Key`] = key; f.job[`${label}Hash`] = hash; f.records.set(key, value);
  }
  return { ...f, input, checkpoint };
}
function instantFixture() {
  const f = fixture("instant"), order = ["가", "나"];
  f.job.orderedCandidateHash = digest(order); f.job.productVersionHash = "product-fixture";
  const input = { ...f.job, requiredWindow: `${f.job.queryStartDate}:${f.job.endDate}`,
    productHash: f.job.productVersionHash, numericCount: 2, ratioCount: 0, totalCount: 2, queue: [] };
  const output = f.artifact("numeric-0-1", { phase: "numeric", startCursor: 0, endCursor: 1,
    rows: [], calculated: [], traces: [{ keyword: "가" }] });
  const state = { version: 1, jobId: f.job.jobId, selectedStartDate: f.job.startDate,
    selectedEndDate: f.job.endDate, queryStartDate: f.job.queryStartDate,
    requiredWindow: input.requiredWindow, stage: "numeric", cursor: 1, calculationCursor: 1, totalCount: 2,
    parts: [f.artifact("candidates-0", order.map(keyword => ({ candidate: { keyword } })))], outputs: [output] };
  f.job.instantStage = state.stage; f.job.instantStageCursor = state.cursor;
  f.pinned("Inputs", input); f.pinned("State", state);
  return { ...f, input, state };
}

test("stale Period c22-style progress/cache flags do not prove a calculation checkpoint", async () => {
  const f = fixture("period"); Object.assign(f.job, { processedCount: 0, totalCount: 5000, calculationCursor: undefined, historicalCollection: true });
  const original = copy(f.job), result = await withResumeEvidence(f.job, f.options);
  assert.equal(result.resumeEvidence.verified, false); assert.equal(result.resumeEvidence.status, "missing");
  assert.deepEqual(f.job, original); assert.equal(f.reads.length, 0);
});
test("actual Period checkpoint verifies its Job, window, frozen order and saved arrays without writes", async () => {
  const f = periodFixture(), result = await withResumeEvidence(f.job, f.options);
  assert.equal(result.resumeEvidence.verified, true); assert.equal(result.resumeEvidence.cursor, 1);
  assert.equal(result.resumeEvidence.checkpointUpdatedAt, "2026-11-02T03:15:29Z"); assert.equal(f.reads.length, 2);
});
test("Period wrong window, candidate order, version or absent intermediate rows fail closed", async () => {
  for (const change of [cp => cp.selectedEndDate = "2026-11-01", cp => cp.eligibleKeywords.reverse(), cp => cp.version = 2, cp => delete cp.rows]) {
    const f = periodFixture(); change(f.checkpoint);
    f.job.calculationCheckpointHash = periodDigest(f.checkpoint); f.records.set(f.job.calculationCheckpointKey, f.checkpoint);
    assert.equal((await withResumeEvidence(f.job, f.options)).resumeEvidence.verified, false);
  }
});
test("missing or altered checkpoint body never turns the result endpoint into an error", async () => {
  const f = periodFixture(); f.records.delete(f.job.calculationCheckpointKey);
  assert.equal((await withResumeEvidence(f.job, f.options)).resumeEvidence.status, "unverified");
  f.records.set(f.job.calculationCheckpointKey, { ...f.checkpoint, calculationCursor: 2 });
  assert.equal((await withResumeEvidence(f.job, f.options)).resumeEvidence.verified, false);
});
test("Instant verified state requires actual shard bodies and contiguous calculation output", async () => {
  const f = instantFixture(), result = await withResumeEvidence(f.job, f.options);
  assert.equal(result.resumeEvidence.verified, true); assert.equal(result.resumeEvidence.stage, "numeric");
  assert.equal(result.resumeEvidence.cursor, 1); assert.equal(result.resumeEvidence.totalCount, 2);
});
test("Instant progress 2500 and a resumable boolean without state is not a checkpoint", async () => {
  const f = fixture("instant"); f.job.processedCount = 2500;
  assert.equal((await withResumeEvidence(f.job, f.options)).resumeEvidence.verified, false); assert.equal(f.reads.length, 0);
});
test("Instant missing output, wrong frozen setting or a cursor mismatch suppresses resume claims", async () => {
  for (const change of [f => f.records.delete(f.state.outputs[0].key), f => f.job.matchThreshold = 99, f => f.job.instantStageCursor = 2]) {
    const f = instantFixture(); change(f);
    assert.equal((await withResumeEvidence(f.job, f.options)).resumeEvidence.verified, false);
  }
});
test("Instant duplicate chunk or reordered candidate shards are not compatible checkpoints", async () => {
  for (const change of [f => f.state.outputs.push(f.state.outputs[0]),
    f => f.state.parts = [f.artifact("reordered", ["나", "가"].map(keyword => ({ candidate: { keyword } })))]] ) {
    const f = instantFixture(); change(f); f.pinned("State", f.state);
    assert.equal((await withResumeEvidence(f.job, f.options)).resumeEvidence.verified, false);
  }
});
test("collection initial state and existing cache shards alone are not saved processing progress", async () => {
  const f = instantFixture();
  Object.assign(f.state, { stage: "collection", cursor: 0, calculationCursor: 0, outputs: [], responsesSaved: 0 });
  Object.assign(f.job, { instantStage: "collection", instantStageCursor: 0, calculationCursor: 0 });
  f.pinned("State", f.state);
  const result = await withResumeEvidence(f.job, f.options);
  assert.equal(result.resumeEvidence.verified, false); assert.equal(result.resumeEvidence.reason, "no-saved-stage-progress");
});
test("saved collection response checkpoint is distinguished from saved calculation output", async () => {
  const f = instantFixture();
  Object.assign(f.state, { stage: "collection", cursor: 1, calculationCursor: 0, outputs: [], responsesSaved: 1 });
  Object.assign(f.job, { instantStage: "collection", instantStageCursor: 1, calculationCursor: 0 });
  f.pinned("State", f.state);
  const result = await withResumeEvidence(f.job, f.options);
  assert.equal(result.resumeEvidence.verified, true); assert.equal(result.resumeEvidence.kind, "collection");
});
test("finished Instant165 and Period439 stay byte-identical and require no checkpoint reads", async () => {
  for (const [mode, count] of [["instant", 165], ["period", 439]]) {
    const f = fixture(mode); Object.assign(f.job, { state: "completed", results: Array.from({ length: count }, (_, n) => ({ keyword: String(n) })) });
    const before = JSON.stringify(f.job), result = await withResumeEvidence(f.job, f.options);
    assert.equal(result, f.job); assert.equal(JSON.stringify(result), before); assert.equal(f.reads.length, 0);
  }
});
test("normal running is untouched while old raw running may receive read-only proof", async () => {
  const f = instantFixture(); Object.assign(f.job, { stale: false, state: "running", updatedAt: "2026-11-02T06:59:00Z" });
  assert.equal(await withResumeEvidence(f.job, f.options), f.job); assert.equal(f.reads.length, 0);
  f.job.updatedAt = "2026-11-02T05:00:00Z";
  const result = await withResumeEvidence(f.job, f.options); assert.equal(result.resumeEvidence.verified, true); assert.equal(result.state, "running");
});
test("checkpoint transport failure preserves original error and never advertises resumability", async () => {
  const f = instantFixture(); f.job.errors = ["Original worker failed"];
  f.store.get = async () => { throw new Error("read unavailable"); };
  const result = await withResumeEvidence(f.job, f.options);
  assert.deepEqual(result.errors, f.job.errors); assert.equal(result.resumeEvidence.verified, false);
  assert.equal(result.resumeEvidence.status, "unverified");
});
