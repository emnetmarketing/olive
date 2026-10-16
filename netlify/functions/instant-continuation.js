const crypto = require("node:crypto");
const { getCompatibleStore } = require("./blob-store-compat");
const { assertInstantWorker, writeOwnedInstantJob } = require("./instant-worker");

const VERSION = 1;
const SAFE_EXECUTION_MS = 4 * 60 * 1000;
const MAX_NUMERIC_CHUNK = 250;
const MAX_CONTINUATIONS = 128;
const STAGES = ["collection", "numeric", "ratio", "enrichment", "evidence", "finalize", "publishing"];
const CURSORS = ["collectionCursor", "calculationCursor", "ratioCursor", "enrichmentCursor", "evidenceCursor", "finalizeCursor"];
const STAGE_CURSOR = { collection: "collectionCursor", numeric: "calculationCursor", ratio: "ratioCursor",
  enrichment: "enrichmentCursor", evidence: "evidenceCursor", finalize: "finalizeCursor" };
const stageCursor = state => Number(state.cursor ?? state[STAGE_CURSOR[state.stage]] ?? 0);
const fail = (code, message) => Object.assign(new Error(message), { code });
const storeFor = options => options.store || getCompatibleStore({ name: "trend-analysis", consistency: "strong" });
const nowMs = options => options.now ? Number(options.now()) : Date.now();
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const copy = value => JSON.parse(JSON.stringify(value));
const prefix = jobId => `jobs/${encodeURIComponent(jobId)}/instant-v1/`;

function assertIdentity(value, job) {
  const fields = { jobId: job.jobId, selectedStartDate: job.startDate, selectedEndDate: job.endDate,
    queryStartDate: job.queryStartDate, requiredWindow: `${job.queryStartDate}:${job.endDate}` };
  for (const [key, expected] of Object.entries(fields)) if (value[key] != null && value[key] !== expected)
    throw fail("INSTANT_ARTIFACT_IDENTITY", "Instant state belongs to a different Job or requested window.");
  if (value.version != null && value.version !== VERSION)
    throw fail("INSTANT_ARTIFACT_VERSION", "Unsupported Instant continuation version.");
  return fields;
}

// Artifacts are immutable. Only the fenced Job CAS below makes one authoritative.
// An invocation lost between these two writes can leave an unused artifact, but
// cannot publish partial state or replace another worker's checkpoint.
async function writeArtifact(lease, label, value, options = {}) {
  const job = await assertInstantWorker(lease, options);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(label || ""))
    throw fail("INSTANT_ARTIFACT_LABEL", "A bounded Instant artifact label is required.");
  if (value === undefined) throw fail("INSTANT_ARTIFACT_VALUE", "An Instant artifact requires JSON data.");
  const artifact = copy({ version: VERSION, jobId: job.jobId, label, value });
  const hash = digest(artifact), key = `${prefix(job.jobId)}${label}/${hash}`;
  const store = storeFor(options);
  await store.setJSON(key, artifact, { onlyIfNew: true });
  const ref = { version: VERSION, jobId: job.jobId, label, key, hash };
  await readArtifact(ref, options);
  await assertInstantWorker(lease, options);
  return ref;
}

async function readArtifact(ref, options = {}) {
  if (!ref || ref.version !== VERSION || typeof ref.jobId !== "string" || !ref.jobId
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(ref.label || "") || !/^[a-f0-9]{64}$/.test(ref.hash || "")
    || ref.key !== `${prefix(ref.jobId)}${ref.label}/${ref.hash}`
    || options.jobId && options.jobId !== ref.jobId)
    throw fail("INSTANT_ARTIFACT_IDENTITY", "Invalid Instant artifact reference.");
  const artifact = await storeFor(options).get(ref.key, { type: "json" });
  if (!artifact || artifact.version !== VERSION || artifact.jobId !== ref.jobId || artifact.label !== ref.label
    || digest(artifact) !== ref.hash)
    throw fail("INSTANT_ARTIFACT_INTEGRITY", "Saved Instant data is missing or changed; do not rebuild it from current inputs.");
  return artifact.value;
}

function reference(job, kind) {
  const key = job?.[`instant${kind}Key`], hash = job?.[`instant${kind}Hash`];
  if (!key && !hash) return null;
  return { version: VERSION, jobId: job.jobId, label: kind.toLowerCase(), key, hash };
}
async function readInputs(job, options = {}) {
  const ref = reference(job, "Inputs");
  return ref ? readArtifact(ref, { ...options, jobId: job.jobId }) : null;
}
async function writeInputs(lease, value, options = {}) {
  const job = await assertInstantWorker(lease, options);
  if (job.instantInputsKey || job.instantInputsHash) {
    const previous = await readInputs(job, options);
    if (digest(copy(value)) !== digest(previous))
      throw fail("INSTANT_INPUTS_CHANGED", "Frozen Instant inputs cannot be replaced by refreshed candidates or settings.");
    return job;
  }
  const ref = await writeArtifact(lease, "inputs", value, options);
  return writeOwnedInstantJob(lease, { instantInputsKey: ref.key, instantInputsHash: ref.hash }, options);
}

