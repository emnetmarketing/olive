const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const dispatch = require("../netlify/functions/instant-dispatch");
const worker = require("../netlify/functions/instant-worker");
const artifacts = require("../netlify/functions/instant-continuation");
const copy = value => value == null ? value : structuredClone(value);
function memoryStore() {
  const values = new Map(), writes = []; let sequence = 0;
  return { values, writes,
    async get(key) { return copy(values.get(key)?.data || null); },
    async getWithMetadata(key) { return copy(values.get(key) || null); },
    async setJSON(key, data, condition = {}) {
      const previous = values.get(key);
      if (condition.onlyIfNew && previous || condition.onlyIfMatch && previous?.etag !== condition.onlyIfMatch) return { modified: false };
      values.set(key, { data: copy(data), etag: String(++sequence) }); writes.push({ key, data: copy(data) }); return { modified: true };
    }
  };
}
async function fixture({ initial = false, state = "running", phase = "numeric", entered = false } = {}) {
  const store = memoryStore(); let now = Date.parse("2026-10-27T00:00:00Z"); const calls = [];
  const options = { store, now: () => now, baseURL: "https://fixture.invalid", requestId: "cron-fixture",
    fetch: async (url, request) => { calls.push({ url, body: JSON.parse(request.body), request }); return { status: 202 }; } };
  let job = { jobId: "example", mode: "instant", state, createdAt: "2026-10-16T12:30:47.183Z", updatedAt: "2026-10-16T13:00:00Z",
    startDate: "2026-09-17", endDate: "2026-10-16", queryStartDate: "2026-09-16", targetDataDate: "2026-10-15",
    surgeThreshold: 300, matchThreshold: 40, collectionScope: "search-trend-only", fastPath: false,
    calculationVersion: 1, orderedCandidateHash: "original-candidate-order", productVersionHash: "original-products", resumable: true };
  if (!initial) {
    const putArtifact = async (label, value) => {
      const data = { version: 1, jobId: job.jobId, label, value };
      const hash = crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
      const key = `jobs/${job.jobId}/instant-v1/${label}/${hash}`; await store.setJSON(key, data); return { key, hash };
    };
    const input = await putArtifact("inputs", { jobId: job.jobId, startDate: job.startDate, endDate: job.endDate,
      queryStartDate: job.queryStartDate, targetDataDate: job.targetDataDate, surgeThreshold: 300, matchThreshold: 40,
      requiredWindow: `${job.queryStartDate}:${job.endDate}`, productHash: job.productVersionHash,
      calculationVersion: 1, orderedCandidateHash: job.orderedCandidateHash });
    const stateRef = await putArtifact("state", { version: 1, jobId: job.jobId, stage: phase, cursor: phase === "numeric" ? 250 : 0,
      calculationCursor: 250, ratioCursor: 0, selectedStartDate: job.startDate, selectedEndDate: job.endDate,
      queryStartDate: job.queryStartDate, requiredWindow: `${job.queryStartDate}:${job.endDate}` });
    job = { ...job, instantInputsKey: input.key, instantInputsHash: input.hash, instantStateKey: stateRef.key, instantStateHash: stateRef.hash,
      instantStateRevision: 3, instantStage: phase, instantStageCursor: phase === "numeric" ? 250 : 0, calculationCursor: 250,
      ratioCursor: 0, invocationCount: 1, continuationCount: 1,
      continuationDispatch: { ticket: "original-ticket", state: entered ? "entered" : "pending", number: 1,
        requestedAt: "2026-10-16T13:00:00Z", ...(entered ? { enteredAt: "2026-10-16T13:00:01Z" } : {}) } };
  }
  await store.setJSON("jobs/example", job); store.writes.length = 0;
  return { store, job, options, calls, setNow: value => { now = value; }, advance: value => { now += value; },
    read: () => store.get("jobs/example"), adoptOptions: { ...options, expectedInputsHash: job.instantInputsHash,
      expectedStateHash: job.instantStateHash, expectedTargetDataDate: job.targetDataDate } };
}

