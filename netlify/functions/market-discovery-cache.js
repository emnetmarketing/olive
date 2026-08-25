const crypto = require("node:crypto");
const { connectLambda, getStore } = require("@netlify/blobs");
const STORE = "market-discovery"; const CACHE_KEY = "current-v1"; const STATUS_KEY = "status-v1"; const TRUSTED_CHANNELS_KEY = "youtube-trusted-channels";
function connect(event) { if (event?.blobs) connectLambda(event); }
function store() { return getStore(STORE); }
async function readCache() { return store().get(CACHE_KEY, { type: "json" }); }
async function writeCache(value) { await store().setJSON(CACHE_KEY, value); return value; }
async function readStatus() { return store().get(STATUS_KEY, { type: "json" }); }
async function writeStatus(value) { await store().setJSON(STATUS_KEY, value); return value; }
async function readTrustedChannels() { return await store().get(TRUSTED_CHANNELS_KEY, { type: "json" }).catch(() => null) || { channels: [] }; }
async function acquireJob() {
  const current = await readStatus(); const age = Date.now() - Date.parse(current?.updatedAt || 0);
  if (current?.state === "running" && age < 30 * 60 * 1000) return { acquired: false, status: current };
  const now = new Date().toISOString(); const status = { jobId: crypto.randomUUID(), state: "running", message: "신규 시장 후보 수집 준비 중",
    startedAt: now, updatedAt: now, youtubeQuotaDate: current?.youtubeQuotaDate || null,
    youtubeSearchCallsToday: Number(current?.youtubeSearchCallsToday || 0), youtubeApiCallsToday: Number(current?.youtubeApiCallsToday || 0), errors: [] };
  await writeStatus(status); return { acquired: true, status };
}
module.exports = { connect, store, readCache, writeCache, readStatus, writeStatus, readTrustedChannels, acquireJob, CACHE_KEY, STATUS_KEY };
