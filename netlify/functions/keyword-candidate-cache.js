const crypto = require("node:crypto");
const { connectLambda, getStore } = require("@netlify/blobs");

const STORE = "keyword-candidates";
const CACHE_KEY = "current-v2";
const LEGACY_CACHE_KEY = "current";
// Version the mutable job status independently from the durable candidate
// cache so retired background retries cannot overwrite a newer worker's lock.
const STATUS_KEY = "status-v3";

function connect(event) { if (event?.blobs) connectLambda(event); }
function store() { return getStore(STORE); }
async function readCandidateCache() {
  return await store().get(CACHE_KEY, { type: "json" }) || store().get(LEGACY_CACHE_KEY, { type: "json" });
}
async function readCandidateStatus() { return store().get(STATUS_KEY, { type: "json" }); }
async function writeCandidateStatus(value) { await store().setJSON(STATUS_KEY, value); return value; }

async function acquireCandidateJob() {
  const current = await readCandidateStatus();
  const age = Date.now() - Date.parse(current?.updatedAt || 0);
  // The background worker writes a heartbeat every 40 ad groups. A five-minute
  // stale window prevents duplicate live jobs while allowing recovery after a
  // deployment replacement or platform timeout leaves a running lock behind.
  if (current?.state === "running" && age < 5 * 60 * 1000) return { acquired: false, status: current };
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
