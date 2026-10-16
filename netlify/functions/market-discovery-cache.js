const crypto = require("node:crypto");
const { connectLambda, getStore } = require("./blob-store-compat");
const STORE = "market-discovery"; const CACHE_KEY = "current-v1"; const STATUS_KEY = "status-v1"; const TRUSTED_CHANNELS_KEY = "youtube-trusted-channels";
const YOUTUBE_SNAPSHOT_KEY = "youtube-videos/current-v1";
const YOUTUBE_USAGE_KEY = "youtube-usage-v1";
const PRODUCT_CANDIDATES_KEY = "product-candidates/current-v1";
function connect(event) { if (event?.blobs) connectLambda(event); }
function store(strong = false) { return getStore({ name: STORE, ...(strong ? { consistency: "strong" } : {}) }); }
async function readCache() { return store().get(CACHE_KEY, { type: "json" }); }
async function writeCache(value) { await store().setJSON(CACHE_KEY, value); return value; }
async function readStatus() { return store().get(STATUS_KEY, { type: "json" }); }
async function writeStatus(value) { await store().setJSON(STATUS_KEY, value); return value; }
async function readTrustedChannels() { return await store().get(TRUSTED_CHANNELS_KEY, { type: "json" }).catch(() => null) || { channels: [] }; }
async function readYoutubeSnapshot() { return store().get(YOUTUBE_SNAPSHOT_KEY, { type: "json" }).catch(() => null); }
async function writeYoutubeSnapshot(value) {
  // Preserve both the previous source and this run before replacing the current source.
  const previous = await readYoutubeSnapshot();
  for (const snapshot of [previous, value].filter(Boolean)) {
    const key = `youtube-videos/history/${crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
    await store().setJSON(key, snapshot, { onlyIfNew: true });
  }
  await store().setJSON(YOUTUBE_SNAPSHOT_KEY, value); return value;
}
async function readProductCandidates() { return store().get(PRODUCT_CANDIDATES_KEY, { type: "json" }); }
async function writeProductCandidates(value) { await store().setJSON(PRODUCT_CANDIDATES_KEY, value); return value; }
async function readYoutubeUsage() { return store().get(YOUTUBE_USAGE_KEY, { type: "json" }); }
async function mutateYoutubeUsage(mutator) {
  const target = store(true);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const entry = await target.getWithMetadata(YOUTUBE_USAGE_KEY, { type: "json" });
    const next = mutator(entry?.data || null);
    const result = await target.setJSON(YOUTUBE_USAGE_KEY, next, entry?.etag ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
    if (result.modified) return next;
  }
  throw new Error("YouTube 사용량 동시 갱신 충돌 · 추가 호출 중지");
}
async function claimWorker(jobId) {
  const target = store(true); const entry = await target.getWithMetadata(STATUS_KEY, { type: "json" }); const current = entry?.data;
  if (current?.jobId !== jobId || current.state !== "running" || current.workerOwner) return null;
  const workerOwner = crypto.randomUUID();
  const status = { ...current, workerOwner, workerStartedAt: new Date().toISOString() };
  const result = await target.setJSON(STATUS_KEY, status, { onlyIfMatch: entry.etag });
  return result.modified ? status : null;
}
async function writeOwnedStatus(jobId, workerOwner, patch) {
  const target = store(true);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const entry = await target.getWithMetadata(STATUS_KEY, { type: "json" }); const current = entry?.data;
    if (current?.jobId !== jobId || current.workerOwner !== workerOwner || current.state !== "running")
      throw Object.assign(new Error("Discovery worker 소유권이 변경되었습니다."), { code: "DISCOVERY_WORKER_FENCED" });
    const status = { ...current, ...patch, updatedAt: new Date().toISOString() };
    if ((await target.setJSON(STATUS_KEY, status, { onlyIfMatch: entry.etag })).modified) return status;
  }
  throw new Error("Discovery 상태 동시 갱신 충돌");
}
async function acquireJob(options = {}) {
  const target = store(true);
  const entry = await target.getWithMetadata(STATUS_KEY, { type: "json" }); const current = entry?.data || null;
  const age = Date.now() - Date.parse(current?.updatedAt || 0);
  if (current?.state === "running" && age < 30 * 60 * 1000) return { acquired: false, status: current };
  const now = new Date().toISOString(); const status = { jobId: crypto.randomUUID(), state: "running", message: "신규 시장 후보 수집 준비 중",
    sourceMode: options.sourceMode === "cache-only" ? "cache-only" : "collect",
    youtubeSearchLimit: Math.max(1, Math.min(52, Number(options.youtubeSearchLimit) || 52)),
    youtubeSupplementalLimit: Math.max(0, Math.min(100, Number.isFinite(Number(options.youtubeSupplementalLimit)) ? Number(options.youtubeSupplementalLimit) : 100)),
    keywordtoolBackfill: options.keywordtoolBackfill !== false,
    startedAt: now, updatedAt: now, youtubeQuotaDate: current?.youtubeQuotaDate || null,
    youtubeSearchCallsToday: Number(current?.youtubeSearchCallsToday || 0), youtubeApiCallsToday: Number(current?.youtubeApiCallsToday || 0), errors: [] };
  const lock = await target.setJSON(STATUS_KEY, status, entry?.etag ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
  if (!lock.modified) return { acquired: false, status: await readStatus() };
  return { acquired: true, status };
}
module.exports = { connect, store, readCache, writeCache, readStatus, writeStatus, readTrustedChannels,
  readYoutubeSnapshot, writeYoutubeSnapshot, readProductCandidates, writeProductCandidates,
  readYoutubeUsage, mutateYoutubeUsage, claimWorker, writeOwnedStatus,
  acquireJob, CACHE_KEY, STATUS_KEY, YOUTUBE_SNAPSHOT_KEY, YOUTUBE_USAGE_KEY };
