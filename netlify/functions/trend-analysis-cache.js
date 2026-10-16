const crypto = require("node:crypto");
const { connectLambda, getStore } = require("@netlify/blobs");
const periodPublication = require("./period-publication");

const STORE = "trend-analysis";
const CURRENT_JOB_KEY = "current-job/v1";
const DIAGNOSTIC_INDEX_KEY = "diagnostics/latest-v1";
const STALE_JOB_MS = 12 * 60 * 1000;
function connect(event) { if (event?.blobs) connectLambda(event); periodPublication.connect(event); }
function store() { return getStore(STORE); }
function lastSuccessKeys(mode) { return { mode: `last-success/${mode}`, latest: "last-success/latest" }; }
function lastPartialKeys(mode) { return { mode: `last-partial/${mode}`, latest: "last-partial/latest" }; }
async function readRawJob(jobId) { return store().get(`jobs/${jobId}`, { type: "json", consistency: "strong" }); }
function recoveryStore() { return getStore({ name: "trend-period-recovery", consistency: "strong" }); }
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
  const recovery = await recoveryStore().get(recoveryControlKey(jobId), { type: "json", consistency: "strong" });
  return recovery?.jobId === jobId ? overlayRecovery(raw, recovery) : raw;
}
async function writeJob(jobId, value) { await store().setJSON(`jobs/${jobId}`, value); return value; }
function periodJobGeneration(job) {
  return Number(job?.publicationGeneration) || Date.parse(job?.createdAt || job?.completedAt || "") || 0;
}
async function readCanonicalPeriodKind(legacy, partial) {
  const published = await periodPublication.readLatestKind({ partial });
  const canonical = published?.job;
  if (!canonical || Boolean(canonical.partialAnalysis) !== partial) return legacy;
  return !legacy || periodJobGeneration(canonical) >= periodJobGeneration(legacy) ? canonical : legacy;
}
async function publishCompletedPeriod(job, snapshot) {
  const generation = Date.parse(job?.createdAt || "");
  if (job?.mode !== "period" || !Number.isSafeInteger(generation)) throw new Error("A period Job creation generation is required for publication.");
  return periodPublication.publishPeriod({ job, snapshot, generation, leaseToken: `normal-period:${job.jobId}:${generation}` }, {
    assertLease: async () => {
      const [raw, recovery] = await Promise.all([
        readRawJob(job.jobId),
        recoveryStore().get(recoveryControlKey(job.jobId), { type: "json", consistency: "strong" })
      ]);
      return Boolean(raw && raw.mode === "period" && raw.jobId === job.jobId && Date.parse(raw.createdAt || "") === generation
        && !["failed", "interrupted", "continuation_failed", "cancelled"].includes(raw.state) && !recovery);
    }
  });
}
async function writeLastSuccess(job) {
  if (!job?.jobId || job.state !== "completed") throw new Error("Only a completed analysis job can be published as the last successful result.");
  const pointer = { jobId: job.jobId, mode: job.mode, completedAt: job.completedAt, updatedAt: new Date().toISOString() };
  const keys = lastSuccessKeys(job.mode);
  await Promise.all([store().setJSON(keys.mode, pointer), store().setJSON(keys.latest, pointer)]);
  return pointer;
}
async function readLastSuccess(mode = "latest") {
  const pointer = await store().get(`last-success/${mode}`, { type: "json" });
  const job = pointer?.jobId ? await readJob(pointer.jobId) : null;
  const legacy = job?.state === "completed" ? job : null;
  return mode === "period" ? readCanonicalPeriodKind(legacy, false) : legacy;
}
async function writeLastPartial(job) {
  if (!job?.jobId || job.state !== "completed" || !job.partialAnalysis) throw new Error("Only a completed partial analysis job can be published.");
  const pointer = { jobId: job.jobId, mode: job.mode, completedAt: job.completedAt, updatedAt: new Date().toISOString() };
  const keys = lastPartialKeys(job.mode);
  await Promise.all([store().setJSON(keys.mode, pointer), store().setJSON(keys.latest, pointer)]);
  return pointer;
}
async function readLastPartial(mode = "latest") {
  const pointer = await store().get(`last-partial/${mode}`, { type: "json" });
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
async function readCurrentJob({ markStale = false, includeStale = false } = {}) {
  const pointer = await store().get(CURRENT_JOB_KEY, { type: "json" });
  if (!pointer?.jobId) return null;
  const job = await readJob(pointer.jobId);
  if (!job || !["running", "publishing", "recovering"].includes(job.state)) return null;
  const age = Date.now() - Date.parse(job.updatedAt || job.createdAt || 0);
  if (Number.isFinite(age) && age <= STALE_JOB_MS) return job;
  // Recovery owns its immutable artifacts and control record. A legacy lock
  // read must not rewrite the original Job from this read-only status overlay.
  if (job.recovery) return includeStale ? { ...job, stale: true, state: "interrupted", resumable: true } : null;
  if (includeStale && !markStale) return { ...job, stale: true, resumable: Boolean(job.historicalCollection),
    currentStage: "interrupted", message: "분석 실행이 중단됨 · 저장된 checkpoint/cache에서 재개 가능",
    lastCursor: Number(job.calculationCursor || job.processedCount || 0),
    remainingCount: Math.max(0, Number(job.totalCount || 0) - Number(job.calculationCursor || job.processedCount || 0)) };
  if (markStale) await writeJob(job.jobId, { ...job, state: job.historicalCollection ? "interrupted" : "failed",
    resumable: Boolean(job.historicalCollection), currentStage: job.historicalCollection ? "interrupted" : job.currentStage,
    message: job.historicalCollection ? "기간 분석 중단 · 저장된 checkpoint/cache에서 재개 가능" : "Stale analysis job expired.",
    lastCursor: Number(job.calculationCursor || job.processedCount || 0), failedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    errors: ["Analysis job stopped updating and was released."] });
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
  publishCompletedPeriod, periodJobGeneration, CURRENT_JOB_KEY, DIAGNOSTIC_INDEX_KEY, STALE_JOB_MS };