test("empty scheduled dispatch is read-only and never calls a provider", async () => {
  const f = await fixture(); assert.deepEqual(await dispatch.tick(f.options), { status: "idle", dispatched: false });
  assert.equal(f.store.writes.length, 0); assert.equal(f.calls.length, 0);
});
test("new Instant is indexed before its pending ticket; orphan initial registration is repaired", async () => {
  const f = await fixture({ initial: true }); await dispatch.enqueueInitial("example", f.options);
  assert.equal(f.store.writes[0].key, dispatch.REGISTRY_KEY);
  assert.equal(f.store.writes[1].key, "jobs/example"); assert.equal(f.calls.length, 0);
  const ticket = (await f.read()).continuationDispatch.ticket;
  await dispatch.enqueueInitial("example", f.options); assert.equal((await f.read()).continuationDispatch.ticket, ticket);
  const second = await fixture({ initial: true }); await dispatch.registerJob("example", second.options);
  assert.equal((await dispatch.tick(second.options)).status, "accepted");
  assert.deepEqual(Object.keys(second.calls[0].body).sort(), ["continuationTicket", "jobId"]);
  assert.equal(second.calls[0].url, "https://fixture.invalid/.netlify/functions/trend-analysis-background");
});
test("simultaneous scheduler ticks perform at most one delivery", async () => {
  const f = await fixture(); await dispatch.registerJob("example", f.options);
  const result = await Promise.all([dispatch.tick(f.options), dispatch.tick(f.options)]);
  assert.equal(f.calls.length, 1); assert.equal(result.filter(r => r.dispatched).length, 1);
  assert.equal((await f.read()).updatedAt, f.job.updatedAt);
});
test("202 acknowledgement is not worker entry and delayed entry retries the same ticket", async () => {
  const f = await fixture(); await dispatch.registerJob("example", f.options);
  await dispatch.tick(f.options); assert.equal((await f.read()).continuationDispatch.enteredAt, undefined);
  f.advance(dispatch.ACCEPTED_GRACE_MS - 1); await dispatch.tick(f.options); assert.equal(f.calls.length, 1);
  f.advance(1); await dispatch.tick(f.options); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].body.continuationTicket, f.calls[1].body.continuationTicket);
  assert.equal((await f.read()).continuationCount, 1);
});
test("live worker is never interrupted or dispatched again", async () => {
  const f = await fixture(); await dispatch.registerJob("example", f.options);
  const claimed = await worker.claimInstantWorker("example", { ...f.options, continuationTicket: "original-ticket" });
  assert.equal(claimed.claimed, true); await dispatch.tick(f.options); assert.equal(f.calls.length, 0);
  assert.equal((await f.read()).instantWorker.token, claimed.lease.token);
});
test("POST response loss after actual worker entry does not revert entered state", async () => {
  const f = await fixture(); await dispatch.registerJob("example", f.options);
  f.options.fetch = async (_url, request) => {
    await worker.claimInstantWorker("example", { ...f.options, continuationTicket: JSON.parse(request.body).continuationTicket });
    throw new Error("response lost");
  };
  assert.equal((await dispatch.tick(f.options)).status, "advanced");
  assert.equal((await f.read()).continuationDispatch.state, "entered");
  assert.ok((await f.read()).instantWorker.token);
});
test("late HTTP acknowledgement cannot replace a newer ticket or cursor", async () => {
  const f = await fixture(); await dispatch.registerJob("example", f.options);
  f.options.fetch = async (_url, request) => {
    const claimed = await worker.claimInstantWorker("example", { ...f.options, continuationTicket: JSON.parse(request.body).continuationTicket });
    await worker.releaseInstantWorker(claimed.lease, { calculationCursor: 500,
      continuationDispatch: { ticket: "new-ticket", state: "pending", number: 2 } }, f.options);
    return { status: 202 };
  };
  assert.equal((await dispatch.tick(f.options)).status, "advanced");
  assert.equal((await f.read()).continuationDispatch.ticket, "new-ticket"); assert.equal((await f.read()).calculationCursor, 500);
});
test("crashed dispatcher claim expires and retries its existing ticket", async () => {
  const f = await fixture(); await dispatch.registerJob("example", f.options);
  const prior = await f.read(); await f.store.setJSON("jobs/example", { ...prior, continuationDispatch: {
    ...prior.continuationDispatch, state: "dispatching", attemptToken: "lost-dispatcher", attemptCount: 1,
    dispatchLeaseUntil: f.options.now() + dispatch.DISPATCH_LEASE_MS } });
  await dispatch.tick(f.options); assert.equal(f.calls.length, 0);
  f.advance(dispatch.DISPATCH_LEASE_MS + 1); await dispatch.tick(f.options);
  assert.equal(f.calls[0].body.continuationTicket, "original-ticket"); assert.equal((await f.read()).continuationDispatch.attemptCount, 2);
});
test("expired entered worker reuses checkpoint and ticket with a new fence", async () => {
  const f = await fixture(); await dispatch.registerJob("example", f.options);
  const first = await worker.claimInstantWorker("example", { ...f.options, continuationTicket: "original-ticket" });
  f.advance(worker.LEASE_MS + 1); let resumed;
  f.options.fetch = async (_url, request) => { resumed = await worker.claimInstantWorker("example", {
    ...f.options, continuationTicket: JSON.parse(request.body).continuationTicket }); return { status: 202 }; };
  await dispatch.tick(f.options); assert.equal(resumed.claimed, true); assert.equal(resumed.job.calculationCursor, 250);
  assert.equal(resumed.lease.fence, first.lease.fence + 1);
  await assert.rejects(worker.writeOwnedInstantJob(first.lease, { processedCount: 0 }, f.options), { code: "INSTANT_WORKER_LOST" });
});
test("explicit worker failure stays interrupted until an audited adoption", async () => {
  const f = await fixture({ state: "interrupted", entered: true }); await dispatch.registerJob("example", f.options);
  await dispatch.tick(f.options); assert.equal(f.calls.length, 0); assert.equal((await f.read()).state, "interrupted");
  const adopted = await dispatch.adoptCheckpoint("example", f.adoptOptions);
  assert.equal(adopted.continuationDispatch.ticket, "original-ticket"); assert.equal(adopted.state, "running");
  await dispatch.tick(f.options); assert.equal(f.calls.length, 1);
  const job = await f.read(); for (const field of ["startDate", "endDate", "queryStartDate", "targetDataDate", "orderedCandidateHash", "instantInputsHash", "instantStateHash", "calculationCursor"])
    assert.equal(job[field], f.job[field], field + " must remain frozen on October 27");
});
test("adoption rejects changed audit hashes, active workers, or invalid artifact bytes", async () => {
  const f = await fixture({ state: "interrupted" });
  await assert.rejects(dispatch.adoptCheckpoint("example", { ...f.adoptOptions, expectedStateHash: "changed" }), { code: "INSTANT_ADOPTION_CHANGED" });
  assert.equal((await f.read()).state, "interrupted");
  const data = f.store.values.get(f.job.instantStateKey); data.data.value.cursor = 0;
  await assert.rejects(dispatch.adoptCheckpoint("example", f.adoptOptions), { code: "INSTANT_ARTIFACT_INTEGRITY" });
  assert.equal((await f.read()).state, "interrupted");
});
test("repeated HTTP508 has bounded backoff and remains recoverable without endless calls", async () => {
  const f = await fixture(); await dispatch.registerJob("example", f.options); let calls = 0;
  f.options.fetch = async () => { calls++; return { status: 508 }; };
  for (let n = 0; n < dispatch.MAX_ATTEMPTS; n++) {
    await dispatch.tick(f.options); const before = calls; await dispatch.tick(f.options); assert.equal(calls, before);
    f.advance(dispatch.BACKOFF_MS[n] + 1);
  }
  const job = await f.read(); assert.equal(calls, dispatch.MAX_ATTEMPTS); assert.equal(job.state, "interrupted");
  assert.equal(job.resumable, true); assert.equal(job.continuationDispatch.state, "blocked");
  f.advance(86400000); await dispatch.tick(f.options); assert.equal(calls, dispatch.MAX_ATTEMPTS);
  assert.equal(job.updatedAt, f.job.updatedAt); assert.equal(job.instantStateHash, f.job.instantStateHash);
});
test("publication failure adoption remains publication-only and completed Jobs are removed from hints", async () => {
  const f = await fixture({ state: "publication_failed", phase: "publishing" });
  await f.store.setJSON("jobs/example", { ...await f.read(), results: [{ keyword: "saved" }] });
  await dispatch.adoptCheckpoint("example", f.adoptOptions); await dispatch.tick(f.options);
  assert.equal((await f.read()).state, "publication_failed"); assert.deepEqual((await f.read()).results, [{ keyword: "saved" }]);
  await f.store.setJSON("jobs/example", { ...await f.read(), state: "completed" });
  await dispatch.tick(f.options); assert.equal((await f.store.get(dispatch.REGISTRY_KEY)).jobs.length, 0);
  assert.equal((await f.read()).results.length, 1);
});
test("registry can discover waiting Instant independently of a different current-job pointer", async () => {
  const f = await fixture(); await f.store.setJSON("current-job/v1", { jobId: "period-other" });
  await dispatch.registerJob("example", f.options); await dispatch.tick(f.options);
  assert.deepEqual(await f.store.get("current-job/v1"), { jobId: "period-other" }); assert.equal(f.calls.length, 1);
});