async function readState(job, options = {}) {
  const ref = reference(job, "State");
  // Legacy UI progress is not a durable calculation cursor.
  if (!ref) return null;
  const state = await readArtifact(ref, { ...options, jobId: job.jobId });
  assertIdentity(state, job);
  validateState(state);
  if (state.stage !== job.instantStage)
    throw fail("INSTANT_STATE_INTEGRITY", "Instant Job and checkpoint stage do not agree.");
  if (job.instantStageCursor != null && job.instantStageCursor !== stageCursor(state))
    throw fail("INSTANT_STATE_INTEGRITY", "Instant Job and current-stage checkpoint cursor do not agree.");
  for (const key of CURSORS) if (Number(state[key] || 0) !== Number(job[key] || 0))
    throw fail("INSTANT_STATE_INTEGRITY", "Instant Job and durable cursor do not agree.");
  return state;
}

function validateState(state) {
  if (!state || !STAGES.includes(state.stage)) throw fail("INSTANT_STATE_STAGE", "A valid Instant continuation stage is required.");
  if (state.cursor != null && (!Number.isSafeInteger(state.cursor) || state.cursor < 0))
    throw fail("INSTANT_STATE_CURSOR", "The current-stage cursor must be a non-negative safe integer.");
  for (const key of CURSORS) if (state[key] != null && (!Number.isSafeInteger(state[key]) || state[key] < 0))
    throw fail("INSTANT_STATE_CURSOR", "Instant cursors must be non-negative safe integers.");
  const totals = { collectionCursor: "collectionTotalCount", calculationCursor: "calculationTotalCount", ratioCursor: "ratioTotalCount",
    enrichmentCursor: "enrichmentTotalCount", evidenceCursor: "evidenceTotalCount", finalizeCursor: "finalizeTotalCount" };
  for (const [key, totalKey] of Object.entries(totals)) if (state[totalKey] != null
    && (!Number.isSafeInteger(state[totalKey]) || state[totalKey] < 0 || Number(state[key] || 0) > state[totalKey]))
    throw fail("INSTANT_STATE_CURSOR", "Instant cursor must not exceed its frozen stage total.");
  if (state.totalCount != null && (!Number.isSafeInteger(state.totalCount) || state.totalCount < 0
    || Number(state.cursor || 0) > state.totalCount
    || state.stage === "numeric" && Number(state.calculationCursor || 0) > state.totalCount))
    throw fail("INSTANT_STATE_CURSOR", "Instant current-stage cursor must not exceed its total.");
}

async function writeState(lease, value, options = {}) {
  const job = await assertInstantWorker(lease, options);
  const previous = await readState(job, options);
  const identity = assertIdentity(value, job);
  const state = { ...copy(value), ...identity, version: VERSION };
  for (const key of CURSORS) state[key] = state[key] ?? previous?.[key] ?? 0;
  validateState(state);
  for (const key of CURSORS) {
    if (state[key] < Number(previous?.[key] || 0))
      throw fail("INSTANT_CURSOR_REGRESSION", "Instant continuation cannot move behind a durable cursor.");
  }
  if (previous && STAGES.indexOf(state.stage) < STAGES.indexOf(previous.stage))
    throw fail("INSTANT_STAGE_REGRESSION", "Instant continuation cannot repeat an earlier completed stage.");
  if (previous?.stage === state.stage && Number(state.cursor || 0) < Number(previous.cursor || 0))
    throw fail("INSTANT_CURSOR_REGRESSION", "Instant current-stage progress cannot move behind its saved cursor.");
  state.updatedAt = value.updatedAt || new Date(nowMs(options)).toISOString();
  const ref = await writeArtifact(lease, "state", state, options);
  const cursors = Object.fromEntries(CURSORS.map(key => [key, state[key]]));
  return writeOwnedInstantJob(lease, { ...cursors, instantStage: state.stage, instantStageCursor: stageCursor(state),
    instantStateKey: ref.key, instantStateHash: ref.hash, instantStateRevision: Number(job.instantStateRevision || 0) + 1,
    checkpointUpdatedAt: state.updatedAt }, { ...options, expectedInstantStateRevision: Number(job.instantStateRevision || 0) });
}

function shouldContinue({ startedAt, cursor, invocationStartCursor = 0, totalCount, now = Date.now(), maxChunk = MAX_NUMERIC_CHUNK }) {
  if (cursor >= totalCount) return false;
  return now - startedAt >= SAFE_EXECUTION_MS || cursor - invocationStartCursor >= maxChunk;
}
function assertContinuationAvailable(job) {
  if (Number(job?.continuationCount || 0) >= MAX_CONTINUATIONS)
    throw fail("INSTANT_CONTINUATION_LIMIT", "Instant continuation safety limit reached; saved state remains resumable.");
}

module.exports = { VERSION, SAFE_EXECUTION_MS, MAX_NUMERIC_CHUNK, MAX_CONTINUATIONS, STAGES, CURSORS,
  writeArtifact, readArtifact, writeInputs, readInputs, writeState, readState, shouldContinue, assertContinuationAvailable };
