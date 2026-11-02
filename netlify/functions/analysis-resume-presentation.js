// Read-only evidence for display. This never adopts, queues, releases or updates
// a Job. The worker's resumable flag is not proof that saved calculation exists.
const { getCompatibleStore } = require("./blob-store-compat");
const crypto = require("node:crypto");
const artifacts = require("./instant-continuation");
const historical = require("./historical-continuation");
const { CALCULATION_VERSION } = require("./surge-history-cache");
const { readPeriodCheckpoint, readPeriodInputs, STALE_JOB_MS } = require("./trend-analysis-cache");

const stopped = new Set(["failed", "interrupted", "continuation_failed", "publication_failed"]);
const evidence = (status, reason, details = {}) => ({ verified: status === "verified", status, reason, ...details });
const incompatible = () => { throw new Error("CHECKPOINT_DISPLAY_INCOMPATIBLE"); };
function needsEvidence(job, now = Date.now()) {
  return Boolean(job && job.state !== "completed" && (job.stale || stopped.has(job.state)
    || ["running", "publishing", "recovering"].includes(job.state)
      && now - Date.parse(job.updatedAt || job.createdAt || "") > STALE_JOB_MS));
}
function readOptions(options) {
  // Content-addressed artifacts are immutable and verified by their digest.
  // A stale/missing read fails closed for display, without requiring a new
  // strong transport or weakening the worker's separate mutation policy.
  return { store: options.store || getCompatibleStore("trend-analysis") };
}
async function periodEvidence(job, options) {
  if (!job.calculationCheckpointKey || !job.periodInputsKey)
    return evidence("missing", "no-calculation-checkpoint");
  if (job.recovery) return evidence("unverified", "recovery-checkpoint-not-verified");
  const opts = readOptions(options);
  const checkpoint = await readPeriodCheckpoint(job, opts);
  const input = await readPeriodInputs(job, opts);
  const selected = input?.selection?.selected;
  if (!checkpoint || checkpoint.jobId !== job.jobId || input?.calculationVersion !== CALCULATION_VERSION
    || !Array.isArray(selected) || !historical.isCompatible(checkpoint, job, selected)
    || checkpoint.processedCount !== checkpoint.calculationCursor
    || checkpoint.calculationCursor !== job.calculationCursor
    || !["rows", "calculated", "matchedDiagnostics", "boundaryRelated", "analysisTrace"].every(key => Array.isArray(checkpoint[key]))) incompatible();
  if (!checkpoint.calculationCursor && !checkpoint.ratioCursor && !checkpoint.evidenceCursor)
    return evidence("missing", "no-saved-calculation-progress");
  return evidence("verified", "saved-calculation-verified", { kind: "calculation", stage: "numeric",
    cursor: checkpoint.calculationCursor, totalCount: checkpoint.totalCount,
    checkpointUpdatedAt: checkpoint.updatedAt || job.checkpointUpdatedAt || null });
}
async function instantEvidence(job, options) {
  if (!job.instantStateKey || !job.instantInputsKey) return evidence("missing", "no-durable-checkpoint");
  const opts = readOptions(options);
  const input = await artifacts.readInputs(job, opts), state = await artifacts.readState(job, opts);
  if (!input || !state || input.jobId !== job.jobId || input.startDate !== job.startDate || input.endDate !== job.endDate
    || input.queryStartDate !== job.queryStartDate || input.requiredWindow !== `${job.queryStartDate}:${job.endDate}`
    || input.targetDataDate !== job.targetDataDate || input.surgeThreshold !== job.surgeThreshold
    || input.matchThreshold !== job.matchThreshold || input.orderedCandidateHash !== job.orderedCandidateHash
    || input.productHash !== job.productVersionHash || input.calculationVersion !== CALCULATION_VERSION
    || input.calculationVersion !== job.calculationVersion || !Array.isArray(state.parts)
    || !state.parts.length || !Array.isArray(state.outputs)) incompatible();
  // Verify actual saved shard bodies, not only cursor numbers or cache presence.
  const candidateOrder = [];
  for (const ref of state.parts) {
    const part = await artifacts.readArtifact(ref, { ...opts, jobId: job.jobId });
    if (!Array.isArray(part) || part.some(entry => typeof entry?.candidate?.keyword !== "string")) incompatible();
    candidateOrder.push(...part.map(entry => entry.candidate.keyword));
  }
  if (candidateOrder.length !== input.totalCount || crypto.createHash("sha256").update(JSON.stringify(candidateOrder)).digest("hex") !== input.orderedCandidateHash) incompatible();
  const ends = { numeric: 0, ratio: 0 };
  for (const ref of state.outputs) {
    const output = await artifacts.readArtifact(ref, { ...opts, jobId: job.jobId });
    if (!Object.hasOwn(ends, output?.phase) || output.startCursor !== ends[output.phase]
      || !Number.isSafeInteger(output.endCursor) || output.endCursor <= output.startCursor
      || !Array.isArray(output.rows) || !Array.isArray(output.calculated) || !Array.isArray(output.traces)) incompatible();
    ends[output.phase] = output.endCursor;
  }
  if (ends.numeric !== Number(state.calculationCursor || 0) || ends.ratio !== Number(state.ratioCursor || 0)) incompatible();
  if (["evidence", "finalize", "publishing"].includes(state.stage) && !state.result) incompatible();
  if (["enrichment", "evidence", "finalize", "publishing"].includes(state.stage) && state.result)
    await artifacts.readArtifact(state.result, { ...opts, jobId: job.jobId });
  // Frozen candidate/cache inputs and an initial cursor are not intermediate
  // calculation results. Do not advertise them as a saved processing point.
  if (!ends.numeric && !ends.ratio && !Number(state.responsesSaved || 0) && !state.result)
    return evidence("missing", "no-saved-stage-progress");
  const cursor = Number(state.cursor ?? 0);
  const counts = { collection: input.queue?.length, numeric: input.numericCount, ratio: input.ratioCount };
  return evidence("verified", "saved-stage-verified", { kind: !ends.numeric && !ends.ratio ? "collection" : "calculation",
    stage: state.stage, cursor, totalCount: Number.isSafeInteger(counts[state.stage]) ? counts[state.stage] : null,
    checkpointUpdatedAt: state.updatedAt || job.checkpointUpdatedAt || null });
}
async function withResumeEvidence(job, options = {}) {
  if (!needsEvidence(job, options.now ?? Date.now())) return job;
  let proof;
  try {
    proof = job.mode === "instant" ? await instantEvidence(job, options)
      : job.mode === "period" ? await periodEvidence(job, options) : evidence("unverified", "unknown-mode");
  } catch {
    // Missing/mismatched/read-failed artifacts must not make an existing result
    // endpoint fail or advertise a recovery that has not been verified.
    proof = evidence("unverified", "checkpoint-verification-unavailable");
  }
  return { ...job, resumeEvidence: proof };
}
module.exports = { needsEvidence, withResumeEvidence };