test("checkpoint CAS before next pending-ticket write resumes the new durable state, not the old dispatch cursor", async () => {
  const f = await fixture(); await dispatch.registerJob("example", f.options);
  const first = await worker.claimInstantWorker("example", { ...f.options, continuationTicket: "original-ticket" });
  const saved = await artifacts.readState(first.job, f.options);
  await artifacts.writeState(first.lease, { ...saved, cursor: 500, calculationCursor: 500 }, f.options);
  // Hard exit: release/next ticket never ran, so the earlier entered ticket remains.
  f.advance(worker.LEASE_MS + 1); let resumed;
  f.options.fetch = async (_url, request) => { resumed = await worker.claimInstantWorker("example", {
    ...f.options, continuationTicket: JSON.parse(request.body).continuationTicket }); return { status: 202 }; };
  await dispatch.tick(f.options); assert.equal(resumed.claimed, true); assert.equal(resumed.job.calculationCursor, 500);
  assert.equal((await artifacts.readState(resumed.job, f.options)).calculationCursor, 500);
  assert.equal(resumed.job.continuationDispatch.ticket, "original-ticket");
});

test("late failed delivery response cannot overwrite an actually completed Job", async () => {
  const f = await fixture(); await dispatch.registerJob("example", f.options);
  f.options.fetch = async () => { await f.store.setJSON("jobs/example", { ...await f.read(), state: "completed",
    results: [{ keyword: "final" }], completedAt: "2026-10-27T00:00:01Z" }); throw new Error("late response failure"); };
  assert.equal((await dispatch.tick(f.options)).status, "advanced");
  const saved = await f.read(); assert.equal(saved.state, "completed"); assert.equal(saved.results[0].keyword, "final");
});

