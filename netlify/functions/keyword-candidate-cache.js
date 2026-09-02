const crypto = require("node:crypto");
const { connectLambda, getStore } = require("@netlify/blobs");

const STORE = "keyword-candidates";
const CACHE_KEY = "current-v5";
const LEGACY_CACHE_KEY = "current";
const PREVIOUS_CACHE_KEYS = ["current-v4", "current-v3", "current-v2"];
// Version the mutable job status independently from the durable candidate
// cache so retired background retries cannot overwrite a newer worker's lock.
const STATUS_KEY = "status-v6";

function connect(event) { if (event?.blobs) connectLambda(event); }
function store() { return getStore(STORE); }
async function readCandidateCache(options = {}) {
  let source = await store().get(CACHE_KEY, { type: "json" });
  for (const key of PREVIOUS_CACHE_KEYS) if (!source) source = await store().get(key, { type: "json" });
  source ||= await store().get(LEGACY_CACHE_KEY, { type: "json" });
  if (!source || options.summaryOnly || !source.shardKeys?.length) return source;
  const shards = await Promise.all(source.shardKeys.map((key) => store().get(key, { type: "json" })));
  return { ...source, candidates: shards.flatMap((shard) => shard?.candidates || []) };
}
async function writeCandidateCache(cache) {
  const version = String(cache.refreshedAt || Date.now()).replace(/[^0-9]/g, "");
  const shardKeys = []; const writes = [];
  for (let offset = 0; offset < cache.candidates.length; offset += 2500) {
    const key = `shards/${version}/${offset / 2500}`;
    shardKeys.push(key);
    writes.push(store().setJSON(key, { candidates: cache.candidates.slice(offset, offset + 2500) }));
  }
  await Promise.all(writes);
  const manifest = { ...cache, candidates: undefined, shardKeys, shardCount: shardKeys.length };
  await store().setJSON(CACHE_KEY, manifest);
  return manifest;
}
async function readCandidateStatus() { return store().get(STATUS_KEY, { type: "json" }); }
async function writeCandidateStatus(value) { await store().setJSON(STATUS_KEY, value); return value; }

async function acquireCandidateJob() {
  const entry = await store().getWithMetadata(STATUS_KEY, { type: "json" });
  const current = entry?.data || null;
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
  const lock = await store().setJSON(STATUS_KEY, status, entry?.etag ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
  if (!lock.modified) return { acquired: false, status: await readCandidateStatus() };
  return { acquired: true, status };
}

module.exports = {
  connect, store, readCandidateCache, writeCandidateCache, readCandidateStatus, writeCandidateStatus,
  acquireCandidateJob, CACHE_KEY
};
