const crypto = require("node:crypto");
const { getCompatibleStore } = require("./blob-store-compat");

const LEASE_MS = 12 * 60 * 1000;
const fail = (code, message) => Object.assign(new Error(message), { code });
const clock = options => options.now ? Number(options.now()) : Date.now();
const storeFor = options => options.store || getCompatibleStore({ name: "trend-analysis", consistency: "strong" });
const active = (lease, now) => Boolean(lease?.token && Number(lease.expiresAt) > now);
const owns = (job, lease, now) => job?.mode === "instant" && job.jobId === lease?.jobId
  && job.instantWorker?.token === lease.token && job.instantWorker?.fence === lease.fence && active(job.instantWorker, now)
  && ["running", "publishing", "publication_failed"].includes(job.state);

async function claimInstantWorker(jobId, options = {}) {
  const store = storeFor(options);
  for (let attempt = 0; attempt < 5; attempt++) {
    const entry = await store.getWithMetadata(`jobs/${jobId}`, { type: "json" });
    const job = entry?.data; const now = clock(options);
    const ticketProvided = options.continuationTicket != null;
    const dispatch = job?.continuationDispatch;
    if (dispatch?.attemptsExhausted || dispatch?.state === "blocked")
      return { claimed: false, reason: "continuation-dispatch-blocked", job };
    if (job?.state === "publication_failed" && dispatch?.state === "entered")
      return { claimed: false, reason: "publication-requires-explicit-resume", job };
    const matchingTicket = ticketProvided && typeof options.continuationTicket === "string" && Boolean(options.continuationTicket)
      && dispatch?.ticket === options.continuationTicket;
    if (dispatch?.ticket && !ticketProvided) return { claimed: false, reason: "continuation-ticket-required", job };
    if (ticketProvided && !matchingTicket) return { claimed: false, reason: "stale-continuation-delivery", job };
    const initialInputBoundary = Boolean(job?.instantInputsKey && job?.instantInputsHash)
      && !job?.instantStateKey && !Number(job?.instantStateRevision || 0) && !Number(job?.searchTrendApiCallCount || 0)
      && !Number(job?.calculationCursor || 0);
    const checkpointRedelivery = matchingTicket && dispatch.enteredAt && Boolean(job?.instantStateKey || initialInputBoundary)
      && !active(job?.instantWorker, now);
    if (matchingTicket && dispatch.enteredAt && !checkpointRedelivery)
      return { claimed: false, reason: "continuation-already-entered", job };
    const resumeDelivered = job?.state === "interrupted" && job.resumable === true && Boolean(job.instantStateKey)
      && (!job.errorCode || job.errorCode === "INSTANT_DISPATCH_FAILED")
      && matchingTicket && (!dispatch.enteredAt || checkpointRedelivery);
    if (!job || job.mode !== "instant" || !["running", "publishing", "publication_failed"].includes(job.state) && !resumeDelivered)
      return { claimed: false, reason: "not-runnable", job };
    if (active(job.instantWorker, now)) return { claimed: false, reason: "worker-active", job };
    const lease = { jobId, owner: options.owner || "instant-background", token: crypto.randomUUID(),
      fence: Number(job.instantWorker?.fence || 0) + 1, startedAt: new Date(now).toISOString(), expiresAt: now + LEASE_MS };
    const next = { ...job, ...(resumeDelivered ? { state: "running" } : {}), instantWorker: lease,
      ...(matchingTicket ? { continuationDispatch: { ...dispatch, state: "entered", enteredAt: new Date(now).toISOString(),
        firstEnteredAt: dispatch.firstEnteredAt || dispatch.enteredAt || new Date(now).toISOString(),
        redeliveryCount: Number(dispatch.redeliveryCount || 0) + (checkpointRedelivery ? 1 : 0),
        invocationId: lease.owner, workerFence: lease.fence } } : {}), invocationCount: Number(job.invocationCount || 0) + 1,
      updatedAt: new Date(now).toISOString() };
    if ((await store.setJSON(`jobs/${jobId}`, next, { onlyIfMatch: entry.etag }))?.modified)
      return { claimed: true, job: next, lease };
  }
  throw fail("INSTANT_WORKER_CONFLICT", "Instant ownership changed concurrently.");
}