test("global dispatcher crash lease expires without a second concurrent dispatch", async () => {
  const f = await fixture(); await dispatch.registerJob("example", f.options);
  await f.store.setJSON(dispatch.REGISTRY_KEY, { ...await f.store.get(dispatch.REGISTRY_KEY),
    lease: { token: "lost-registry-owner", expiresAt: f.options.now() + dispatch.DISPATCH_LEASE_MS } });
  assert.equal((await dispatch.tick(f.options)).status, "busy"); assert.equal(f.calls.length, 0);
  f.advance(dispatch.DISPATCH_LEASE_MS + 1); assert.equal((await dispatch.tick(f.options)).status, "accepted");
  assert.equal(f.calls.length, 1);
});

test("eight-hint scan cap rotates fairly past ineligible Jobs", async () => {
  const f = await fixture();
  for (let n = 0; n < 12; n++) {
    const jobId = `busy-${n}`; await f.store.setJSON(`jobs/${jobId}`, { ...f.job, jobId,
      instantWorker: { token: "active", expiresAt: f.options.now() + worker.LEASE_MS } });
    await dispatch.registerJob(jobId, f.options);
  }
  await dispatch.registerJob("example", f.options);
  assert.equal((await dispatch.tick(f.options)).status, "idle"); assert.equal(f.calls.length, 0);
  assert.equal((await f.store.get(dispatch.REGISTRY_KEY)).scanAfterJobId, "busy-7");
  assert.equal((await dispatch.tick(f.options)).status, "accepted"); assert.equal(f.calls.length, 1);
});

