const { getStore } = require("@netlify/blobs");
const { connectLambda, getCompatibleStore } = require("./blob-store-compat");
const periodPublication = require("./period-publication");
const { stagePointer, visiblePointer } = require("./instant-publication");
const STORE_NAME = "trend-signal-snapshots"; const LATEST_KEY = "latest-v1";
const LATEST_VALID_KEY = "latest-valid-v1"; const LATEST_ANALYSIS_KEY = "latest-analysis-v1"; const LATEST_COLLECTION_KEY = "latest-collection-v1";
const MIN_INSTANT_COVERAGE_PCT = 10;
function modeKey(base, mode) { return `${base}/${mode === "period" ? "period" : "instant"}`; }
function connect(event) { if (event?.blobs) connectLambda(event); periodPublication.connect(event); }
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
function shouldAdvanceCollection(job) { return job?.mode === "instant" && !job?.fastPath && Number(job?.freshFetchCount || 0) > 0; }
function buildSnapshot(job) {
  return { version: 1, jobId: job.jobId, mode: job.mode, startDate: job.startDate, endDate: job.endDate,
    createdAt: job.createdAt,
    queryStartDate: job.queryStartDate, generatedAt: job.completedAt, latestDataDate: job.latestDataDate,
    trendCoveragePct: job.trendCoveragePct, partialAnalysis: Boolean(job.partialAnalysis), surgeThreshold: job.surgeThreshold,
    matchThreshold: job.matchThreshold, executionPath: job.fastPath ? "fast" : "slow", items: (job.results || []).map(compactItem) };
}
async function writeSnapshot(job, options = {}) {
  const guarded = options.requiresCompleted === true && job.mode === "instant";
  const blobStore = options.store || (guarded ? getCompatibleStore({ name: STORE_NAME, consistency: "strong" }) : store());
  const readJob = options.readJob || (id => getStore("trend-analysis").get(`jobs/${id}`, { type: "json" }));
  const snapshot = buildSnapshot(job);
  const pointer = { jobId: job.jobId, generatedAt: job.completedAt,
    ...(guarded ? { generation: Date.parse(job.createdAt) } : {}) };
  const writePointer = (key, value = pointer) => guarded ? stagePointer(blobStore, key, value, readJob) : blobStore.setJSON(key, value);
  await blobStore.setJSON(`snapshots/${job.jobId}`, snapshot);
  await writePointer(modeKey(LATEST_ANALYSIS_KEY, snapshot.mode));
  if (snapshot.mode === "instant") await writePointer(LATEST_ANALYSIS_KEY);
  const valid = isValidSnapshot(snapshot);
  let publishedAsLatestValid = false;
  if (snapshot.mode === "period") {
    if (valid) { await writePointer(modeKey(LATEST_VALID_KEY, "period")); publishedAsLatestValid = true; }
  } else {
    const previousInstant = await readSnapshotPointer(modeKey(LATEST_VALID_KEY, "instant"), { store: blobStore, readJob });
    if (shouldPromoteInstant(snapshot, previousInstant)) {
      await Promise.all([writePointer(modeKey(LATEST_VALID_KEY, "instant")),
        // Legacy aliases remain instant-only for backward compatibility.
        writePointer(LATEST_VALID_KEY), writePointer(LATEST_KEY)]);
      publishedAsLatestValid = true;
    }
  }
  // Only a Slow Path job that actually fetched Trend data may advance the
  // collection clock. Fast Path analysis must never masquerade as collection.
  if (shouldAdvanceCollection(job)) await writePointer(LATEST_COLLECTION_KEY, {
    ...pointer, collectedAt: job.trendCollectedAt || job.completedAt, latestDataDate: job.latestDataDate,
    freshFetchCount: Number(job.freshFetchCount || 0), searchTrendApiCallCount: Number(job.searchTrendApiCallCount || 0),
    triggerSource: job.triggerSource || "admin-manual"
  });
  return { ...snapshot, publishedAsLatestValid };
}
async function readPointer(key, options = {}) {
  const pointer = await (options.store || store()).get(key, { type: "json" }).catch(() => null);
  if (!pointer?.jobId) return null;
  return visiblePointer(pointer, options.readJob || (id => getStore("trend-analysis").get(`jobs/${id}`, { type: "json" })));
}
async function readSnapshotPointer(key, options = {}) {
  const pointer = await readPointer(key, options);
  return pointer ? (options.store || store()).get(`snapshots/${pointer.jobId}`, { type: "json" }).catch(() => null) : null;
}
async function choosePeriodSnapshot(legacy, { validOnly = false } = {}) {
  const published = await (validOnly ? periodPublication.readLatestValid() : periodPublication.readLatest());
  if (!published || validOnly && !isValidSnapshot(published.snapshot)) return legacy;
  if (!legacy) return published.snapshot;
  // Legacy snapshots did not retain createdAt. Read the original Job generation
  // so a late-finishing old worker cannot displace a newer recovery publication.
  const legacyJob = legacy.createdAt ? null : await getStore("trend-analysis").get(`jobs/${legacy.jobId}`, { type: "json" });
  const legacyGeneration = Date.parse(legacy.createdAt || legacyJob?.createdAt || legacy.generatedAt || "") || 0;
  return published.commit.generation >= legacyGeneration ? published.snapshot : legacy;
}
async function readLatest(mode = "instant") {
  const normalizedMode = mode === "period" ? "period" : "instant";
  const explicitMode = await readSnapshotPointer(modeKey(LATEST_VALID_KEY, normalizedMode));
  if (normalizedMode === "period") return choosePeriodSnapshot(explicitMode, { validOnly: true });
  if (explicitMode) return explicitMode;
  const explicit = await readSnapshotPointer(LATEST_VALID_KEY); if (explicit?.mode !== "period") return explicit;
  const legacy = await readSnapshotPointer(LATEST_KEY);
  return legacy?.mode !== "period" && Number(legacy?.trendCoveragePct || 0) > 0 && legacy?.latestDataDate ? legacy : null;
}
async function readLatestAnalysis(mode = "instant") {
  const normalizedMode = mode === "period" ? "period" : "instant";
  const explicit = await readSnapshotPointer(modeKey(LATEST_ANALYSIS_KEY, normalizedMode));
  if (normalizedMode === "period") return choosePeriodSnapshot(explicit);
  if (explicit) return explicit;
  const legacy = await readSnapshotPointer(LATEST_ANALYSIS_KEY);
  return legacy?.mode !== "period" ? legacy : null;
}
async function readLatestCollection() { return readPointer(LATEST_COLLECTION_KEY); }
module.exports = { connect, writeSnapshot, buildSnapshot, readLatest, readLatestAnalysis, readLatestCollection, compactItem, isValidSnapshot, shouldPromoteInstant,
  shouldAdvanceCollection, modeKey, MIN_INSTANT_COVERAGE_PCT, LATEST_KEY, LATEST_VALID_KEY, LATEST_ANALYSIS_KEY, LATEST_COLLECTION_KEY };