async function assertInstantWorker(lease, options = {}) {
  const job = await storeFor(options).get(`jobs/${lease?.jobId}`, { type: "json" });
  if (!owns(job, lease, clock(options))) throw fail("INSTANT_WORKER_LOST", "Instant worker ownership expired or changed.");
  return job;
}

async function writeOwnedInstantJob(lease, patch, options = {}) {
  const store = storeFor(options);
  for (let attempt = 0; attempt < 5; attempt++) {
    const entry = await store.getWithMetadata(`jobs/${lease?.jobId}`, { type: "json" });
    const job = entry?.data; const now = clock(options);
    if (!owns(job, lease, now)) throw fail("INSTANT_WORKER_LOST", "A superseded Instant worker cannot write progress.");
    for (const key of ["jobId", "mode", "createdAt", "startDate", "endDate", "queryStartDate", "surgeThreshold", "matchThreshold",
      "collectionScope", "fastPath"])
      if (Object.hasOwn(patch, key) && patch[key] !== job[key]) throw fail("INSTANT_IDENTITY_CHANGED", "Instant analysis identity is immutable.");
    for (const key of ["targetDataDate", "calculationVersion", "orderedCandidateHash", "productVersionHash",
      "collectionObservationStartedAt", "collectionObservationDate"])
      if (job[key] != null && Object.hasOwn(patch, key) && patch[key] !== job[key])
        throw fail("INSTANT_IDENTITY_CHANGED", "Frozen Instant target and calculation version cannot change.");
    for (const key of ["instantInputsKey", "instantInputsHash"])
      if (job[key] && Object.hasOwn(patch, key) && patch[key] !== job[key])
        throw fail("INSTANT_INPUTS_CHANGED", "Frozen Instant inputs cannot be replaced.");
    if (options.expectedInstantStateRevision != null
      && Number(job.instantStateRevision || 0) !== options.expectedInstantStateRevision)
      throw fail("INSTANT_STATE_CONFLICT", "Another checkpoint was committed before this Instant write.");
    for (const key of ["collectionCursor", "calculationCursor", "ratioCursor", "enrichmentCursor", "evidenceCursor", "finalizeCursor",
      "instantStateRevision", "continuationCount"])
      if (Object.hasOwn(patch, key) && (!Number.isSafeInteger(patch[key]) || patch[key] < Number(job[key] || 0)))
        throw fail("INSTANT_CURSOR_REGRESSION", "Instant durable progress cannot move backwards.");
    const stages = ["collection", "numeric", "ratio", "enrichment", "evidence", "finalize", "publishing"];
    if (patch.instantStage != null && (!stages.includes(patch.instantStage)
      || job.instantStage && stages.indexOf(patch.instantStage) < stages.indexOf(job.instantStage)))
      throw fail("INSTANT_STAGE_REGRESSION", "Instant durable stages cannot move backwards.");
    if (["publishing", "publication_failed"].includes(job.state)
      && (patch.state && !["publishing", "publication_failed"].includes(patch.state)
        || patch.results && JSON.stringify(patch.results) !== JSON.stringify(job.results)))
      throw fail("INSTANT_WRITE_PROTECTED", "Saved calculation may only proceed to publication.");
    const next = { ...job, ...patch, instantWorker: options.release
      ? { ...job.instantWorker, token: null, expiresAt: 0, releasedAt: new Date(now).toISOString() }
      : { ...job.instantWorker, expiresAt: now + LEASE_MS }, updatedAt: new Date(now).toISOString() };
    // A delayed progress response cannot move the same invocation backwards.
    if (patch.progress != null && Number(patch.progress) < Number(job.progress || 0)) next.progress = job.progress;
    if (patch.currentStage === job.currentStage && patch.processedCount != null)
      next.processedCount = Math.max(Number(job.processedCount || 0), Number(patch.processedCount));
    if ((await store.setJSON(`jobs/${lease.jobId}`, next, { onlyIfMatch: entry.etag }))?.modified) return next;
  }
  throw fail("INSTANT_WORKER_CONFLICT", "Instant progress changed concurrently.");
}

async function releaseInstantWorker(lease, patch = {}, options = {}) {
  return writeOwnedInstantJob(lease, patch, { ...options, release: true });
}

module.exports = { claimInstantWorker, assertInstantWorker, writeOwnedInstantJob, releaseInstantWorker, LEASE_MS, active, owns };