test("scan deadline reserves time for a single bounded HTTP delivery", async () => {
  const f = await fixture();
  f.advance(60000); // Delivery-only tick; ten-minute orphan scan has its own bound.
  for (let n = 0; n < 8; n++) {
    const jobId = `busy-${n}`; await f.store.setJSON(`jobs/${jobId}`, { ...f.job, jobId,
      instantWorker: { token: "active", expiresAt: f.options.now() + worker.LEASE_MS } });
    await dispatch.registerJob(jobId, f.options);
  }
  await dispatch.registerJob("example", f.options); const get = f.store.get.bind(f.store); let reads = 0;
  f.store.get = async key => { if (key.startsWith("jobs/busy-")) { reads++; f.advance(4000); } return get(key); };
  await dispatch.tick(f.options); assert.equal(reads, 3); assert.equal(f.calls.length, 0);
  assert.equal((await f.store.get(dispatch.REGISTRY_KEY)).scanAfterJobId, "busy-2");
});

test("one corrupt frozen checkpoint is blocked without starving a later registered Job", async () => {
  const f = await fixture();
  await f.store.setJSON("jobs/corrupt", { ...f.job, jobId: "corrupt" });
  await dispatch.registerJob("corrupt", f.options); await dispatch.registerJob("example", f.options);
  assert.equal((await dispatch.tick(f.options)).status, "accepted");
  const corrupt = await f.store.get("jobs/corrupt"); assert.equal(corrupt.state, "interrupted");
  assert.equal(corrupt.dispatchErrorCode, "INSTANT_ARTIFACT_IDENTITY");
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.jobId, "example");
  assert.equal((await f.store.get(dispatch.REGISTRY_KEY)).jobs.some(item => item.jobId === "corrupt"), false);
});

test("explicit publication worker failure is not retried forever after a prior adoption", async () => {
  const f = await fixture({ state: "publication_failed", phase: "publishing" });
  await dispatch.adoptCheckpoint("example", f.adoptOptions);
  f.options.fetch = async (_url, request) => {
    const claimed = await worker.claimInstantWorker("example", { ...f.options, continuationTicket: JSON.parse(request.body).continuationTicket });
    await worker.releaseInstantWorker(claimed.lease, { state: "publication_failed", errorCode: "WRITE_FAILED" }, f.options);
    f.calls.push("one dispatch"); return { status: 202 };
  };
  await dispatch.tick(f.options); f.advance(worker.LEASE_MS + 1); await dispatch.tick(f.options);
  assert.equal(f.calls.length, 1); assert.equal((await f.read()).state, "publication_failed");
  assert.equal((await f.read()).errorCode, "WRITE_FAILED");
});

