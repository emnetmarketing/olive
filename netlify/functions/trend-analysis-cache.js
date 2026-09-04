const crypto = require("node:crypto");
const { connectLambda, getStore } = require("@netlify/blobs");

const STORE = "trend-analysis";
const CURRENT_JOB_KEY = "current-job/v1";
const DIAGNOSTIC_INDEX_KEY = "diagnostics/latest-v1";
const STALE_JOB_MS = 12 * 60 * 1000;
function connect(event) { if (event?.blobs) connectLambda(event); }
function store() { return getStore(STORE); }
function lastSuccessKeys(mode) { return { mode: `last-success/${mode}`, latest: "last-success/latest" }; }
function lastPartialKeys(mode) { return { mode: `last-partial/${mode}`, latest: "last-partial/latest" }; }
async function readJob(jobId) { return store().get(`jobs/${jobId}`, { type: "json" }); }
async function writeJob(jobId, value) { await store().setJSON(`jobs/${jobId}`, value); return value; }
async function writeLastSuccess(job) {
  if (!job?.jobId || job.state !== "completed") throw new Error("Only a completed analysis job can be published as the last successful result.");
  const pointer = { jobId: job.jobId, mode: job.mode, completedAt: job.completedAt, updatedAt: new Date().toISOString() };
  const keys = lastSuccessKeys(job.mode);
  await Promise.all([store().setJSON(keys.mode, pointer), store().setJSON(keys.latest, pointer)]);
  return pointer;
}
async function readLastSuccess(mode = "latest") {
  const pointer = await store().get(`last-success/${mode}`, { type: "json" });
  if (!pointer?.jobId) return null;
  const job = await readJob(pointer.jobId);
  return job?.state === "completed" ? job : null;
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
  if (!pointer?.jobId) return null;
  const job = await readJob(pointer.jobId);
  return job?.state === "completed" && job.partialAnalysis ? job : null;
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
  if (!job || job.state !== "running") return null;
  const age = Date.now() - Date.parse(job.updatedAt || job.createdAt || 0);
  if (Number.isFinite(age) && age <= STALE_JOB_MS) return job;
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

module.exports = { connect, store, readJob, writeJob, createJob, acquireJob, readCurrentJob, writeLastSuccess, readLastSuccess,
  writeLastPartial, readLastPartial, writeDiagnosticIndex, readDiagnosticIndex, lastSuccessKeys, lastPartialKeys,
  CURRENT_JOB_KEY, DIAGNOSTIC_INDEX_KEY, STALE_JOB_MS };
