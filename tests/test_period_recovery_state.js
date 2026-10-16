const test = require("node:test");
const assert = require("node:assert/strict");
const recovery = require("../netlify/functions/period-recovery-state");

function fixture() {
  const values = new Map(); let sequence = 0; let now = Date.parse("2026-10-16T07:00:00Z");
  const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const store = {
    async get(key) { return clone(values.get(key)?.data ?? null); },
    async getWithMetadata(key) { return clone(values.get(key) || null); },
    async setJSON(key, data, options = {}) {
      const previous = values.get(key);
      if (options.onlyIfNew && previous || options.onlyIfMatch && previous?.etag !== options.onlyIfMatch)
        return { modified: false };
      values.set(key, { data: clone(data), etag: String(++sequence) }); return { modified: true };
    }
  };
  const deps = { store, now: () => now, leaseMs: 1000 };
  const frozen = { selectedStartDate: "2026-10-01", selectedEndDate: "2026-10-16", requiredWindow: "2026-09-16:2026-10-16",
    keywords: ["existing", "remaining"], calculationVersion: 1 };
  const initial = { generation: "recovery-1", inputHash: recovery.hashValue(frozen), stage: "numeric",
    calculationCursor: 4000, ratioCursor: 0, evidenceCursor: 0, totalCount: 4850, ratioTotalCount: 150,
    rows: [{ keyword: "existing" }], calculated: [{ keyword: "existing" }] };
  return { values, store, deps, frozen, initial, advance: (ms) => { now += ms; },
    initialize: () => recovery.initialize("job-1", frozen, initial, deps),
    claim: (invocationId = "request-1") => recovery.claim("job-1", { invocationId, generation: "recovery-1" }, deps) };
}

test("recovery initialization freezes inputs and preserves cursor 4000 with existing intermediate results", async () => {
  const f = fixture(); const saved = await f.initialize();
  assert.equal(saved.state.calculationCursor, 4000); assert.deepEqual(saved.state.rows, f.initial.rows);
  assert.deepEqual(saved.frozen, f.frozen); assert.equal(saved.control.status, "ready");
  const again = await f.initialize(); assert.equal(again.control.stateKey, saved.control.stateKey);
  await assert.rejects(recovery.initialize("job-1", { ...f.frozen, keywords: ["changed"] },
    { ...f.initial, inputHash: undefined }, f.deps), { code: "INITIALIZATION_CONFLICT" });
  await assert.rejects(recovery.initialize("job-1", f.frozen, { ...f.initial, generation: "new-generation" }, f.deps),
    { code: "INITIALIZATION_CONFLICT" });
});

test("supplied frozen input hash must match and immutable input corruption fails closed", async () => {
  const f = fixture();
  await assert.rejects(recovery.initialize("job-1", f.frozen, { ...f.initial, inputHash: "wrong" }, f.deps), { code: "INPUT_HASH_MISMATCH" });
  const saved = await f.initialize(); f.values.get(saved.control.inputKey).data.frozen.keywords.push("modified");
  await assert.rejects(f.claim(), { code: "INPUT_INTEGRITY" });
});

test("verified local frozen inputs avoid repeated large input downloads but never bypass hash or generation checks", async () => {
  const f = fixture(); const saved = await f.initialize(); let inputReads = 0; let stateReads = 0;
  const get = f.store.get;
  f.store.get = async (key, ...args) => {
    if (key === saved.control.inputKey) { inputReads += 1; throw new Error("Large input should not be downloaded again"); }
    if (key.includes("/states/")) stateReads += 1;
    return get(key, ...args);
  };
  const localDeps = { ...f.deps, frozen: f.frozen };
  const work = await recovery.claim("job-1", { invocationId: "request-1", generation: "recovery-1" }, localDeps);
  assert.deepEqual(work.frozen, f.frozen); assert.equal(inputReads, 0); assert.ok(stateReads > 0);
  const checkpoint = await recovery.checkpoint("job-1", work.lease, { calculationCursor: 4001 }, localDeps);
  assert.equal(checkpoint.state.calculationCursor, 4001); assert.equal(inputReads, 0);
  await assert.rejects(recovery.read("job-1", { ...localDeps, frozen: { ...f.frozen, calculationVersion: 99 } }), { code: "INPUT_INTEGRITY" });
  await assert.rejects(recovery.claim("job-1", { invocationId: "request-2", generation: "wrong-generation" }, localDeps), { code: "LEASE_FENCED" });
  f.values.get(checkpoint.control.stateKey).data.state.calculationCursor = 10;
  await assert.rejects(recovery.read("job-1", localDeps), { code: "STATE_INTEGRITY" });
});

