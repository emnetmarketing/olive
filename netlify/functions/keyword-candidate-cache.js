const crypto = require("node:crypto");
const { connectLambda, getStore } = require("@netlify/blobs");

const STORE = "keyword-candidates";
const CACHE_KEY = "current";
const STATUS_KEY = "status";

function connect(event) { if (event?.blobs) connectLambda(event); }
function store() { return getStore(STORE); }
async function readCandidateCache() { return store().get(CACHE_KEY, { type: "json" }); }
async function readCandidateStatus() { return store().get(STATUS_KEY, { type: "json" }); }
async function writeCandidateStatus(value) { await store().setJSON(STATUS_KEY, value); return value; }

async function acquireCandidateJob() {
  const current = await readCandidateStatus();
  const age = Date.now() - Date.parse(current?.updatedAt || 0);
  if (current?.state === "running" && age < 30 * 60 * 1000) return { acquired: false, status: current };
  const now = new Date().toISOString();
  const status = {
    jobId: crypto.randomUUID(), state: "running", message: "검색어 후보 새로고침 준비 중",
    startedAt: now, updatedAt: now, processedAdgroups: 0, totalAdgroups: 0,
    processedSeeds: 0, totalSeeds: 0, apiCalls: 0, retries: 0, errors: []
  };
  await writeCandidateStatus(status);
  return { acquired: true, status };
}

module.exports = {
  connect, store, readCandidateCache, readCandidateStatus, writeCandidateStatus,
  acquireCandidateJob, CACHE_KEY
};
