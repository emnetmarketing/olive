const { connectLambda, getStore } = require("@netlify/blobs");
const STORE_NAME = "trend-signal-snapshots"; const LATEST_KEY = "latest-v1";
const LATEST_VALID_KEY = "latest-valid-v1"; const LATEST_ANALYSIS_KEY = "latest-analysis-v1"; const LATEST_COLLECTION_KEY = "latest-collection-v1";
const MIN_INSTANT_COVERAGE_PCT = 10;
function modeKey(base, mode) { return `${base}/${mode === "period" ? "period" : "instant"}`; }
function connect(event) { if (event?.blobs) connectLambda(event); }
function store() { return getStore(STORE_NAME); }
function compactItem(row) { return { keyword: row.keyword, resultType: row.resultType, surgeSignalType: row.surgeSignalType,
  estimatedSurgeCount: row.estimatedSurgeCount, peakDailyLift: row.peakDailyLift, relativeLift: row.peakRelativeLiftPct,
  peakRelativeLiftPct: row.peakRelativeLiftPct,
  relatedBrand: row.relatedSignal?.relatedBrand || row.match?.item?.brand || "", relatedProduct: row.match?.item?.product || "",
  matchScore: Number(row.match?.score || 0), productMatchScore: Number(row.match?.score || 0), shoppingRise: row.shoppingRise ?? null, discoverySource: row.sources || [],
  candidateTier: row.candidateTier || null, latestDataDate: row.latestDataDate, trendFetchedAt: row.trendFetchedAt,
  marketConfidenceScore: row.marketConfidenceScore ?? null, marketConfidenceGrade: row.marketConfidenceGrade || null,
  marketConfidenceReasons: row.marketConfidenceReasons || [] } }
function isValidSnapshot(snapshot) { return Number(snapshot?.trendCoveragePct || 0) > 0 && Boolean(snapshot?.latestDataDate); }
function shouldPromoteInstant(snapshot, previous) {
  if (snapshot?.mode !== "instant" || !isValidSnapshot(snapshot)) return false;
  const coverage = Number(snapshot.trendCoveragePct || 0);
  if (coverage < MIN_INSTANT_COVERAGE_PCT) return false;
  const previousCoverage = Number(previous?.trendCoveragePct || 0);
  return !isValidSnapshot(previous) || coverage >= previousCoverage * 0.5;
}
function shouldAdvanceCollection(job) { return !job?.fastPath && Number(job?.freshFetchCount || 0) > 0; }
async function writeSnapshot(job) {
  const snapshot = { version: 1, jobId: job.jobId, mode: job.mode, startDate: job.startDate, endDate: job.endDate,
    queryStartDate: job.queryStartDate, generatedAt: job.completedAt, latestDataDate: job.latestDataDate,
    trendCoveragePct: job.trendCoveragePct, partialAnalysis: Boolean(job.partialAnalysis), surgeThreshold: job.surgeThreshold,
    matchThreshold: job.matchThreshold, executionPath: job.fastPath ? "fast" : "slow", items: (job.results || []).map(compactItem) };
  const pointer = { jobId: job.jobId, generatedAt: job.completedAt };
  await store().setJSON(`snapshots/${job.jobId}`, snapshot);
  await store().setJSON(modeKey(LATEST_ANALYSIS_KEY, snapshot.mode), pointer);
  if (snapshot.mode === "instant") await store().setJSON(LATEST_ANALYSIS_KEY, pointer);
  const valid = isValidSnapshot(snapshot);
  let publishedAsLatestValid = false;
  if (snapshot.mode === "period") {
    if (valid) { await store().setJSON(modeKey(LATEST_VALID_KEY, "period"), pointer); publishedAsLatestValid = true; }
  } else {
    const previousInstant = await readSnapshotPointer(modeKey(LATEST_VALID_KEY, "instant"));
    if (shouldPromoteInstant(snapshot, previousInstant)) {
      await Promise.all([store().setJSON(modeKey(LATEST_VALID_KEY, "instant"), pointer),
        // Legacy aliases remain instant-only for backward compatibility.
        store().setJSON(LATEST_VALID_KEY, pointer), store().setJSON(LATEST_KEY, pointer)]);
      publishedAsLatestValid = true;
    }
  }
  // Only a Slow Path job that actually fetched Trend data may advance the
  // collection clock. Fast Path analysis must never masquerade as collection.
  if (shouldAdvanceCollection(job)) await store().setJSON(LATEST_COLLECTION_KEY, {
    ...pointer, collectedAt: job.trendCollectedAt || job.completedAt, latestDataDate: job.latestDataDate,
    freshFetchCount: Number(job.freshFetchCount || 0), searchTrendApiCallCount: Number(job.searchTrendApiCallCount || 0)
  });
  return { ...snapshot, publishedAsLatestValid };
}
async function readPointer(key) { const pointer = await store().get(key, { type: "json" }).catch(() => null); return pointer?.jobId ? pointer : null; }
async function readSnapshotPointer(key) { const pointer = await readPointer(key); return pointer ? store().get(`snapshots/${pointer.jobId}`, { type: "json" }).catch(() => null) : null; }
async function readLatest(mode = "instant") {
  const normalizedMode = mode === "period" ? "period" : "instant";
  const explicitMode = await readSnapshotPointer(modeKey(LATEST_VALID_KEY, normalizedMode)); if (explicitMode) return explicitMode;
  if (normalizedMode === "period") return null;
  const explicit = await readSnapshotPointer(LATEST_VALID_KEY); if (explicit?.mode !== "period") return explicit;
  const legacy = await readSnapshotPointer(LATEST_KEY);
  return legacy?.mode !== "period" && Number(legacy?.trendCoveragePct || 0) > 0 && legacy?.latestDataDate ? legacy : null;
}
async function readLatestAnalysis(mode = "instant") {
  const normalizedMode = mode === "period" ? "period" : "instant";
  const explicit = await readSnapshotPointer(modeKey(LATEST_ANALYSIS_KEY, normalizedMode));
  if (explicit || normalizedMode === "period") return explicit;
  const legacy = await readSnapshotPointer(LATEST_ANALYSIS_KEY);
  return legacy?.mode !== "period" ? legacy : null;
}
async function readLatestCollection() { return store().get(LATEST_COLLECTION_KEY, { type: "json" }).catch(() => null); }
module.exports = { connect, writeSnapshot, readLatest, readLatestAnalysis, readLatestCollection, compactItem, isValidSnapshot, shouldPromoteInstant,
  shouldAdvanceCollection, modeKey, MIN_INSTANT_COVERAGE_PCT, LATEST_KEY, LATEST_VALID_KEY, LATEST_ANALYSIS_KEY, LATEST_COLLECTION_KEY };
