// Scheduling decisions only. No provider calls, calculation or quota mutation.
const { getCompatibleStore } = require("./blob-store-compat");
const HASH_FIELDS = ["candidatesHash", "productHash", "sourceHash", "evidenceHash"];
const IDENTITY_FIELDS = ["targetDataDate", "startDate", "endDate", "queryStartDate", "surgeThreshold", "matchThreshold", "calculationVersion"];
const WAITING_PREFLIGHT = new Set(["waiting", "sample-target-unconfirmed", "sample-error", "budget-limited", "no-representative-sample"]);
function validFingerprint(value) {
  return Boolean(value?.version === 1 && HASH_FIELDS.every(field => /^[a-f0-9]{64}$/.test(value[field] || ""))
    && IDENTITY_FIELDS.every(field => value[field] !== null && value[field] !== undefined && value[field] !== ""));
}
function compareRecoveryInputs(previous, current) {
  if (!validFingerprint(previous) || !validFingerprint(current)) return { unchanged: false, reason: "missing-fingerprint", changed: [] };
  const changed = [...IDENTITY_FIELDS, ...HASH_FIELDS].filter(field => previous[field] !== current[field]);
  return { unchanged: changed.length === 0, reason: changed.length ? "input-changed" : "verified-unchanged", changed };
}
function currentRecoveryDisposition(job, targetDataDate) {
  if (!job || job.mode !== "instant" || job.targetDataDate !== targetDataDate) return null;
  const preflight = job.targetDatePreflight;
  if (!preflight || preflight.targetDataDate !== targetDataDate) return null;
  if (job.state === "deferred") return { action: "deferred", jobId: job.jobId, reason: job.deferredReason || preflight.status || "target-date-unavailable",
    nextCheckAt: preflight.nextCheckAt || null, resultJobId: job.resultJobId || job.recoveryOfJobId || null };
  if (job.state === "running" && WAITING_PREFLIGHT.has(preflight.status)) return { action: "waiting", jobId: job.jobId,
    reason: preflight.status, nextCheckAt: preflight.nextCheckAt || job.continuationDispatch?.readyAt || null };
  return null;
}
function completedRecoveryReference(job, targetDataDate) {
  return job?.mode === "instant" && job.state === "completed" && job.targetDataDate === targetDataDate
    && Array.isArray(job.results) ? job.jobId : null;
}
function resumedStage(job) {
  return Array.isArray(job?.results) && ["publishing", "publication_failed"].includes(job.state)
    ? "existing-publication-queued" : "existing-checkpoint-queued";
}
async function readRecoveryContext(options = {}) {
  const analysis = options.store || getCompatibleStore({ name: "trend-analysis", consistency: "strong" });
  const snapshots = options.snapshotStore || getCompatibleStore({ name: "trend-signal-snapshots", consistency: "strong" });
  const [currentPointer, analysisPointer] = await Promise.all([analysis.get("current-job/v1", { type: "json" }),
    snapshots.get("latest-analysis-v1/instant", { type: "json" })]);
  const jobs = new Map();
  const read = async id => { if (!id) return null; if (!jobs.has(id)) jobs.set(id, await analysis.get(`jobs/${id}`, { type: "json" })); return jobs.get(id); };
  const current = await read(currentPointer?.jobId);
  let pointer = analysisPointer, completed = null;
  for (let depth = 0; pointer?.jobId && depth < 4; depth++) {
    const job = await read(pointer.jobId);
    if (job?.mode === "instant" && job.state === "completed" && Array.isArray(job.results)) { completed = job; break; }
    pointer = pointer.previous;
  }
  return { current, completed };
}
module.exports = { compareRecoveryInputs, currentRecoveryDisposition, completedRecoveryReference, resumedStage, readRecoveryContext };
