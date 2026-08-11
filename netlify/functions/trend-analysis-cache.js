const crypto = require("node:crypto");
const { connectLambda, getStore } = require("@netlify/blobs");

const STORE = "trend-analysis";
function connect(event) { if (event?.blobs) connectLambda(event); }
function store() { return getStore(STORE); }
async function readJob(jobId) { return store().get(`jobs/${jobId}`, { type: "json" }); }
async function writeJob(jobId, value) { await store().setJSON(`jobs/${jobId}`, value); return value; }

async function createJob(input) {
  const now = new Date().toISOString();
  const job = { jobId: crypto.randomUUID(), state: "running", message: "분석 준비 중", createdAt: now, updatedAt: now, progress: 0, ...input };
  await writeJob(job.jobId, job);
  return job;
}

module.exports = { connect, store, readJob, writeJob, createJob };
