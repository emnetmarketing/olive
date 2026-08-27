const { connectLambda, getStore } = require("@netlify/blobs");
const STORE_NAME = "trend-signal-snapshots"; const LATEST_KEY = "latest-v1";
function connect(event) { if (event?.blobs) connectLambda(event); }
function store() { return getStore(STORE_NAME); }
function compactItem(row) { return { keyword: row.keyword, resultType: row.resultType, surgeSignalType: row.surgeSignalType,
  estimatedSurgeCount: row.estimatedSurgeCount, peakDailyLift: row.peakDailyLift, relativeLift: row.peakRelativeLiftPct,
  peakRelativeLiftPct: row.peakRelativeLiftPct,
  relatedBrand: row.relatedSignal?.relatedBrand || row.match?.item?.brand || "", relatedProduct: row.match?.item?.product || "",
  matchScore: Number(row.match?.score || 0), productMatchScore: Number(row.match?.score || 0), shoppingRise: row.shoppingRise ?? null, discoverySource: row.sources || [],
  candidateTier: row.candidateTier || null, latestDataDate: row.latestDataDate, trendFetchedAt: row.trendFetchedAt } }
async function writeSnapshot(job) {
  const snapshot = { version: 1, jobId: job.jobId, mode: job.mode, startDate: job.startDate, endDate: job.endDate,
    queryStartDate: job.queryStartDate, generatedAt: job.completedAt, latestDataDate: job.latestDataDate,
    trendCoveragePct: job.trendCoveragePct, partialAnalysis: Boolean(job.partialAnalysis), surgeThreshold: job.surgeThreshold,
    matchThreshold: job.matchThreshold, executionPath: job.fastPath ? "fast" : "slow", items: (job.results || []).map(compactItem) };
  await store().setJSON(`snapshots/${job.jobId}`, snapshot); await store().setJSON(LATEST_KEY, { jobId: job.jobId, generatedAt: job.completedAt }); return snapshot;
}
async function readLatest() { const pointer = await store().get(LATEST_KEY, { type: "json" }).catch(() => null); return pointer?.jobId ? store().get(`snapshots/${pointer.jobId}`, { type: "json" }).catch(() => null) : null; }
module.exports = { connect, writeSnapshot, readLatest, compactItem, LATEST_KEY };
