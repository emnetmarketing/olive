const { getCompatibleStore } = require("./blob-store-compat");
const { digest } = require("./period-publication");

const failure = (code, message) => Object.assign(new Error(message), { code });
const withoutPrevious = pointer => { const { previous, ...value } = pointer; return value; };
async function visiblePointer(pointer, readJob) {
  let current = pointer;
  for (let depth = 0; current?.jobId && depth < 8; depth += 1) {
    if (!current.requiresCompleted) return current;
    const job = await readJob(current.jobId);
    if (job?.mode === "instant" && job.state === "completed") return current;
    current = current.previous;
  }
  return null;
}
async function stagePointer(store, key, pointer, readJob) {
  if (!pointer?.jobId || !Number.isFinite(pointer.generation) || pointer.generation <= 0)
    throw failure("INVALID_INSTANT_POINTER", "An instant pointer requires its original Job generation.");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const entry = await store.getWithMetadata(key, { type: "json" });
    const previous = entry?.data;
    let previousGeneration = Number(previous?.generation || 0);
    if (previous?.jobId && !previousGeneration) {
      const previousJob = await readJob(previous.jobId);
      previousGeneration = Date.parse(previousJob?.createdAt || previous.generatedAt || previous.completedAt || "") || 0;
    }
    if (previousGeneration > pointer.generation) return { skippedNewer: true };
    if (previous?.jobId === pointer.jobId && previous.requiresCompleted) return { staged: true };
    const visible = await visiblePointer(previous, readJob);
    const next = { ...pointer, requiresCompleted: true, ...(visible ? { previous: withoutPrevious(visible) } : {}) };
    const written = await store.setJSON(key, next, entry?.etag ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
    if (!written?.modified) continue;
    const verified = await store.get(key, { type: "json" });
    if (verified?.jobId === pointer.jobId && digest(verified) === digest(next)) return { staged: true };
    if (Number(verified?.generation || 0) > pointer.generation) return { skippedNewer: true };
    throw failure("INSTANT_POINTER_VERIFY_FAILED", "Instant publication pointer could not be verified.");
  }
  throw failure("INSTANT_POINTER_CONFLICT", "Instant publication pointer changed concurrently.");
}
function sameCalculation(left, right) {
  return left?.jobId === right.jobId && left?.mode === "instant"
    && left.startDate === right.startDate && left.endDate === right.endDate && left.createdAt === right.createdAt
    && left.queryStartDate === right.queryStartDate && left.surgeThreshold === right.surgeThreshold && left.matchThreshold === right.matchThreshold
    && left.latestDataDate === right.latestDataDate && left.trendCoveragePct === right.trendCoveragePct
    && Array.isArray(left.results) && digest(left.results) === digest(right.results);
}
async function patchInstantPublication(jobId, patch, options = {}) {
  const store = options.store || getCompatibleStore({ name: "trend-analysis", consistency: "strong" });
  const key = `jobs/${jobId}`;
  const permitted = new Set(["state", "publicationState", "resumable", "errors", "failedAt", "message", "publicationAttempt",
    "continuationCount", "continuationRequestedAt", "updatedAt"]);
  if (Object.keys(patch).some(key => !permitted.has(key)) || patch.state && !["publishing", "publication_failed"].includes(patch.state))
    throw failure("INVALID_INSTANT_PUBLICATION_PATCH", "Publication retry may update control fields only.");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const entry = await store.getWithMetadata(key, { type: "json" }); const current = entry?.data;
    if (!current || current.mode !== "instant") throw failure("INVALID_INSTANT_PUBLICATION", "Saved instant calculation is unavailable.");
    if (current.state === "completed") return { job: current, modified: false };
    if (!["publishing", "publication_failed"].includes(current.state) || !Array.isArray(current.results))
      throw failure("INSTANT_WRITE_PROTECTED", "Only a saved publication may be retried.");
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    for (const counter of ["publicationAttempt", "continuationCount"])
      if (patch[counter] != null) next[counter] = Math.max(Number(current[counter] || 0), Number(patch[counter] || 0));
    if ((await store.setJSON(key, next, { onlyIfMatch: entry.etag }))?.modified) return { job: next, modified: true };
  }
  throw failure("INSTANT_PUBLICATION_CONFLICT", "Instant publication changed concurrently.");
}
async function writeInstantJobGuarded(jobId, value, options = {}) {
  const store = options.store || getCompatibleStore({ name: "trend-analysis", consistency: "strong" });
  const key = `jobs/${jobId}`;
  if (value?.mode !== "instant" || value.jobId !== jobId) throw failure("INVALID_INSTANT_JOB", "Instant Job identity must match.");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const entry = await store.getWithMetadata(key, { type: "json" }); const current = entry?.data;
    if (current && (current.mode !== "instant" || current.createdAt !== value.createdAt))
      throw failure("INSTANT_WRITE_PROTECTED", "Instant Job generation changed.");
    if (current && ["publishing", "publication_failed", "completed"].includes(current.state)) {
      if (digest(current) === digest(value)) return current;
      throw failure("INSTANT_WRITE_PROTECTED", "Saved instant calculation/publication cannot be overwritten by an earlier worker.");
    }
    if ((await store.setJSON(key, value, entry?.etag ? { onlyIfMatch: entry.etag } : { onlyIfNew: true }))?.modified) return value;
  }
  throw failure("INSTANT_PUBLICATION_CONFLICT", "Instant Job changed concurrently.");
}
async function publishInstant(job, options = {}) {
  if (job?.mode !== "instant" || !job.jobId || !Array.isArray(job.results) || !Number.isFinite(Date.parse(job.createdAt || ""))
    || !["calculated", "publishing", "publication_failed", "completed"].includes(job.state))
    throw failure("INVALID_INSTANT_PUBLICATION", "A saved instant calculation is required for publication.");
  const snapshotCache = require("./signal-snapshot-cache");
  const analysisCache = require("./trend-analysis-cache");
  const analysis = options.analysisStore || getCompatibleStore({ name: "trend-analysis", consistency: "strong" });
  const snapshots = options.snapshotStore || getCompatibleStore({ name: "trend-signal-snapshots", consistency: "strong" });
  const key = `jobs/${job.jobId}`;
  const readJob = id => analysis.get(`jobs/${id}`, { type: "json" });
  let entry = await analysis.getWithMetadata(key, { type: "json" });
  if (!sameCalculation(entry?.data, job)) throw failure("INSTANT_CALCULATION_CHANGED", "Saved instant calculation differs from the publication input.");
  if (entry.data.state === "completed" && entry.data.publicationState === "published") return entry.data;
  const calculatedAt = job.calculatedAt || job.completedAt || new Date().toISOString();
  const prepared = { ...entry.data, state: "publishing", currentStage: "publishing", publicationState: "pending",
    calculatedAt, completedAt: calculatedAt, progress: 99, resumable: true, message: "계산 완료 · 결과 게시 중" };
  if (!(await analysis.setJSON(key, prepared, { onlyIfMatch: entry.etag }))?.modified)
    throw failure("INSTANT_PUBLICATION_CONFLICT", "Instant calculation changed before publication.");
  try {
    const publicationOptions = { requiresCompleted: true, readJob, store: snapshots };
    await (options.writeSnapshot || snapshotCache.writeSnapshot)(prepared, publicationOptions);
    const completed = { ...prepared, state: "completed", currentStage: "completed", publicationState: "published",
      publishedAt: new Date().toISOString(), progress: 100, resumable: false, message: "분석 완료", errors: [] };
    const publishLast = completed.partialAnalysis ? options.writeLastPartial || analysisCache.writeLastPartial
      : options.writeLastSuccess || analysisCache.writeLastSuccess;
    await publishLast(completed, { requiresCompleted: true, store: analysis, readJob });
    const storedSnapshot = await snapshots.get(`snapshots/${job.jobId}`, { type: "json" });
    if (digest(storedSnapshot) !== digest(snapshotCache.buildSnapshot(prepared)))
      throw failure("INSTANT_SNAPSHOT_VERIFY_FAILED", "Instant snapshot does not match its saved calculation.");
    entry = await analysis.getWithMetadata(key, { type: "json" });
    if (!sameCalculation(entry?.data, prepared) || !["publishing", "publication_failed"].includes(entry.data.state))
      throw failure("INSTANT_PUBLICATION_CONFLICT", "Instant calculation changed during publication.");
    if (!(await analysis.setJSON(key, completed, { onlyIfMatch: entry.etag }))?.modified)
      throw failure("INSTANT_PUBLICATION_CONFLICT", "Instant completion could not be committed.");
    const confirmed = await readJob(job.jobId);
    if (!sameCalculation(confirmed, completed) || confirmed.state !== "completed" || confirmed.publicationState !== "published")
      throw failure("INSTANT_COMPLETION_VERIFY_FAILED", "Instant completion could not be verified.");
    return confirmed;
  } catch (error) {
    const current = await analysis.getWithMetadata(key, { type: "json" }).catch(() => null);
    if (sameCalculation(current?.data, prepared) && current.data.state !== "completed")
      await analysis.setJSON(key, { ...current.data, state: "publication_failed", currentStage: "publishing",
        publicationState: "pending", resumable: true, message: "자동 계산 보존 · 결과 게시 재시도 필요",
        publicationErrorCode: error.code || "INSTANT_PUBLICATION_FAILED", updatedAt: new Date().toISOString() }, { onlyIfMatch: current.etag }).catch(() => null);
    throw error;
  }
}

module.exports = { publishInstant, stagePointer, visiblePointer, patchInstantPublication, writeInstantJobGuarded };
