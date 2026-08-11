const crypto = require("node:crypto");
const { connectLambda, getStore } = require("@netlify/blobs");

const STORE = "trend-analysis";
function connect(event) { if (event?.blobs) connectLambda(event); }
function store() { return getStore(STORE); }
function lastSuccessKeys(mode) { return { mode: `last-success/${mode}`, latest: "last-success/latest" }; }
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

async function createJob(input) {
  const now = new Date().toISOString();
  const job = { jobId: crypto.randomUUID(), state: "running", message: "분석 준비 중", createdAt: now, updatedAt: now, progress: 0, ...input };
  await writeJob(job.jobId, job);
  return job;
}

module.exports = { connect, store, readJob, writeJob, createJob, writeLastSuccess, readLastSuccess, lastSuccessKeys };
