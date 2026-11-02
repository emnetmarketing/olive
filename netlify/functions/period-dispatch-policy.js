// Period uses the existing scheduled delivery service, not Instant artifacts.
// A ticket names one durable transition; an attempt can be accepted without
// its worker ever entering. The actual lease CAS records entry separately.
const { randomUUID } = require("node:crypto");
function ticket(job, number, now = Date.now()) {
  const at = new Date(now).toISOString();
  return { ticket: randomUUID(), state: "pending", number, readyAt: at, requestedAt: at, attemptCount: 0,
    expectedInputsHash: job.periodInputsHash || null, minimumCursor: Number(job.calculationCursor || 0) };
}
const managed = job => job?.mode === "period" && job.periodDispatchVersion === 1;
const live = (job, now) => Boolean(job.workerLease?.token && Number(job.workerLease.expiresAt) > now);
function validBoundary(job) {
  const d = job.continuationDispatch;
  if (!d || d.number !== Number(job.continuationCount || 0)
    || d.expectedInputsHash && d.expectedInputsHash !== job.periodInputsHash
    || Number(job.calculationCursor || 0) < d.minimumCursor) return false;
  if (job.currentStage === "publishing" && Array.isArray(job.results)) return true;
  if (d.number && !(job.periodInputsKey && job.periodInputsHash)) return false;
  if (Number(job.calculationCursor || 0) && !(job.calculationCheckpointKey && job.calculationCheckpointHash)) return false;
  // An interrupted legacy/historical source pass must never be replayed
  // automatically without a verified frozen input; its requests may have run.
  return !(d.enteredAt && job.historicalCollection && !job.periodInputsHash);
}
function assertCacheOnly(job) {
  if (job.cacheOnlyRecovery && (job.fastPath !== true || job.historicalCollection !== false || job.mode !== "period"))
    throw Object.assign(new Error("캐시 전용 기간 복구 입력이 일치하지 않습니다."), { code: "PERIOD_CACHE_ONLY_REQUIRED" });
}
module.exports = { ticket, managed, live, validBoundary, assertCacheOnly };