test("duplicate delivery and concurrent claim cannot share a lease", async () => {
  const f = fixture(); await f.initialize();
  const attempts = await Promise.allSettled([f.claim("request-a"), f.claim("request-b")]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(attempts.find((result) => result.status === "rejected").reason.code, "LEASE_BUSY");
  await assert.rejects(f.claim("request-a"), { code: "LEASE_BUSY" });
});

test("stale takeover increments fence and old worker cannot checkpoint or release the new lease", async () => {
  const f = fixture(); await f.initialize(); const old = await f.claim(); f.advance(1001);
  const current = await f.claim("request-2"); assert.equal(current.lease.fence, old.lease.fence + 1);
  assert.equal(current.lease.generation, old.lease.generation);
  await assert.rejects(recovery.checkpoint("job-1", old.lease, { calculationCursor: 4500 }, f.deps), { code: "LEASE_FENCED" });
  await assert.rejects(recovery.release("job-1", old.lease, {}, f.deps), { code: "LEASE_FENCED" });
  await recovery.assertLease("job-1", "recovery-1", current.lease.token, f.deps);
});

test("numeric checkpoint resumes at saved cursor without changing prior row order", async () => {
  const f = fixture(); await f.initialize(); const first = await f.claim();
  const saved = await recovery.checkpoint("job-1", first.lease, { calculationCursor: 4500,
    rows: [...first.state.rows, { keyword: "next" }] }, f.deps);
  await recovery.release("job-1", saved.lease, {}, f.deps);
  const second = await f.claim("request-2"); assert.equal(second.state.calculationCursor, 4500);
  assert.deepEqual(second.state.rows.map((row) => row.keyword), ["existing", "next"]);
  assert.equal(f.values.has(first.control.stateKey), true, "original checkpoint remains immutable");
});

test("control exposes numeric and ratio totals separately from the 5000 candidate total", async () => {
  const f = fixture();
  const initial = await recovery.initialize("job-1", f.frozen, { ...f.initial, candidateCount: 5000, processedCount: 4000 }, f.deps);
  assert.equal(initial.control.totalCount, 4850); assert.equal(initial.control.ratioTotalCount, 150);
  assert.equal(initial.control.candidateCount, 5000); assert.equal(initial.control.processedCount, 4000);
  assert.equal(initial.control.evidenceTotalCount, undefined);
  const work = await f.claim();
  const evidence = await recovery.checkpoint("job-1", work.lease, { stage: "evidence", calculationCursor: 4850,
    ratioCursor: 150, evidenceTotalCount: 439, processedCount: 5000 }, f.deps);
  assert.equal(evidence.control.evidenceTotalCount, 439); assert.equal(evidence.control.processedCount, 5000);
  assert.equal(evidence.control.candidateCount, 5000); assert.equal(evidence.control.totalCount, 4850);
});

test("cursor rollback, stage rollback, and changing established totals are rejected", async () => {
  const f = fixture(); await f.initialize(); const work = await f.claim();
  await assert.rejects(recovery.checkpoint("job-1", work.lease, { calculationCursor: 3999 }, f.deps), { code: "CURSOR_ROLLBACK" });
  await assert.rejects(recovery.checkpoint("job-1", work.lease, { totalCount: 5000 }, f.deps), { code: "TOTAL_CHANGED" });
  await assert.rejects(recovery.checkpoint("job-1", work.lease, { calculationCursor: 5000 }, f.deps), { code: "INVALID_TOTAL" });
  const next = await recovery.checkpoint("job-1", work.lease, { stage: "ratio", calculationCursor: 4850 }, f.deps);
  await assert.rejects(recovery.checkpoint("job-1", next.lease, { stage: "numeric" }, f.deps), { code: "STAGE_ROLLBACK" });
});

test("an incomplete phase cannot be skipped and completion requires verified publication", async () => {
  const f = fixture(); await f.initialize(); const work = await f.claim();
  await assert.rejects(recovery.checkpoint("job-1", work.lease, { stage: "ratio" }, f.deps), { code: "INCOMPLETE_STAGE" });
  await assert.rejects(recovery.checkpoint("job-1", work.lease, { stage: "evidence", calculationCursor: 4850 }, f.deps), { code: "INCOMPLETE_STAGE" });
  await assert.rejects(recovery.checkpoint("job-1", work.lease, { stage: "completed", calculationCursor: 4850, ratioCursor: 150 }, f.deps),
    { code: "PUBLICATION_UNVERIFIED" });
});

test("lease expiry during artifact write cannot advance control", async () => {
  const f = fixture(); await f.initialize(); const work = await f.claim();
  const setJSON = f.store.setJSON;
  f.store.setJSON = async (...args) => { const result = await setJSON(...args); if (args[0].includes("/states/")) f.advance(1001); return result; };
  await assert.rejects(recovery.checkpoint("job-1", work.lease, { calculationCursor: 4500 }, f.deps), { code: "LEASE_EXPIRED" });
  assert.equal((await recovery.read("job-1", f.deps)).state.calculationCursor, 4000);
});

test("CAS prevents a worker overwriting a new owner even when takeover occurs during artifact save", async () => {
  const f = fixture(); await f.initialize(); const work = await f.claim();
  const setJSON = f.store.setJSON; let changed = false;
  f.store.setJSON = async (...args) => {
    const result = await setJSON(...args);
    if (!changed && args[0].includes("/states/")) {
      changed = true;
      const entry = f.values.get(recovery.controlKey("job-1"));
      entry.data.fence += 1; entry.data.lease.token = "different-owner"; entry.etag += "-new";
    }
    return result;
  };
  await assert.rejects(recovery.checkpoint("job-1", work.lease, { calculationCursor: 4500 }, f.deps), { code: "LEASE_FENCED" });
  assert.equal((await recovery.read("job-1", f.deps)).state.calculationCursor, 4000);
});

test("checkpoint read-back failure preserves previous reference and intermediate rows", async () => {
  const f = fixture(); await f.initialize(); const work = await f.claim();
  const get = f.store.get;
  f.store.get = async (key, ...args) => key.includes("/states/") && key !== work.control.stateKey ? null : get(key, ...args);
  await assert.rejects(recovery.checkpoint("job-1", work.lease, { calculationCursor: 4500 }, f.deps), { code: "STATE_INTEGRITY" });
  assert.equal((await recovery.read("job-1", f.deps)).control.stateKey, work.control.stateKey);
});

test("postprocessing failure is resumable at evidence cursor without numeric calculation restart", async () => {
  const f = fixture(); await f.initialize(); const work = await f.claim();
  const saved = await recovery.checkpoint("job-1", work.lease, { stage: "evidence", calculationCursor: 4850,
    ratioCursor: 150, evidenceCursor: 200, evidenceTotalCount: 439 }, f.deps);
  await recovery.markFailure("job-1", saved.lease, Object.assign(new Error("secret-token-not-for-logs"), { code: "WRITE_FAILED" }), f.deps);
  const resumed = await f.claim("request-2"); assert.equal(resumed.state.stage, "evidence");
  assert.equal(resumed.state.evidenceCursor, 200); assert.equal(resumed.state.calculationCursor, 4850);
  assert.equal(JSON.stringify([...f.values.values()]).includes("secret-token-not-for-logs"), false);
});

test("publication failure keeps finalized rows for publication-only retry and completion rejects duplicate invocation", async () => {
  const f = fixture(); await f.initialize(); const work = await f.claim();
  const finalRows = [{ keyword: "final", periodMarketConfidenceScore: 66 }];
  const publishing = await recovery.checkpoint("job-1", work.lease, { stage: "publishing", calculationCursor: 4850,
    ratioCursor: 150, evidenceCursor: 439, evidenceTotalCount: 439, rows: finalRows }, f.deps);
  await recovery.markFailure("job-1", publishing.lease, { code: "POINTER_WRITE_FAILED" }, f.deps);
  const retry = await f.claim("request-2"); assert.equal(retry.state.stage, "publishing"); assert.deepEqual(retry.state.rows, finalRows);
  const completed = await recovery.checkpoint("job-1", retry.lease, { stage: "completed", publicationVerified: true }, f.deps);
  assert.equal(completed.control.status, "completed"); assert.equal(completed.control.resumable, false); assert.equal(completed.lease, null);
  await assert.rejects(f.claim("request-3"), { code: "RECOVERY_COMPLETED" });
});

test("recovery writes are job-specific and traces never include arbitrary raw payloads", async () => {
  const f = fixture(); await f.initialize(); const work = await f.claim();
  await recovery.appendTrace("job-1", work.lease, { event: "continuation-requested", requestId: "netlify-request",
    continuationNumber: 2, httpStatus: 202, token: "do-not-log", candidates: ["private-candidate"] }, f.deps);
  assert.ok([...f.values.keys()].every((key) => key.startsWith("jobs/job-1/")));
  const traces = [...f.values.entries()].filter(([key]) => key.includes("/traces/")).map(([, value]) => value.data);
  assert.ok(traces.some((entry) => entry.event === "continuation-requested" && entry.httpStatus === 202));
  assert.equal(JSON.stringify(traces).includes("do-not-log"), false);
  assert.equal(JSON.stringify(traces).includes("private-candidate"), false);
  assert.equal(traces.some((entry) => entry.event === "publication-completed"), false, "request acceptance is not completion");
});

test("frozen state and artifact validation require no external data API", async () => {
  const f = fixture(); const originalFetch = global.fetch; let calls = 0;
  global.fetch = () => { calls += 1; throw new Error("External API forbidden"); };
  try { await f.initialize(); const work = await f.claim(); await recovery.checkpoint("job-1", work.lease, { calculationCursor: 4001 }, f.deps); }
  finally { global.fetch = originalFetch; }
  assert.equal(calls, 0);
});
