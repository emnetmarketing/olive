// Durable outbox delivery. Only this independently scheduled entry sends a
// worker request; a worker never needs to call itself to make progress.
const crypto = require("node:crypto");
const { getCompatibleStore } = require("./blob-store-compat");
const artifacts = require("./instant-continuation");
const { CALCULATION_VERSION } = require("./surge-history-cache");
const { active } = require("./instant-worker");

const REGISTRY_KEY = "instant-dispatch/v1";
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 10000;
const DISPATCH_LEASE_MS = 60000;
const ACCEPTED_GRACE_MS = 120000;
const BACKOFF_MS = [60000, 120000, 300000, 600000, 900000];
const MAX_HINTS_PER_TICK = 8;
const PRE_DISPATCH_BUDGET_MS = 12000;
const MAX_AUTO_RECOVERIES = 2;
const RECOVERY_BACKOFF_MS = [120000, 600000];
const MAX_RECOVERY_HINTS = 16;
const fail = (code, message) => Object.assign(new Error(message), { code });
const clock = options => options.now ? Number(options.now()) : Date.now();
const storeFor = options => options.store || getCompatibleStore({ name: "trend-analysis", consistency: "strong" });
const iso = value => new Date(value).toISOString();
const validId = jobId => typeof jobId === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(jobId);
const dueAt = value => Number.isFinite(Date.parse(value || "")) ? Date.parse(value) : 0;
function assertId(jobId) { if (!validId(jobId)) throw fail("INVALID_INSTANT_JOB_ID", "A bounded Instant Job ID is required."); }

