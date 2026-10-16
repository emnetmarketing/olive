const crypto = require("node:crypto");
const { getStore } = require("@netlify/blobs");
const { connectLambda, getCompatibleStore } = require("./blob-store-compat");
const periodPublication = require("./period-publication");
const { stagePointer, visiblePointer, patchInstantPublication, writeInstantJobGuarded } = require("./instant-publication");

const STORE = "trend-analysis";
const CURRENT_JOB_KEY = "current-job/v1";
const DIAGNOSTIC_INDEX_KEY = "diagnostics/latest-v1";
const STALE_JOB_MS = 12 * 60 * 1000;
const PERIOD_WORKER_LEASE_MS = STALE_JOB_MS;
const PERIOD_WRITE_ATTEMPTS = 5;
function connect(event) { if (event?.blobs) connectLambda(event); periodPublication.connect(event); }
function store() { return getStore(STORE); }
function lastSuccessKeys(mode) { return { mode: `last-success/${mode}`, latest: "last-success/latest" }; }
function lastPartialKeys(mode) { return { mode: `last-partial/${mode}`, latest: "last-partial/latest" }; }
async function readRawJob(jobId, { forMutation = false } = {}) {
  const blobStore = forMutation ? getCompatibleStore({ name: STORE, consistency: "strong" }) : store();
  return blobStore.get(`jobs/${jobId}`, { type: "json" });
}
function recoveryStore({ forMutation = false } = {}) {
  return forMutation ? getCompatibleStore({ name: "trend-period-recovery", consistency: "strong" }) : getStore("trend-period-recovery");
}
function recoveryControlKey(jobId) { return `jobs/${jobId}/control-v1`; }
function overlayRecovery(raw, control) {
  const phase = control.stage;
  const stages = { numeric: "calculation-matching", ratio: "calculation-ratio", evidence: "period-evidence",
    finalize: "finalizing", publishing: "publishing", completed: "publishing" };
  const cursor = phase === "ratio" ? control.ratioCursor : phase === "evidence" ? control.evidenceCursor : control.calculationCursor;
  const total = phase === "ratio" ? control.ratioTotalCount : phase === "evidence" ? control.evidenceTotalCount : control.totalCount;
  const interrupted = control.status === "resumable";
  return { ...raw, state: interrupted ? "interrupted" : phase === "publishing" || phase === "completed" ? "publishing" : "recovering",
    recovery: true, recoveryGeneration: control.generation, recoveryStage: phase, recoveryStatus: control.status,
    currentStage: stages[phase] || raw.currentStage, calculationCursor: control.calculationCursor,
    ratioCursor: control.ratioCursor, evidenceCursor: control.evidenceCursor,
    processedCount: Number(cursor ?? raw.processedCount ?? 0), totalCount: Number(total ?? raw.totalCount ?? 0),
    updatedAt: control.updatedAt || raw.updatedAt, resumable: control.resumable !== false,
    message: interrupted ? "기간 분석 복구가 중단됨 · 저장된 checkpoint에서 재개 가능" : "저장된 기간 데이터로 계산 및 결과 게시 진행 중",
    recoveryLastError: control.lastError || null };
}
async function readJob(jobId) {
  const raw = await readRawJob(jobId);
  if (raw?.mode === "instant") return raw;
  const published = await periodPublication.readPublishedJob(jobId);
  if (published?.job) return published.job;
  if (raw?.mode !== "period") return raw;
  const recovery = await recoveryStore().get(recoveryControlKey(jobId), { type: "json" });
  return recovery?.jobId === jobId ? overlayRecovery(raw, recovery) : raw;
}
function periodWorkerError(code, message) { return Object.assign(new Error(message), { code }); }
function mutationStore(options = {}) { return options.store || getCompatibleStore({ name: STORE, consistency: "strong" }); }
function clockMs(options = {}) { return options.now ? Number(options.now()) : Date.now(); }
function liveLease(lease, now) { return Boolean(lease?.token && Number(lease.expiresAt) > now); }
function matchesLease(job, lease, now) {
  return Boolean(job?.mode === "period" && lease?.jobId === job.jobId && job.workerLease?.token === lease.token
    && job.workerLease?.fence === lease.fence && liveLease(job.workerLease, now)
    && !["failed", "interrupted", "continuation_failed", "cancelled", "completed"].includes(job.state));
}
async function hasRecoveryFence(jobId, options = {}) {
  return Boolean(await (options.recoveryStore || recoveryStore({ forMutation: true })).get(recoveryControlKey(jobId), { type: "json" }));
}
async function writeJob(jobId, value) {
  if (value?.mode === "instant") return writeInstantJobGuarded(jobId, value);
  if (value?.mode !== "period") { await store().setJSON(`jobs/${jobId}`, value); return value; }
  const blobStore = mutationStore();
  const current = await blobStore.getWithMetadata(`jobs/${jobId}`, { type: "json" });
  // Once a new worker claims a Job, all progress/failure writes must carry its
  // fence. A delayed start error or legacy worker must not undo a newer owner.
  if (current?.data?.workerLease || await hasRecoveryFence(jobId))
    throw periodWorkerError("PERIOD_WORKER_REQUIRED", "This period Job requires its current worker ownership token.");
  const result = await blobStore.setJSON(`jobs/${jobId}`, value, current?.etag ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
  if (!result?.modified) throw periodWorkerError("PERIOD_WRITE_CONFLICT", "Period Job changed before its guarded write.");
  return value;
}
async function claimPeriodWorker(jobId, options = {}) {
  const blobStore = mutationStore(options);
  for (let attempt = 0; attempt < PERIOD_WRITE_ATTEMPTS; attempt += 1) {
    const entry = await blobStore.getWithMetadata(`jobs/${jobId}`, { type: "json" });
    const job = entry?.data; const now = clockMs(options);
    if (!job || job.mode !== "period" || !["running", "publishing", "publication_failed"].includes(job.state))
      return { claimed: false, reason: "not-runnable", job };
    if (await hasRecoveryFence(jobId, options)) return { claimed: false, reason: "recovery-fenced", job };
    if (liveLease(job.workerLease, now)) return { claimed: false, reason: "worker-active", job };
    const lease = { jobId, token: crypto.randomUUID(), owner: options.owner || "period-background",
      fence: Number(job.workerLease?.fence || 0) + 1, expiresAt: now + PERIOD_WORKER_LEASE_MS };
    const next = { ...job, workerLease: lease, updatedAt: new Date(now).toISOString() };
    if (await hasRecoveryFence(jobId, options)) return { claimed: false, reason: "recovery-fenced", job };
    const saved = await blobStore.setJSON(`jobs/${jobId}`, next, { onlyIfMatch: entry.etag });
    if (saved?.modified) return { claimed: true, job: next, lease };
  }
  throw periodWorkerError("PERIOD_WRITE_CONFLICT", "Another period worker changed the Job while acquiring ownership.");
}
async function assertPeriodWorker(lease, options = {}) {
  const raw = await mutationStore(options).get(`jobs/${lease?.jobId}`, { type: "json" });
  if (!matchesLease(raw, lease, clockMs(options)) || await hasRecoveryFence(lease?.jobId, options))
    throw periodWorkerError("PERIOD_WORKER_LOST", "The period worker no longer owns this Job.");
  return raw;
}
async function writeOwnedPeriodJob(lease, patch, options = {}) {
  const blobStore = mutationStore(options);
  for (let attempt = 0; attempt < PERIOD_WRITE_ATTEMPTS; attempt += 1) {
    const entry = await blobStore.getWithMetadata(`jobs/${lease?.jobId}`, { type: "json" });
    const raw = entry?.data; const now = clockMs(options);
    if (!matchesLease(raw, lease, now) || await hasRecoveryFence(lease?.jobId, options))
      throw periodWorkerError("PERIOD_WORKER_LOST", "The period worker no longer owns this Job.");
    for (const key of ["jobId", "mode", "createdAt", "startDate", "endDate", "queryStartDate", "surgeThreshold", "matchThreshold"])
      if (Object.hasOwn(patch || {}, key) && patch[key] !== raw[key])
        throw periodWorkerError("PERIOD_JOB_IDENTITY_CHANGED", "Period worker writes cannot change analysis identity or conditions.");
    for (const key of ["periodInputsKey", "periodInputsHash"])
      if (raw[key] && Object.hasOwn(patch || {}, key) && patch[key] !== raw[key])
        throw periodWorkerError("PERIOD_INPUTS_CHANGED", "Frozen period calculation inputs cannot be replaced.");
    if (patch?.calculationCursor != null && Number(patch.calculationCursor) < Number(raw.calculationCursor || 0))
      throw periodWorkerError("PERIOD_CURSOR_REGRESSION", "Period progress cannot move behind the saved checkpoint.");
    const workerLease = options.release ? { ...raw.workerLease, token: null, expiresAt: 0, releasedAt: new Date(now).toISOString() }
      : { ...raw.workerLease, expiresAt: now + PERIOD_WORKER_LEASE_MS };
    const next = { ...raw, ...patch, workerLease, updatedAt: new Date(now).toISOString() };
    if (await hasRecoveryFence(lease.jobId, options)) throw periodWorkerError("PERIOD_WORKER_LOST", "Period recovery superseded this worker.");
    const saved = await blobStore.setJSON(`jobs/${lease.jobId}`, next, { onlyIfMatch: entry.etag });
    if (saved?.modified) return next;
  }
  throw periodWorkerError("PERIOD_WRITE_CONFLICT", "Period progress changed concurrently; the worker must stop.");
}
async function releasePeriodWorker(lease, patch = {}, options = {}) {
  return writeOwnedPeriodJob(lease, patch, { ...options, release: true });
}
async function writePeriodCheckpoint(lease, value, options = {}) {
  const raw = await assertPeriodWorker(lease, options);
  if (value?.jobId !== raw.jobId || !Number.isSafeInteger(value?.calculationCursor) || value.calculationCursor < 0
    || !Number.isSafeInteger(value?.totalCount) || value.calculationCursor > value.totalCount
    || value.selectedStartDate != null && value.selectedStartDate !== raw.startDate
    || value.selectedEndDate != null && value.selectedEndDate !== raw.endDate
    || value.queryStartDate != null && value.queryStartDate !== raw.queryStartDate
    || value.requiredWindow != null && value.requiredWindow !== `${raw.queryStartDate}:${raw.endDate}`)
    throw periodWorkerError("PERIOD_CHECKPOINT_IDENTITY", "Period checkpoint must belong to the same Job, window and valid cursor range.");
  const blobStore = mutationStore(options);
  const hash = periodPublication.digest(value);
  const key = `jobs/${encodeURIComponent(lease.jobId)}/checkpoints/${Number(value.calculationCursor || 0)}-${hash}`;
  await blobStore.setJSON(key, value, { onlyIfNew: true });
  const stored = await blobStore.get(key, { type: "json" });
  if (!stored || periodPublication.digest(stored) !== hash)
    throw periodWorkerError("PERIOD_CHECKPOINT_VERIFY_FAILED", "Period checkpoint could not be read back intact.");
  return writeOwnedPeriodJob(lease, { calculationCheckpointKey: key, calculationCheckpointHash: hash,
    calculationCursor: Number(value.calculationCursor || 0), processedCount: Number(value.calculationCursor || 0),
    totalCount: Number(value.totalCount || value.candidateKeywords?.length || 0),
    checkpointUpdatedAt: value.updatedAt || new Date(clockMs(options)).toISOString() }, options);
}
async function readPeriodArtifact(job, keyField, hashField, options = {}) {
  if (!job?.[keyField]) return null;
  const value = await mutationStore(options).get(job[keyField], { type: "json" });
  if (!value || !job[hashField] || periodPublication.digest(value) !== job[hashField])
    throw periodWorkerError("PERIOD_ARTIFACT_INTEGRITY", "Saved period calculation data is missing or changed; do not restart from different inputs.");
  return value;
}
async function readPeriodCheckpoint(job, options = {}) {
  return readPeriodArtifact(job, "calculationCheckpointKey", "calculationCheckpointHash", options);
}
async function readPeriodInputs(job, options = {}) {
  return readPeriodArtifact(job, "periodInputsKey", "periodInputsHash", options);
}
async function writePeriodInputs(lease, value, options = {}) {
  const raw = await assertPeriodWorker(lease, options);
  if (raw.periodInputsKey) { await readPeriodInputs(raw, options); return raw; }
  const blobStore = mutationStore(options); const hash = periodPublication.digest(value);
  const key = `jobs/${encodeURIComponent(lease.jobId)}/inputs/${hash}`;
  await blobStore.setJSON(key, value, { onlyIfNew: true });
  const stored = await blobStore.get(key, { type: "json" });
  if (!stored || periodPublication.digest(stored) !== hash)
    throw periodWorkerError("PERIOD_INPUTS_VERIFY_FAILED", "Period calculation inputs could not be read back intact.");
  return writeOwnedPeriodJob(lease, { periodInputsKey: key, periodInputsHash: hash }, options);
}
function periodJobGeneration(job) {
  return Number(job?.publicationGeneration) || Date.parse(job?.createdAt || job?.completedAt || "") || 0;
}
async function readCanonicalPeriodKind(legacy, partial) {
  const published = await periodPublication.readLatestKind({ partial });
  const canonical = published?.job;
  if (!canonical || Boolean(canonical.partialAnalysis) !== partial) return legacy;
  return !legacy || periodJobGeneration(canonical) >= periodJobGeneration(legacy) ? canonical : legacy;
}
async function publishCompletedPeriod(job, snapshot, options = {}) {
  const generation = Date.parse(job?.createdAt || "");
  if (job?.mode !== "period" || !Number.isSafeInteger(generation)) throw new Error("A period Job creation generation is required for publication.");
  const publicationStore = periodPublication.store({ writable: true });
  const committed = await periodPublication.readPublishedJob(job.jobId, { store: publicationStore });
  // A previous attempt can commit latest, then fail while saving its receipt.
  // The catch handler changes mutable Job status/timestamps, not calculation.
  // Retry the verified immutable payload, never create a conflicting same-gen
  // body from those changed status fields or repeat collection/calculation.
  const retryCommitted = committed?.commit.generation === generation;
  const preparedJob = retryCommitted ? await publicationStore.get(committed.commit.bodyKey, { type: "json" }) : job;
  if (retryCommitted && periodPublication.digest(preparedJob) !== committed.commit.bodyHash)
    throw Object.assign(new Error("Prepared period body changed during publication retry."), { code: "PERIOD_PUBLICATION_INTEGRITY" });
  return periodPublication.publishPeriod({ job: preparedJob, snapshot: retryCommitted ? committed.snapshot : snapshot,
    generation, leaseToken: `normal-period:${job.jobId}:${generation}` }, {
    store: publicationStore,
    assertLease: async () => {
      const [raw, recovery] = await Promise.all([
        readRawJob(job.jobId, { forMutation: true }),
        recoveryStore({ forMutation: true }).get(recoveryControlKey(job.jobId), { type: "json" })
      ]);
      return Boolean(raw && raw.mode === "period" && raw.jobId === job.jobId && Date.parse(raw.createdAt || "") === generation
        && !["failed", "interrupted", "continuation_failed", "cancelled"].includes(raw.state) && !recovery
        && (!raw.workerLease || matchesLease(raw, options.lease, clockMs(options))));
    }
  });
}
async function writeLastSuccess(job, options = {}) {
  if (!job?.jobId || job.state !== "completed") throw new Error("Only a completed analysis job can be published as the last successful result.");
  const guarded = options.requiresCompleted === true && job.mode === "instant";
  const pointer = { jobId: job.jobId, mode: job.mode, completedAt: job.completedAt, updatedAt: new Date().toISOString(),
    ...(guarded ? { generation: Date.parse(job.createdAt) } : {}) };
  const keys = lastSuccessKeys(job.mode);
  const blobStore = options.store || (guarded ? getCompatibleStore({ name: STORE, consistency: "strong" }) : store());
  const read = options.readJob || (id => blobStore.get(`jobs/${id}`, { type: "json" }));
  await Promise.all([keys.mode, keys.latest].map(key => guarded ? stagePointer(blobStore, key, pointer, read) : blobStore.setJSON(key, pointer)));
  return pointer;
}
async function readLastSuccess(mode = "latest") {
  const pointer = await visiblePointer(await store().get(`last-success/${mode}`, { type: "json" }), readRawJob);
  const job = pointer?.jobId ? await readJob(pointer.jobId) : null;
  const legacy = job?.state === "completed" ? job : null;
  return mode === "period" ? readCanonicalPeriodKind(legacy, false) : legacy;
}
async function writeLastPartial(job, options = {}) {
  if (!job?.jobId || job.state !== "completed" || !job.partialAnalysis) throw new Error("Only a completed partial analysis job can be published.");
  const guarded = options.requiresCompleted === true && job.mode === "instant";
  const pointer = { jobId: job.jobId, mode: job.mode, completedAt: job.completedAt, updatedAt: new Date().toISOString(),
    ...(guarded ? { generation: Date.parse(job.createdAt) } : {}) };
  const keys = lastPartialKeys(job.mode);
  const blobStore = options.store || (guarded ? getCompatibleStore({ name: STORE, consistency: "strong" }) : store());
  const read = options.readJob || (id => blobStore.get(`jobs/${id}`, { type: "json" }));
  await Promise.all([keys.mode, keys.latest].map(key => guarded ? stagePointer(blobStore, key, pointer, read) : blobStore.setJSON(key, pointer)));
  return pointer;
}
async function readLastPartial(mode = "latest") {
  const pointer = await visiblePointer(await store().get(`last-partial/${mode}`, { type: "json" }), readRawJob);
  const job = pointer?.jobId ? await readJob(pointer.jobId) : null;
  const legacy = job?.state === "completed" && job.partialAnalysis ? job : null;
  return mode === "period" ? readCanonicalPeriodKind(legacy, true) : legacy;
}
async function writeDiagnosticIndex(value) { await store().setJSON(DIAGNOSTIC_INDEX_KEY, value); return value; }
async function readDiagnosticIndex() { return store().get(DIAGNOSTIC_INDEX_KEY, { type: "json" }).catch(() => null); }

async function createJob(input) {
  const now = new Date().toISOString();
  const job = { jobId: crypto.randomUUID(), state: "running", message: "분석 준비 중", createdAt: now, updatedAt: now, progress: 0, ...input };
  await writeJob(job.jobId, job);
  return job;
}
function checkpointProgress(job) {
  if (job?.mode !== "instant" || !job.instantStateKey) {
    const cursor = Number(job?.calculationCursor || job?.processedCount || 0);
    return { lastCursor: cursor, remainingCount: Math.max(0, Number(job?.totalCount || 0) - cursor) };
  }
  const cursor = Number.isSafeInteger(job.instantStageCursor) ? job.instantStageCursor : null;
  const currentStages = { collection: "search-trend", numeric: "calculation-matching", ratio: "calculation-ratio", evidence: "instant-evidence" };
  const explicitTotal = Number.isSafeInteger(job.instantStageTotalCount) && job.instantStageTotalCount >= 0 ? job.instantStageTotalCount : null;
  const sameStageTotal = currentStages[job.instantStage] === job.currentStage && Number.isSafeInteger(job.totalCount) && job.totalCount >= 0
    ? job.totalCount : null;
  const total = explicitTotal ?? sameStageTotal;
  // A completed numeric cursor is not an enrichment/publication cursor. When
  // the current stage total was not persisted, report unknown instead of zero.
  return { checkpointStage: job.instantStage || null, lastCursor: cursor, checkpointTotalCount: total,
    remainingCount: cursor != null && total != null ? Math.max(0, total - cursor) : null };
}
async function readCurrentJob({ markStale = false, includeStale = false } = {}) {
  const pointer = await store().get(CURRENT_JOB_KEY, { type: "json" });
  if (!pointer?.jobId) return null;
  const job = await readJob(pointer.jobId);
  if (!job || !["running", "publishing", "recovering"].includes(job.state)) {
    if (includeStale && job?.mode === "instant" && job.resumable && (job.instantStateKey || Array.isArray(job.results) && job.state === "publication_failed"))
      return { ...job, ...checkpointProgress(job), stale: true };
    return null;
  }
  const age = Date.now() - Date.parse(job.updatedAt || job.createdAt || 0);
  if (Number.isFinite(age) && age <= STALE_JOB_MS) return job;
  // Recovery owns its immutable artifacts and control record. A legacy lock
  // read must not rewrite the original Job from this read-only status overlay.
  if (job.recovery) return includeStale ? { ...job, stale: true, state: "interrupted", resumable: true } : null;
  if (includeStale && !markStale) return { ...job, stale: true, resumable: Boolean(job.historicalCollection || job.instantStateKey),
    currentStage: "interrupted", message: "분석 실행이 중단됨 · 저장된 checkpoint/cache에서 재개 가능",
    ...checkpointProgress(job) };
  if (markStale) {
    const patch = { state: job.historicalCollection || job.instantStateKey ? "interrupted" : "failed", resumable: Boolean(job.historicalCollection || job.instantStateKey),
      currentStage: job.historicalCollection ? "interrupted" : job.currentStage,
      message: job.historicalCollection ? "기간 분석 중단 · 저장된 checkpoint/cache에서 재개 가능" : "Stale analysis job expired.",
      ...checkpointProgress(job), failedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      errors: ["Analysis job stopped updating and was released."] };
    if (job.mode === "period") {
      const blobStore = mutationStore();
      const entry = await blobStore.getWithMetadata(`jobs/${job.jobId}`, { type: "json" });
      const raw = entry?.data;
      // Recheck the authoritative Job immediately before CAS: an eventually
      // consistent UI read must not interrupt a worker that just progressed.
      if (!raw || !["running", "publishing"].includes(raw.state) || await hasRecoveryFence(job.jobId)) return null;
      if (Date.now() - Date.parse(raw.updatedAt || raw.createdAt || 0) <= STALE_JOB_MS || liveLease(raw.workerLease, Date.now())) return raw;
      const result = await blobStore.setJSON(`jobs/${job.jobId}`, { ...raw, ...patch }, { onlyIfMatch: entry.etag });
      if (!result?.modified) return readCurrentJob();
    } else if (job.mode === "instant" && job.currentStage === "publishing" && Array.isArray(job.results)) {
      await patchInstantPublication(job.jobId, { state: "publication_failed", publicationState: "pending", resumable: true,
        message: "자동 계산 보존 · 결과 게시 재시도 필요", failedAt: new Date().toISOString() });
    } else await writeJob(job.jobId, { ...job, ...patch });
  }
  return null;
}
async function acquireJob(input) {
  const blobStore = store();
  const currentEntry = await blobStore.getWithMetadata(CURRENT_JOB_KEY, { type: "json" });
  const active = await readCurrentJob({ markStale: true });
  if (active) return { job: active, existing: true };
  const job = await createJob(input);
  const condition = currentEntry?.etag ? { onlyIfMatch: currentEntry.etag } : { onlyIfNew: true };
  const lock = await blobStore.setJSON(CURRENT_JOB_KEY, { jobId: job.jobId, createdAt: job.createdAt }, condition);
  if (!lock.modified) {
    await writeJob(job.jobId, { ...job, state: "failed", message: "Another analysis job acquired the execution lock.",
      failedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), errors: ["Duplicate analysis start was prevented."] });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const winner = await readCurrentJob();
      if (winner) return { job: winner, existing: true };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Analysis lock was acquired but the active job could not be read.");
  }
  return { job, existing: false };
}

module.exports = { connect, store, readJob, readRawJob, writeJob, createJob, acquireJob, readCurrentJob, writeLastSuccess, readLastSuccess,
  writeLastPartial, readLastPartial, writeDiagnosticIndex, readDiagnosticIndex, lastSuccessKeys, lastPartialKeys,
  publishCompletedPeriod, periodJobGeneration, claimPeriodWorker, assertPeriodWorker, writeOwnedPeriodJob, releasePeriodWorker,
  writePeriodCheckpoint, readPeriodCheckpoint, writePeriodInputs, readPeriodInputs, PERIOD_WORKER_LEASE_MS,
  CURRENT_JOB_KEY, DIAGNOSTIC_INDEX_KEY, STALE_JOB_MS, checkpointProgress };
