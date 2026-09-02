const { connectLambda, getStore } = require("@netlify/blobs");
const STORE_NAME = "trend-signal-snapshots"; const LATEST_KEY = "latest-v1";
const LATEST_VALID_KEY = "latest-valid-v1"; const LATEST_ANALYSIS_KEY = "latest-analysis-v1"; const LATEST_COLLECTION_KEY = "latest-collection-v1";
function connect(event) { if (event?.blobs) connectLambda(event); }
function store() { return getStore(STORE_NAME); }
function compactItem(row) { return { keyword: row.keyword, resultType: row.resultType, surgeSignalType: row.surgeSignalType,
  estimatedSurgeCount: row.estimatedSurgeCount, peakDailyLift: row.peakDailyLift, relativeLift: row.peakRelativeLiftPct,
  peakRelativeLiftPct: row.peakRelativeLiftPct,
  relatedBrand: row.relatedSignal?.relatedBrand || row.match?.item?.brand || "", relatedProduct: row.match?.item?.product || "",
  matchScore: Number(row.match?.score || 0), productMatchScore: Number(row.match?.score || 0), shoppingRise: row.shoppingRise ?? null, discoverySource: row.sources || [],
  candidateTier: row.candidateTier || null, latestDataDate: row.latestDataDate, trendFetchedAt: row.trendFetchedAt } }
function isValidSnapshot(snapshot) { return Number(snapshot?.trendCoveragePct || 0) > 0 && Boolean(snapshot?.latestDataDate); }
function shouldAdvanceCollection(job) { return !job?.fastPath && Number(job?.freshFetchCount || 0) > 0; }
async function writeSnapshot(job) {
  const snapshot = { version: 1, jobId: job.jobId, mode: job.mode, startDate: job.startDate, endDate: job.endDate,
    queryStartDate: job.queryStartDate, generatedAt: job.completedAt, latestDataDate: job.latestDataDate,
    trendCoveragePct: job.trendCoveragePct, partialAnalysis: Boolean(job.partialAnalysis), surgeThreshold: job.surgeThreshold,
    matchThreshold: job.matchThreshold, executionPath: job.fastPath ? "fast" : "slow", items: (job.results || []).map(compactItem) };
  const pointer = { jobId: job.jobId, generatedAt: job.completedAt };
  await store().setJSON(`snapshots/${job.jobId}`, snapshot);
  await store().setJSON(LATEST_ANALYSIS_KEY, pointer);
  const valid = isValidSnapshot(snapshot);
  if (valid) await Promise.all([store().setJSON(LATEST_VALID_KEY, pointer), store().setJSON(LATEST_KEY, pointer)]);
  // Only a Slow Path job that actually fetched Trend data may advance the
  // collection clock. Fast Path analysis must never masquerade as collection.
  if (shouldAdvanceCollection(job)) await store().setJSON(LATEST_COLLECTION_KEY, {
    ...pointer, collectedAt: job.trendCollectedAt || job.completedAt, latestDataDate: job.latestDataDate,
    freshFetchCount: Number(job.freshFetchCount || 0), searchTrendApiCallCount: Number(job.searchTrendApiCallCount || 0)
  });
  return { ...snapshot, publishedAsLatestValid: valid };
}
async function readPointer(key) { const pointer = await store().get(key, { type: "json" }).catch(() => null); return pointer?.jobId ? pointer : null; }
async function readSnapshotPointer(key) { const pointer = await readPointer(key); return pointer ? store().get(`snapshots/${pointer.jobId}`, { type: "json" }).catch(() => null) : null; }
async function readLatest() {
  const explicit = await readSnapshotPointer(LATEST_VALID_KEY); if (explicit) return explicit;
  const legacy = await readSnapshotPointer(LATEST_KEY);
  return Number(legacy?.trendCoveragePct || 0) > 0 && legacy?.latestDataDate ? legacy : null;
}
async function readLatestAnalysis() { return readSnapshotPointer(LATEST_ANALYSIS_KEY); }
async function readLatestCollection() { return store().get(LATEST_COLLECTION_KEY, { type: "json" }).catch(() => null); }
module.exports = { connect, writeSnapshot, readLatest, readLatestAnalysis, readLatestCollection, compactItem, isValidSnapshot, shouldAdvanceCollection, LATEST_KEY,
  LATEST_VALID_KEY, LATEST_ANALYSIS_KEY, LATEST_COLLECTION_KEY };