async function mutateRegistry(change, options = {}) {
  const store = storeFor(options);
  for (let n = 0; n < 8; n++) {
    const entry = await store.getWithMetadata(REGISTRY_KEY, { type: "json" });
    const previous = entry?.data || { version: 1, jobs: [] };
    const next = change(previous);
    if (!next) return previous;
    const result = await store.setJSON(REGISTRY_KEY, next, entry?.etag ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
    if (result?.modified) return next;
  }
  throw fail("INSTANT_DISPATCH_CONFLICT", "Instant dispatch registry changed concurrently.");
}
async function registerJob(jobId, options = {}) {
  assertId(jobId);
  const saved = options.hint ? null : await storeFor(options).get(`jobs/${jobId}`, { type: "json" });
  const metadata = options.hint || { targetDataDate: saved?.targetDataDate, createdAt: saved?.createdAt };
  return mutateRegistry(previous => {
    const existing = previous.jobs.find(item => item.jobId === jobId);
    if (existing && (!metadata.targetDataDate || existing.targetDataDate === metadata.targetDataDate)) return null;
    if (previous.jobs.length >= 256) throw fail("INSTANT_DISPATCH_REGISTRY_FULL", "Pending Instant registry is full; existing Jobs are preserved.");
    const hint = { ...existing, jobId, registeredAt: existing?.registeredAt || iso(clock(options)), ...metadata };
    return { ...previous, jobs: [...previous.jobs.filter(item => item.jobId !== jobId), hint], recoveryHints: [...(previous.recoveryHints || [])
      .filter(item => item.jobId !== jobId), hint].slice(-MAX_RECOVERY_HINTS) };
  }, options);
}
async function removeJob(jobId, options = {}) {
  assertId(jobId);
  return mutateRegistry(previous => previous.jobs.some(item => item.jobId === jobId)
    ? { ...previous, jobs: previous.jobs.filter(item => item.jobId !== jobId),
      recoveryHints: options.recoverable ? [...(previous.recoveryHints || []).filter(item => item.jobId !== jobId),
        { jobId, targetDataDate: options.recoverable.targetDataDate, createdAt: options.recoverable.createdAt }].slice(-MAX_RECOVERY_HINTS)
        : (previous.recoveryHints || []).filter(item => item.jobId !== jobId) } : null, options);
}
async function mutateJob(jobId, change, options = {}) {
  const store = storeFor(options);
  for (let n = 0; n < 8; n++) {
    const entry = await store.getWithMetadata(`jobs/${jobId}`, { type: "json" });
    if (!entry?.data) return null;
    const next = await change(entry.data);
    if (!next) return null;
    if ((await store.setJSON(`jobs/${jobId}`, next, { onlyIfMatch: entry.etag }))?.modified) return next;
  }
  throw fail("INSTANT_DISPATCH_CONFLICT", "Instant Job changed concurrently during dispatch.");
}
function untouchedInitial(job) {
  return job?.mode === "instant" && job.state === "running" && !job.instantInputsKey && !job.instantStateKey
    && !job.instantWorker && !Number(job.invocationCount || 0) && !Number(job.instantStateRevision || 0)
    && !Number(job.searchTrendApiCallCount || 0) && !Number(job.calculationCursor || 0);
}
async function enqueueInitial(jobId, options = {}) {
  assertId(jobId);
  // Register first. A crash before the Job CAS is recoverable by the next tick.
  await registerJob(jobId, options);
  const job = await mutateJob(jobId, current => {
    if (!untouchedInitial(current)) throw fail("INSTANT_INITIAL_NOT_SAFE", "Only an untouched new Instant Job may be initially queued.");
    if (current.continuationDispatch?.ticket) return null;
    const at = iso(clock(options));
    return { ...current, continuationDispatch: { ticket: crypto.randomUUID(), state: "pending", number: 0,
      requestedAt: at, readyAt: at, initial: true, attemptCount: 0 } };
  }, options);
  return job || storeFor(options).get(`jobs/${jobId}`, { type: "json" });
}

async function validateCheckpoint(job, options = {}) {
  if (untouchedInitial(job)) return;
  const input = await artifacts.readInputs(job, { store: storeFor(options) });
  const initialBoundary = !job.instantStateKey && !job.instantStateHash && !Number(job.instantStateRevision || 0)
    && !Number(job.searchTrendApiCallCount || 0) && !Number(job.calculationCursor || 0);
  const derivedMatches = (inputValue, savedValue) => inputValue === savedValue || initialBoundary && savedValue == null;
  if (!input || input.jobId !== job.jobId || input.startDate !== job.startDate || input.endDate !== job.endDate
    || input.queryStartDate !== job.queryStartDate || input.requiredWindow !== `${job.queryStartDate}:${job.endDate}`
    || !derivedMatches(input.targetDataDate, job.targetDataDate)
    || input.surgeThreshold !== job.surgeThreshold || input.matchThreshold !== job.matchThreshold
    || !derivedMatches(input.orderedCandidateHash, job.orderedCandidateHash)
    || !derivedMatches(input.calculationVersion, job.calculationVersion)
    || !derivedMatches(input.productHash, job.productVersionHash))
    throw fail("INSTANT_DISPATCH_INPUT_MISMATCH", "Frozen Instant inputs and target do not match the saved Job.");
  const state = await artifacts.readState(job, { store: storeFor(options) });
  if (!state) {
    // The pipeline can rebuild only its initial empty state from frozen inputs.
    if (Number(job.instantStateRevision || 0) || Number(job.searchTrendApiCallCount || 0) || Number(job.calculationCursor || 0))
      throw fail("INSTANT_DISPATCH_CHECKPOINT_MISSING", "A durable checkpoint is required after any source/calculation work.");
  }
}
async function adoptCheckpoint(jobId, options = {}) {
  assertId(jobId);
  // This hint is advisory: an unadopted interrupted Job remains ineligible.
  // Registering first avoids losing an authorized adoption between two keys.
  await registerJob(jobId, options);
  const job = await mutateJob(jobId, async current => {
    if (current.mode !== "instant" || !["interrupted", "continuation_failed", "publication_failed"].includes(current.state)
      || current.resumable !== true || active(current.instantWorker, clock(options)))
      throw fail("INSTANT_ADOPTION_NOT_SAFE", "Only an explicitly interrupted, inactive, resumable Instant Job may be adopted.");
    if (!options.expectedInputsHash || !options.expectedStateHash || options.expectedInputsHash !== current.instantInputsHash
      || options.expectedStateHash !== current.instantStateHash
      || options.expectedTargetDataDate && options.expectedTargetDataDate !== current.targetDataDate)
      throw fail("INSTANT_ADOPTION_CHANGED", "The audited checkpoint, input hash, or target changed before adoption.");
    await validateCheckpoint(current, options);
    const at = iso(clock(options)), previous = current.continuationDispatch || {};
    if (options.automatic && !autoRecoverable(current, clock(options), options)) return null;
    return { ...current, state: current.state === "publication_failed" ? "publication_failed" : "running",
      errorCode: null, dispatchErrorCode: null, errors: [], failedAt: null,
      ...(options.automatic ? { autoRecovery: { attempts: Number(current.autoRecovery?.attempts || 0) + 1, lastAttemptAt: at } } : {}),
      continuationDispatch: { ...previous, ticket: previous.ticket || crypto.randomUUID(), state: "pending",
        number: previous.number ?? Number(current.continuationCount || 0), requestedAt: previous.requestedAt || at,
        readyAt: at, nextAttemptAt: at, attemptCount: 0, attemptToken: null, dispatchLeaseUntil: 0,
        blockedAt: null, attemptsExhausted: false, adoptedAt: at, expectedInputsHash: current.instantInputsHash,
        expectedStateHash: current.instantStateHash,
        adoptedPreviousError: { errorCode: current.errorCode || current.dispatchErrorCode || null, failedAt: current.failedAt || null,
          errors: Array.isArray(current.errors) ? current.errors.map(value => String(value).slice(0, 400)).slice(0, 5) : [] } }, resumable: true };
  }, options);
  if (!job) throw fail("INSTANT_ADOPTION_NOT_FOUND", "The requested Instant Job is unavailable.");
  // A scheduler may remove the first advisory hint while the Job is still
  // interrupted. Re-register after CAS as well; recovery hints cover a crash
  // between this CAS and the second registration.
  await registerJob(jobId, { ...options, hint: { targetDataDate: job.targetDataDate, createdAt: job.createdAt } });
  return job;
}

function targetToday(now) { return new Date(now + 9 * 3600000 - 86400000).toISOString().slice(0, 10); }
function sourceFree(job) {
  return job.fastPath === true || ["evidence", "finalize", "publishing"].includes(job.instantStage)
    || job.collectionScope === "search-trend-only" && ["numeric", "ratio", "enrichment"].includes(job.instantStage);
}
function autoRecoverable(job, now, options = {}) {
  if (!job || job.mode !== "instant" || job.resumable !== true || active(job.instantWorker, now)
    || !job.instantInputsKey || !job.instantStateKey || job.calculationVersion !== CALCULATION_VERSION) return false;
  if (Number(job.continuationCount || 0) >= artifacts.MAX_CONTINUATIONS) return false;
  if (options.requiredCollectionTarget && (job.targetDataDate !== options.requiredCollectionTarget || job.fastPath
    || job.collectionScope === "search-trend-only")) return false;
  if (job.targetDataDate !== targetToday(now) && !sourceFree(job)) return false;
  if (!["running", "publishing", "interrupted", "continuation_failed", "publication_failed"].includes(job.state)) return false;
  const attempts = Number(job.autoRecovery?.attempts || 0);
  if (attempts >= MAX_AUTO_RECOVERIES) return false;
  const since = Math.max(dueAt(job.autoRecovery?.lastAttemptAt), dueAt(job.failedAt), dueAt(job.updatedAt));
  if (since + RECOVERY_BACKOFF_MS[attempts] > now) return false;
  if (["running", "publishing"].includes(job.state)) return true;
  const code = job.errorCode || job.dispatchErrorCode || job.continuationDispatch?.lastErrorCode || "";
  return /^(INSTANT_DISPATCH_(FAILED|ATTEMPTS_EXHAUSTED)|DISPATCH_RESPONSE_(TIMEOUT|UNAVAILABLE)|HTTP_(408|429|5\d\d)|WRITE_FAILED|FETCH_ERROR|ECONNRESET|ETIMEDOUT)$/.test(code)
    || !code && (job.errors || []).includes("Analysis job stopped updating and was released.");
}
async function recoverWaiting(options = {}) {
  const store = storeFor(options), now = clock(options);
  const registry = await store.get(REGISTRY_KEY, { type: "json" });
  const pointer = await store.get("current-job/v1", { type: "json" });
  const hints = [...(registry?.recoveryHints || [])].sort((a, b) => String(b.targetDataDate || "").localeCompare(String(a.targetDataDate || ""))
    || String(b.createdAt || b.registeredAt || "").localeCompare(String(a.createdAt || a.registeredAt || "")));
  const allIds = [...new Set([pointer?.jobId, ...hints.map(v => v.jobId)].filter(validId))];
  const rest = allIds.slice(2), offset = rest.length ? Number(registry?.recoveryScanOffset || 0) % rest.length : 0;
  const ids = [...allIds.slice(0, 2), ...rest.slice(offset), ...rest.slice(0, offset)].slice(0, MAX_HINTS_PER_TICK);
  if (allIds.length > MAX_HINTS_PER_TICK) await mutateRegistry(previous => ({ ...previous,
    recoveryScanOffset: (offset + MAX_HINTS_PER_TICK - 2) % rest.length }), options);
  const jobs = [];
  for (const id of ids) {
    if (options.dispatchDeadline && clock(options) >= options.dispatchDeadline) break;
    const job = await store.get(`jobs/${id}`, { type: "json" }); if (job) jobs.push(job);
  }
  jobs.sort((a, b) => String(b.targetDataDate || "").localeCompare(String(a.targetDataDate || ""))
    || String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  for (const job of jobs) {
    if (options.dispatchDeadline && clock(options) >= options.dispatchDeadline) break;
    if (!autoRecoverable(job, now, options)) continue;
    const quarantined = hints.find(hint => hint.jobId === job.jobId && hint.blockedInputHash === job.instantInputsHash
      && hint.blockedStateHash === job.instantStateHash);
    if (quarantined) continue;
    if (jobs.some(other => other.jobId !== job.jobId && active(other.instantWorker, now))) continue;
    // A newer equivalent operation wins; never merge different frozen inputs.
    if (jobs.some(other => other.jobId !== job.jobId && other.targetDataDate === job.targetDataDate
      && other.startDate === job.startDate && other.endDate === job.endDate && other.fastPath === job.fastPath
      && ["running", "publishing", "completed"].includes(other.state)
      && other.collectionScope === job.collectionScope && other.orderedCandidateHash === job.orderedCandidateHash
      && other.productVersionHash === job.productVersionHash && other.calculationVersion === job.calculationVersion
      && other.surgeThreshold === job.surgeThreshold && other.matchThreshold === job.matchThreshold
      && String(other.createdAt || "") > String(job.createdAt || ""))) continue;
    try {
      await validateCheckpoint(job, options);
      if (options.dispatchDeadline && clock(options) >= options.dispatchDeadline) break;
      if (["running", "publishing"].includes(job.state)) {
        await registerJob(job.jobId, { ...options, hint: { targetDataDate: job.targetDataDate, createdAt: job.createdAt } });
        return job;
      }
      return await adoptCheckpoint(job.jobId, { ...options, automatic: true, expectedInputsHash: job.instantInputsHash,
        expectedStateHash: job.instantStateHash, expectedTargetDataDate: job.targetDataDate });
    } catch (error) {
      if (!/^INSTANT_/.test(error.code || "")) throw error;
      if (/^INSTANT_(ARTIFACT_|STATE_|DISPATCH_INPUT_MISMATCH|DISPATCH_CHECKPOINT_MISSING)/.test(error.code)) {
        await mutateRegistry(previous => ({ ...previous, recoveryHints: [...(previous.recoveryHints || []).filter(h => h.jobId !== job.jobId),
          { jobId: job.jobId, targetDataDate: job.targetDataDate, createdAt: job.createdAt,
            blockedInputHash: job.instantInputsHash, blockedStateHash: job.instantStateHash, blockedReason: error.code }].slice(-MAX_RECOVERY_HINTS) }), options);
      }
      break; // At most one large checkpoint validation per recovery tick.
    }
  }
  return null;
}

function canDispatch(job, now) {
  if (!job || job.mode !== "instant" || !["running", "publishing", "publication_failed"].includes(job.state)) return false;
  if (active(job.instantWorker, now)) return false;
  const dispatch = job.continuationDispatch;
  if (!dispatch?.ticket || dispatch.attemptsExhausted || dispatch.state === "blocked") return false;
  // An explicit worker failure is not a request to retry its computation forever.
  if (job.state === "publication_failed" && (!dispatch.adoptedAt || dispatch.state === "entered")) return false;
  if (Number(dispatch.dispatchLeaseUntil || 0) > now || Math.max(dueAt(dispatch.readyAt), dueAt(dispatch.nextAttemptAt)) > now) return false;
  if (dispatch.state === "accepted" && !dispatch.enteredAt && dueAt(dispatch.acceptedAt) + ACCEPTED_GRACE_MS > now) return false;
  return true;
}
async function claimDispatch(jobId, options) {
  const now = clock(options), token = crypto.randomUUID();
  return mutateJob(jobId, async job => {
    if (!canDispatch(job, now)) return null;
    try { await validateCheckpoint(job, options); }
    catch (error) {
      if (/^INSTANT_(ARTIFACT_|STATE_|DISPATCH_INPUT_MISMATCH|DISPATCH_CHECKPOINT_MISSING)/.test(error.code || ""))
        return blocked(job, error.code, clock(options));
      throw error;
    }
    if (options.dispatchDeadline != null && clock(options) >= options.dispatchDeadline) return null;
    const previous = job.continuationDispatch;
    if (Number(previous.attemptCount || 0) >= MAX_ATTEMPTS) return blocked(job, "INSTANT_DISPATCH_ATTEMPTS_EXHAUSTED", now);
    return { ...job, continuationDispatch: { ...previous, state: "dispatching", attemptToken: token,
      attemptCount: Number(previous.attemptCount || 0) + 1, dispatchLeaseUntil: now + DISPATCH_LEASE_MS,
      lastAttemptAt: iso(now), requestId: options.requestId || null } };
  }, options);
}
function blocked(job, code, now) {
  return { ...job, state: ["publishing", "publication_failed"].includes(job.state) ? "publication_failed" : "interrupted",
    resumable: Boolean(job.instantStateKey || Array.isArray(job.results)),
    message: "다음 실행 연결 중단 · 저장된 checkpoint 보존 · 명시적 재개 필요",
    dispatchErrorCode: code, continuationDispatch: { ...job.continuationDispatch, state: "blocked", attemptsExhausted: true,
      dispatchLeaseUntil: 0, blockedAt: iso(now), lastErrorCode: code } };
}
async function finishDispatch(jobId, ticket, attemptToken, outcome, options) {
  return mutateJob(jobId, job => {
    const dispatch = job.continuationDispatch;
    if (job.state === "completed" || dispatch?.ticket !== ticket || dispatch.attemptToken !== attemptToken
      || dispatch.state !== "dispatching") return null;
    const now = clock(options), success = outcome.status >= 200 && outcome.status < 300;
    if (!success && Number(dispatch.attemptCount || 0) >= MAX_ATTEMPTS) return blocked(job, outcome.code, now);
    return { ...job, continuationDispatch: { ...dispatch, state: success ? "accepted" : "pending", dispatchLeaseUntil: 0,
      ...(success ? { acceptedAt: iso(now) } : {}), lastHttpStatus: outcome.status || null,
      lastErrorCode: success ? null : outcome.code, responseAt: iso(now),
      nextAttemptAt: iso(now + (success ? ACCEPTED_GRACE_MS : BACKOFF_MS[Math.min(Number(dispatch.attemptCount || 1) - 1, BACKOFF_MS.length - 1)])) } };
  }, options);
}

async function tick(options = {}) {
  const store = storeFor(options), now = clock(options), leaseToken = crypto.randomUUID();
  let initial = await store.get(REGISTRY_KEY, { type: "json" });
  if (Math.floor(now / 60000) % 10 === 0) {
    await recoverWaiting({ ...options, dispatchDeadline: now + PRE_DISPATCH_BUDGET_MS });
    initial = await store.get(REGISTRY_KEY, { type: "json" });
  }
  if (!initial?.jobs?.length) return { status: "idle", dispatched: false };
  const registry = await mutateRegistry(previous => {
    if (Number(previous.lease?.expiresAt || 0) > now) return null;
    return { ...previous, lease: { token: leaseToken, expiresAt: now + DISPATCH_LEASE_MS } };
  }, options);
  if (registry.lease?.token !== leaseToken) return { status: "busy", dispatched: false };
  let lastScanned = registry.scanAfterJobId || null;
  const startIndex = Math.max(0, registry.jobs.findIndex(item => item.jobId === lastScanned) + 1) % registry.jobs.length;
  const hints = [...registry.jobs.slice(startIndex), ...registry.jobs.slice(0, startIndex)]
    .sort((a, b) => String(b.targetDataDate || "").localeCompare(String(a.targetDataDate || ""))).slice(0, MAX_HINTS_PER_TICK);
  const boundedOptions = { ...options, dispatchDeadline: now + PRE_DISPATCH_BUDGET_MS };
  const issues = [];
  try {
    for (const hint of hints) {
      if (clock(options) >= boundedOptions.dispatchDeadline) break;
      lastScanned = hint.jobId;
      let job = await store.get(`jobs/${hint.jobId}`, { type: "json" });
      if (!job || ["completed", "cancelled"].includes(job.state)) { await removeJob(hint.jobId, options); continue; }
      // Keep failed Jobs and checkpoints; discard only their advisory queue hint.
      // Explicit adoption registers the hint again after checking audited hashes.
      if (["interrupted", "continuation_failed", "failed"].includes(job.state)
        || job.continuationDispatch?.state === "blocked"
        || job.state === "publication_failed" && (!job.continuationDispatch?.adoptedAt || job.continuationDispatch.state === "entered")) {
        await removeJob(hint.jobId, { ...options, recoverable: job }); continue;
      }
      if (!job.continuationDispatch?.ticket && untouchedInitial(job)) job = await enqueueInitial(job.jobId, options);
      if (!canDispatch(job, clock(options))) continue;
      let claimed;
      try { claimed = await claimDispatch(job.jobId, boundedOptions); }
      catch (error) { issues.push({ jobId: job.jobId, code: error.code || "INSTANT_DISPATCH_READ_FAILED" }); continue; }
      if (!claimed) continue;
      if (claimed.continuationDispatch.state === "blocked") {
        issues.push({ jobId: job.jobId, code: claimed.dispatchErrorCode });
        await removeJob(job.jobId, options); continue;
      }
      const dispatch = claimed.continuationDispatch;
      const base = new URL(options.baseURL || process.env.URL || "");
      if (base.protocol !== "https:" || base.search || base.hash || base.username || base.password)
        throw fail("INSTANT_DISPATCH_URL_INVALID", "A configured HTTPS site URL is required.");
      let outcome;
      try {
        const response = await (options.fetch || global.fetch)(new URL("/.netlify/functions/trend-analysis-background", base).href, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: job.jobId, continuationTicket: dispatch.ticket }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        outcome = { status: response.status, code: `HTTP_${response.status}` };
      } catch (error) { outcome = { status: null, code: error.name === "TimeoutError" ? "DISPATCH_RESPONSE_TIMEOUT" : "DISPATCH_RESPONSE_UNAVAILABLE" }; }
      const updated = await finishDispatch(job.jobId, dispatch.ticket, dispatch.attemptToken, outcome, options);
      return { status: !updated ? "advanced" : updated.continuationDispatch.state === "blocked" ? "blocked"
        : outcome.status >= 200 && outcome.status < 300 ? "accepted" : "failed",
        dispatched: true, jobId: job.jobId, httpStatus: outcome.status, attempt: dispatch.attemptCount };
    }
    return { status: issues.length ? "blocked" : "idle", dispatched: false, ...(issues.length ? { issues } : {}) };
  } finally {
    await mutateRegistry(previous => previous.lease?.token === leaseToken
      ? { ...previous, scanAfterJobId: lastScanned, lease: null } : null, options);
  }
}

module.exports = { registerJob, removeJob, enqueueInitial, adoptCheckpoint, tick, validateCheckpoint,
  recoverWaiting, autoRecoverable, sourceFree, MAX_AUTO_RECOVERIES, RECOVERY_BACKOFF_MS,
  REGISTRY_KEY, MAX_ATTEMPTS, REQUEST_TIMEOUT_MS, DISPATCH_LEASE_MS, ACCEPTED_GRACE_MS, BACKOFF_MS,
  MAX_HINTS_PER_TICK, PRE_DISPATCH_BUDGET_MS };
