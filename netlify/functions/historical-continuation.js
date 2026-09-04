const CHECKPOINT_VERSION = 1;
const SAFE_EXECUTION_MS = 7 * 60 * 1000;
const MAX_CALCULATION_CHUNK = 1000;
const MAX_CONTINUATIONS = 20;

function checkpointKey(job) {
  const window = `${job.queryStartDate || "unknown"}_${job.endDate || "unknown"}`;
  const thresholds = `${Number(job.surgeThreshold || 0)}_${Number(job.matchThreshold || 0)}`;
  return `continuations/historical/${window}/${thresholds}-v${CHECKPOINT_VERSION}`;
}

function isCompatible(checkpoint, job, eligible) {
  const eligibleKeywords = (eligible || []).map((item) => String(item.keyword || item));
  return Boolean(checkpoint && checkpoint.version === CHECKPOINT_VERSION
    && checkpoint.selectedStartDate === job.startDate && checkpoint.selectedEndDate === job.endDate
    && checkpoint.queryStartDate === job.queryStartDate && checkpoint.requiredWindow === `${job.queryStartDate}:${job.endDate}`
    && Number(checkpoint.totalCount) === eligibleKeywords.length
    && JSON.stringify(checkpoint.eligibleKeywords || []) === JSON.stringify(eligibleKeywords));
}

function shouldContinue({ startedAt, cursor, invocationStartCursor, totalCount, now = Date.now() }) {
  if (cursor >= totalCount) return false;
  return now - startedAt >= SAFE_EXECUTION_MS || cursor - invocationStartCursor >= MAX_CALCULATION_CHUNK;
}

function resumablePatch(job, error) {
  return { state: "continuation_failed", resumable: true, currentStage: "continuation_failed",
    message: "기간 분석 continuation 시작 실패 · 저장된 checkpoint에서 재개 가능",
    continuationError: String(error?.message || error || "continuation invocation failed"),
    lastCursor: Number(job.calculationCursor || job.processedCount || 0), failedAt: new Date().toISOString() };
}

module.exports = { CHECKPOINT_VERSION, SAFE_EXECUTION_MS, MAX_CALCULATION_CHUNK, MAX_CONTINUATIONS,
  checkpointKey, isCompatible, shouldContinue, resumablePatch };