test("frozen product hash mismatch blocks delivery without changing selected dates", async () => {
  const f = await fixture(); await f.store.setJSON("jobs/example", { ...f.job, productVersionHash: "changed-products" });
  await dispatch.registerJob("example", f.options); await dispatch.tick(f.options);
  const job = await f.read(); assert.equal(job.state, "interrupted");
  assert.equal(job.dispatchErrorCode, "INSTANT_DISPATCH_INPUT_MISMATCH"); assert.equal(f.calls.length, 0);
  assert.equal(job.targetDataDate, "2026-10-15");
});

test("input-committed initial boundary allows absent derived fields but never conflicting frozen identity", async () => {
  const f = await fixture();
  const initial = { ...f.job, instantStateKey: undefined, instantStateHash: undefined, instantStateRevision: 0,
    calculationCursor: 0, orderedCandidateHash: undefined, productVersionHash: undefined, calculationVersion: undefined };
  await dispatch.validateCheckpoint(initial, f.options);
  await assert.rejects(dispatch.validateCheckpoint({ ...initial, productVersionHash: "different" }, f.options),
    { code: "INSTANT_DISPATCH_INPUT_MISMATCH" });
});

test("active workers cannot be adopted and old failure diagnostics survive outside active errors", async () => {
  const f = await fixture({ state: "interrupted", entered: true });
  const saved = { ...f.job, errors: ["original HTTP508"], errorCode: "HTTP_508", failedAt: "2026-10-16T13:05:00Z",
    instantWorker: { token: "still-live", expiresAt: f.options.now() + 10000 } };
  await f.store.setJSON("jobs/example", saved);
  await assert.rejects(dispatch.adoptCheckpoint("example", f.adoptOptions), { code: "INSTANT_ADOPTION_NOT_SAFE" });
  f.advance(10001); const adopted = await dispatch.adoptCheckpoint("example", f.adoptOptions);
  assert.deepEqual(adopted.errors, []); assert.equal(adopted.failedAt, null); assert.equal(adopted.errorCode, null);
  assert.equal(adopted.continuationDispatch.adoptedPreviousError.errorCode, "HTTP_508");
  assert.equal(adopted.continuationDispatch.adoptedPreviousError.failedAt, saved.failedAt);
});

test("adoption repairs a hint removed concurrently before its Job CAS", async () => {
  const f = await fixture({ state: "interrupted" }); const set = f.store.setJSON.bind(f.store); let raced = false;
  f.store.setJSON = async (key, value, options) => {
    if (key === 'jobs/example' && value.state === 'running' && !raced) {
      raced = true; await dispatch.removeJob('example', { ...f.options, recoverable: f.job });
    }
    return set(key, value, options);
  };
  await dispatch.adoptCheckpoint('example', f.adoptOptions);
  assert.ok((await f.store.get(dispatch.REGISTRY_KEY)).jobs.some(v => v.jobId === 'example'));
  assert.equal((await dispatch.tick(f.options)).dispatched, true);
});

test("bounded orphan recovery preserves cursor and permits only source-free past targets", async () => {
  const f = await fixture({ state: 'interrupted' });
  await f.store.setJSON('current-job/v1', { jobId: 'example' });
  await f.store.setJSON('jobs/example', { ...f.job, errorCode: 'INSTANT_DISPATCH_FAILED' });
  const resumed = await dispatch.recoverWaiting(f.options);
  assert.equal(resumed.calculationCursor, 250); assert.equal(resumed.autoRecovery.attempts, 1);
  assert.equal(resumed.instantInputsHash, f.job.instantInputsHash); assert.equal(f.calls.length, 0);
  const blocked = await fixture({ state: 'interrupted', phase: 'collection' });
  await blocked.store.setJSON('current-job/v1', { jobId: 'example' });
  await blocked.store.setJSON('jobs/example', { ...blocked.job, errorCode: 'INSTANT_DISPATCH_FAILED' });
  assert.equal(await dispatch.recoverWaiting(blocked.options), null);
});

