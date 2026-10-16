const crypto = require("node:crypto");
const { getStore } = require("@netlify/blobs");

const STORE_NAME = "trend-period-recovery";
const VERSION = 1;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const STAGES = ["numeric", "ratio", "evidence", "finalize", "publishing", "completed"];
const CURSORS = ["calculationCursor", "ratioCursor", "evidenceCursor"];
const PROGRESS_FIELDS = ["totalCount", "ratioTotalCount", "evidenceTotalCount", "candidateCount", "processedCount"];

function recoveryError(code, message) { const error = new Error(message); error.code = code; return error; }
function hashValue(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function context(deps = {}) {
  return { store: deps.store || getStore({ name: STORE_NAME, consistency: "strong" }),
    now: deps.now || Date.now, leaseMs: deps.leaseMs || DEFAULT_LEASE_MS,
    uuid: deps.uuid || crypto.randomUUID, frozen: deps.frozen };
}
function validateIdentifier(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw recoveryError("INVALID_ID", `Invalid recovery ${label}.`);
  return value;
}
function controlKey(jobId) { return `jobs/${validateIdentifier(jobId, "job ID")}/control-v1`; }
function inputKey(jobId, inputHash) { return `jobs/${jobId}/inputs/${inputHash}`; }
function iso(now) { return new Date(now).toISOString(); }
function progressFields(state) {
  return Object.fromEntries(PROGRESS_FIELDS.filter((key) => state[key] !== undefined).map((key) => [key, state[key]]));
}
function validateState(state, previous = null) {
  const stageIndex = STAGES.indexOf(state?.stage);
  if (stageIndex < 0) throw recoveryError("INVALID_STAGE", "Invalid recovery stage.");
  if (previous && stageIndex < STAGES.indexOf(previous.stage))
    throw recoveryError("STAGE_ROLLBACK", "A recovery stage cannot move backwards.");
  for (const key of CURSORS) {
    if (!Number.isSafeInteger(state[key]) || state[key] < 0)
      throw recoveryError("INVALID_CURSOR", `Invalid recovery ${key}.`);
    if (previous && state[key] < previous[key])
      throw recoveryError("CURSOR_ROLLBACK", `Recovery ${key} cannot move backwards.`);
  }
  for (const [cursor, total] of [["calculationCursor", "totalCount"], ["ratioCursor", "ratioTotalCount"], ["evidenceCursor", "evidenceTotalCount"]]) {
    if (state[total] !== undefined && (!Number.isSafeInteger(state[total]) || state[total] < state[cursor]))
      throw recoveryError("INVALID_TOTAL", `Invalid recovery ${total}.`);
    if (previous?.[total] !== undefined && state[total] !== previous[total])
      throw recoveryError("TOTAL_CHANGED", `Recovery ${total} cannot change after it is fixed.`);
  }
  for (const [phase, cursor, total] of [["numeric", "calculationCursor", "totalCount"],
    ["ratio", "ratioCursor", "ratioTotalCount"], ["evidence", "evidenceCursor", "evidenceTotalCount"]]) {
    if (stageIndex > STAGES.indexOf(phase) && state[total] !== undefined && state[cursor] !== state[total])
      throw recoveryError("INCOMPLETE_STAGE", `Recovery ${phase} processing is not complete.`);
  }
  if (state.stage === "completed" && state.publicationVerified !== true)
    throw recoveryError("PUBLICATION_UNVERIFIED", "Recovery publication must be verified before completion.");
}
async function readControl(jobId, ctx) {
  const entry = await ctx.store.getWithMetadata(controlKey(jobId), { type: "json" });
  if (!entry?.data) throw recoveryError("RECOVERY_NOT_FOUND", "Recovery has not been initialized.");
  return { control: entry.data, etag: entry.etag };
}
async function readArtifacts(control, ctx) {
  const localFrozen = ctx.frozen !== undefined;
  if (localFrozen && hashValue(ctx.frozen) !== control.inputHash)
    throw recoveryError("INPUT_INTEGRITY", "Local frozen recovery inputs failed integrity verification.");
  const [input, artifact] = await Promise.all([
    localFrozen ? Promise.resolve({ jobId: control.jobId, generation: control.generation,
      inputHash: control.inputHash, frozen: ctx.frozen }) : ctx.store.get(control.inputKey, { type: "json" }),
    ctx.store.get(control.stateKey, { type: "json" })
  ]);
  if (!input || input.jobId !== control.jobId || input.generation !== control.generation
    || input.inputHash !== control.inputHash || hashValue(input.frozen) !== control.inputHash)
    throw recoveryError("INPUT_INTEGRITY", "Frozen recovery inputs failed integrity verification.");
  if (!artifact || artifact.jobId !== control.jobId || artifact.generation !== control.generation
    || artifact.stateHash !== control.stateHash || hashValue(artifact.state) !== control.stateHash)
    throw recoveryError("STATE_INTEGRITY", "Recovery checkpoint failed integrity verification.");
  validateState(artifact.state);
  return { state: artifact.state, frozen: input.frozen };
}
async function read(jobId, deps = {}) {
  const ctx = context(deps); const entry = await readControl(jobId, ctx);
  return { ...entry, ...await readArtifacts(entry.control, ctx) };
}
async function writeImmutable(ctx, key, value, integrityCode) {
  const written = await ctx.store.setJSON(key, value, { onlyIfNew: true });
  const saved = await ctx.store.get(key, { type: "json" });
  if (written?.modified === false && hashValue(saved) !== hashValue(value))
    throw recoveryError(integrityCode, "An immutable recovery artifact already exists with different content.");
  if (hashValue(saved) !== hashValue(value)) throw recoveryError(integrityCode, "Recovery artifact read-back verification failed.");
}
function compactEvent(control, event, now) {
  const trace = { version: VERSION, jobId: control.jobId, generation: control.generation,
    fence: control.fence, invocationId: control.lease?.invocationId || null, timestamp: iso(now),
    event: String(event.event || "checkpoint").slice(0, 80), stage: control.stage,
    calculationCursor: control.calculationCursor, ratioCursor: control.ratioCursor,
    evidenceCursor: control.evidenceCursor };
  // Deliberately do not copy arbitrary context, error messages, credentials, or candidate data.
  for (const key of ["requestId", "continuationNumber", "stageStart", "stageEnd", "cursorStart", "cursorEnd", "httpStatus", "outcome", "errorCode"])
    if (["string", "number", "boolean"].includes(typeof event[key])) trace[key] = typeof event[key] === "string" ? event[key].slice(0, 160) : event[key];
  return trace;
}
async function trace(ctx, control, event) {
  const value = compactEvent(control, event, ctx.now());
  const key = `jobs/${control.jobId}/traces/${control.generation}/${control.fence}/${ctx.uuid()}`;
  await writeImmutable(ctx, key, value, "TRACE_INTEGRITY");
  return value;
}
async function appendTrace(jobId, lease, event, deps = {}) {
  const ctx = context(deps); const { control } = await readControl(jobId, ctx);
  verifyLease(control, lease, ctx.now());
  return trace(ctx, control, event);
}
async function initialize(jobId, frozen, initialState, deps = {}) {
  const ctx = context(deps); controlKey(jobId);
  const generation = validateIdentifier(initialState?.generation, "generation");
  const inputHash = hashValue(frozen);
  if (initialState.inputHash && initialState.inputHash !== inputHash)
    throw recoveryError("INPUT_HASH_MISMATCH", "Supplied recovery input hash does not match the frozen inputs.");
  const current = await ctx.store.getWithMetadata(controlKey(jobId), { type: "json" });
  if (current?.data) {
    if (current.data.generation !== generation || current.data.inputHash !== inputHash)
      throw recoveryError("INITIALIZATION_CONFLICT", "Recovery already exists with different inputs or generation.");
    return read(jobId, deps);
  }
  const state = { calculationCursor: 0, ratioCursor: 0, evidenceCursor: 0, ...initialState,
    stage: initialState.stage || "numeric" };
  delete state.generation; delete state.inputHash;
  validateState(state);
  const frozenKey = inputKey(jobId, inputHash);
  await writeImmutable(ctx, frozenKey, { version: VERSION, jobId, generation, inputHash, frozen }, "INPUT_INTEGRITY");
  const stateHash = hashValue(state);
  const stateKey = `jobs/${jobId}/states/${generation}/0/${ctx.uuid()}`;
  await writeImmutable(ctx, stateKey, { version: VERSION, jobId, generation, fence: 0, stateHash, state }, "STATE_INTEGRITY");
  const now = iso(ctx.now());
  const control = { version: VERSION, jobId, generation, inputHash, inputKey: frozenKey, stateKey, stateHash,
    stage: state.stage, ...Object.fromEntries(CURSORS.map((key) => [key, state[key]])), ...progressFields(state),
    fence: 0, lease: null, status: "ready", resumable: true, createdAt: now, updatedAt: now,
    lastEvent: "initialized" };
  const result = await ctx.store.setJSON(controlKey(jobId), control, { onlyIfNew: true });
  if (result?.modified === false) {
    const winner = await read(jobId, deps);
    if (winner.control.generation !== generation || winner.control.inputHash !== inputHash)
      throw recoveryError("INITIALIZATION_CONFLICT", "Another recovery generation acquired the Job.");
    return winner;
  }
  await trace(ctx, control, { event: "initialized" }).catch(() => null);
  return read(jobId, deps);
}
function leaseFrom(control) {
  return control.lease ? { jobId: control.jobId, generation: control.generation, fence: control.fence, ...control.lease } : null;
}
function verifyLease(control, lease, now) {
  if (!lease || control.jobId !== lease.jobId || control.generation !== lease.generation
    || control.fence !== lease.fence || !control.lease || control.lease.token !== lease.token
    || control.lease.invocationId !== lease.invocationId)
    throw recoveryError("LEASE_FENCED", "This recovery worker no longer owns the execution lease.");
  if (Date.parse(control.lease.expiresAt) <= now)
    throw recoveryError("LEASE_EXPIRED", "The recovery execution lease expired.");
}
async function assertLease(jobId, generation, leaseToken, deps = {}) {
  const ctx = context(deps); const { control } = await readControl(jobId, ctx);
  const lease = typeof leaseToken === "string" ? { ...leaseFrom(control), token: leaseToken, generation } : leaseToken;
  if (generation !== control.generation) throw recoveryError("LEASE_FENCED", "Recovery generation no longer matches.");
  verifyLease(control, lease, ctx.now());
  return control;
}
async function claim(jobId, { invocationId, generation }, deps = {}) {
  const ctx = context(deps); validateIdentifier(invocationId, "invocation ID");
  const previous = await read(jobId, deps); const { control, etag } = previous;
  if (control.generation !== generation) throw recoveryError("LEASE_FENCED", "Recovery generation no longer matches.");
  if (control.status === "completed" || control.stage === "completed") throw recoveryError("RECOVERY_COMPLETED", "Recovery is already completed.");
  const now = ctx.now();
  if (control.lease && Date.parse(control.lease.expiresAt) > now)
    throw recoveryError("LEASE_BUSY", "Another recovery invocation currently owns the execution lease.");
  const next = { ...control, fence: control.fence + 1, status: "running", resumable: true, updatedAt: iso(now),
    lastEvent: "invocation-entered", lease: { token: crypto.randomUUID(), invocationId,
      startedAt: iso(now), expiresAt: iso(now + ctx.leaseMs) } };
  const result = await ctx.store.setJSON(controlKey(jobId), next, { onlyIfMatch: etag });
  if (result?.modified === false) throw recoveryError("LEASE_BUSY", "Another recovery invocation acquired the execution lease.");
  await trace(ctx, next, { event: "invocation-entered", stageStart: next.stage, cursorStart: next.calculationCursor }).catch(() => null);
  return { ...previous, control: next, lease: leaseFrom(next) };
}
async function checkpoint(jobId, lease, newStateArtifact, deps = {}) {
  const ctx = context(deps); const previous = await read(jobId, deps);
  verifyLease(previous.control, lease, ctx.now());
  const state = { ...previous.state, ...newStateArtifact };
  validateState(state, previous.state);
  const stateHash = hashValue(state);
  const key = `jobs/${jobId}/states/${lease.generation}/${lease.fence}/${ctx.uuid()}`;
  await writeImmutable(ctx, key, { version: VERSION, jobId, generation: lease.generation, fence: lease.fence, stateHash, state }, "STATE_INTEGRITY");
  // Both time and ETag are checked after the potentially large artifact write.
  verifyLease(previous.control, lease, ctx.now());
  const now = ctx.now(); const completed = state.stage === "completed";
  const next = { ...previous.control, stateKey: key, stateHash, stage: state.stage,
    ...Object.fromEntries(CURSORS.map((cursor) => [cursor, state[cursor]])), ...progressFields(state),
    status: completed ? "completed" : "running", resumable: !completed, updatedAt: iso(now),
    lastEvent: completed ? "publication-completed" : "checkpoint-saved",
    lease: completed ? null : { ...previous.control.lease, expiresAt: iso(now + ctx.leaseMs) } };
  if (completed) next.completedAt = iso(now);
  const result = await ctx.store.setJSON(controlKey(jobId), next, { onlyIfMatch: previous.etag });
  if (result?.modified === false) throw recoveryError("LEASE_FENCED", "Checkpoint was not committed because execution ownership changed.");
  await trace(ctx, { ...next, lease: previous.control.lease }, { event: next.lastEvent,
    stageStart: previous.control.stage, stageEnd: next.stage,
    cursorStart: previous.control.calculationCursor, cursorEnd: next.calculationCursor }).catch(() => null);
  return { control: next, state, frozen: previous.frozen, lease: leaseFrom(next) };
}
async function release(jobId, lease, options = {}, deps = {}) {
  const ctx = context(deps); const previous = await readControl(jobId, ctx);
  verifyLease(previous.control, lease, ctx.now());
  const status = options.status === "resumable" ? "resumable" : "ready";
  const next = { ...previous.control, lease: null, status, resumable: true,
    updatedAt: iso(ctx.now()), lastEvent: status === "resumable" ? "invocation-failed" : "invocation-exited" };
  if (options.errorCode) next.lastError = { code: String(options.errorCode).slice(0, 120), at: next.updatedAt };
  const result = await ctx.store.setJSON(controlKey(jobId), next, { onlyIfMatch: previous.etag });
  if (result?.modified === false) throw recoveryError("LEASE_FENCED", "Execution ownership changed before release.");
  await trace(ctx, { ...next, lease: previous.control.lease }, { event: next.lastEvent,
    stageEnd: next.stage, cursorEnd: next.calculationCursor, errorCode: next.lastError?.code }).catch(() => null);
  return next;
}
async function markFailure(jobId, lease, error, deps = {}) {
  return release(jobId, lease, { status: "resumable", errorCode: error?.code || "RECOVERY_EXECUTION_FAILED" }, deps);
}

module.exports = { STORE_NAME, VERSION, DEFAULT_LEASE_MS, STAGES, hashValue, controlKey,
  initialize, read, claim, checkpoint, release, markFailure, assertLease, appendTrace };