test("orphan retry bounds, backoff, active leases, completed and corrupt state are enforced", async () => {
  const f = await fixture({ state: 'interrupted' });
  await f.store.setJSON('current-job/v1', { jobId: 'example' });
  const base = { ...f.job, errorCode: 'INSTANT_DISPATCH_FAILED' };
  for (const patch of [{ state: 'completed' }, { autoRecovery: { attempts: 2 } },
    { autoRecovery: { attempts: 1, lastAttemptAt: new Date(f.options.now()).toISOString() } },
    { instantWorker: { token: 'active', expiresAt: f.options.now() + 10000 } }, { errorCode: 'INSTANT_ARTIFACT_INTEGRITY' }]) {
    await f.store.setJSON('jobs/example', { ...base, ...patch }); assert.equal(await dispatch.recoverWaiting(f.options), null);
  }
  await f.store.setJSON('jobs/example', { ...base, errorCode: null, errors: ['Analysis job stopped updating and was released.'] });
  assert.ok(await dispatch.recoverWaiting(f.options));
});

test("automatic orphan recovery uses preserved hints even when current pointer changes", async () => {
  const f = await fixture({ state: 'interrupted' });
  await f.store.setJSON('jobs/example', { ...f.job, errorCode: 'INSTANT_DISPATCH_FAILED' });
  await dispatch.registerJob('example', f.options);
  await dispatch.removeJob('example', { ...f.options, recoverable: f.job });
  await f.store.setJSON('current-job/v1', { jobId: 'unrelated-period' });
  assert.equal((await dispatch.recoverWaiting(f.options)).jobId, 'example');
  assert.equal((await f.store.get('current-job/v1')).jobId, 'unrelated-period');
});

test("bounded recovery scan rotates beyond eight unusable hints without listing Jobs", async () => {
  const f = await fixture({ state: 'interrupted' });
  await f.store.setJSON('jobs/example', { ...f.job, errorCode: 'INSTANT_DISPATCH_FAILED' });
  const hints = Array.from({ length: 9 }, (_, i) => ({ jobId: 'terminal-' + i, targetDataDate: '2026-10-26', createdAt: String(9-i) }));
  for (const hint of hints) await f.store.setJSON('jobs/' + hint.jobId, { ...hint, mode: 'instant', state: 'completed' });
  await f.store.setJSON(dispatch.REGISTRY_KEY, { version: 1, jobs: [], recoveryHints: [...hints, { jobId: 'example', targetDataDate: '2026-10-15' }] });
  let found = null;
  for (let n = 0; n < 3 && !found; n++) found = await dispatch.recoverWaiting(f.options);
  assert.equal(found.jobId, 'example'); assert.equal(f.calls.length, 0);
});

test("simultaneous orphan recovery cannot increment retry generation twice", async () => {
  const f = await fixture({ state: 'interrupted' });
  await f.store.setJSON('current-job/v1', { jobId: 'example' });
  await f.store.setJSON('jobs/example', { ...f.job, errorCode: 'INSTANT_DISPATCH_FAILED' });
  await Promise.all([dispatch.recoverWaiting(f.options), dispatch.recoverWaiting(f.options)]);
  assert.equal((await f.read()).autoRecovery.attempts, 1);
  assert.equal((await f.store.get(dispatch.REGISTRY_KEY)).jobs.filter(v => v.jobId === 'example').length, 1);
});

test("checkpoint reads reaching the preparation deadline do not begin an HTTP delivery", async () => {
  const f = await fixture(); await dispatch.registerJob("example", f.options);
  const get = f.store.get.bind(f.store);
  f.store.get = async key => {
    const value = await get(key); if (key === f.job.instantInputsKey) f.advance(dispatch.PRE_DISPATCH_BUDGET_MS); return value;
  };
  await dispatch.tick(f.options); assert.equal(f.calls.length, 0);
  assert.equal((await f.read()).continuationDispatch.attemptCount, undefined);
});
