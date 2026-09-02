const { connect, readCache } = require("./trend-series-cache");
const { connect: connectQuota, readUsage, statusFor } = require("./trend-api-quota");
const { connect: connectAnalysis, readLastSuccess, readLastPartial } = require("./trend-analysis-cache");
const { connect: connectSnapshot, readLatest: readLatestSnapshot, readLatestAnalysis, readLatestCollection } = require("./signal-snapshot-cache");

exports.handler = async (event) => {
  connect(event); connectQuota(event); connectAnalysis(event); connectSnapshot(event);
  if (event.httpMethod !== "GET") return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  try {
    const [cache, usage, full, partial, snapshot, latestAnalysis, collectionPointer] = await Promise.all([readCache(), readUsage(), readLastSuccess().catch(() => null),
      readLastPartial().catch(() => null), readLatestSnapshot().catch(() => null), readLatestAnalysis().catch(() => null), readLatestCollection().catch(() => null)]);
    const latestJob = [full, partial].filter(Boolean).sort((a, b) => Date.parse(b.completedAt || 0) - Date.parse(a.completedAt || 0))[0] || null;
    const searchRecords = [...cache.entries.values()].map((entry) => entry.search).filter(Boolean);
    const cacheCollectedAt = searchRecords.map((record) => record.fetchedAt).filter(Boolean).sort().at(-1) || null;
    const cacheLatestDataDate = searchRecords.map((record) => record.latestDataDate).filter(Boolean).sort().at(-1) || null;
    const latestCollection = collectionPointer || (cacheCollectedAt ? { collectedAt: cacheCollectedAt, latestDataDate: cacheLatestDataDate,
      source: "trend-cache-records" } : null);
    const validSnapshot = snapshot || (full ? { jobId: full.jobId, generatedAt: full.completedAt, latestDataDate: full.latestDataDate,
      trendCoveragePct: full.trendCoveragePct ?? 100, items: full.results || [], source: "last-full-fallback" } : null);
    return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify({
      ok: true,
      cache: { ...(cache.manifest || {}), loadedEntryCount: cache.entries.size,
        searchTrendEntryCount: [...cache.entries.values()].filter((entry) => entry.search).length,
        shoppingInsightEntryCount: [...cache.entries.values()].filter((entry) => Object.keys(entry.shopping || {}).length).length },
      quota: { searchTrend: statusFor(usage, "searchTrend"), shoppingInsight: statusFor(usage, "shoppingInsight"), updatedAt: usage.updatedAt },
      latestJob: latestJob ? { jobId: latestJob.jobId, latestDataDate: latestJob.latestDataDate, completedAt: latestJob.completedAt,
        trendCoveragePct: latestJob.trendCoveragePct, candidateTiers: latestJob.diagnostic?.funnel?.trendCache?.candidateTiers || {},
        tierPending: latestJob.diagnostic?.funnel?.trendCache?.tierPending || {}, budgetMode: latestJob.budgetMode || latestJob.diagnostic?.funnel?.trendCache?.budgetMode || "normal",
        analyzedCandidateCount: latestJob.analyzedCandidateCount || latestJob.totalCount || 0,
        trendAvailableCount: latestJob.trendAvailableCount || 0, state: latestJob.state,
        executionPath: latestJob.fastPath ? "fast" : "slow" } : null,
      snapshot: validSnapshot ? { jobId: validSnapshot.jobId, generatedAt: validSnapshot.generatedAt, latestDataDate: validSnapshot.latestDataDate,
        trendCoveragePct: validSnapshot.trendCoveragePct, resultCount: validSnapshot.items?.length || 0, source: validSnapshot.source || "signal-snapshot" } : null,
      latestCollection,
      latestAnalysis: latestAnalysis ? { jobId: latestAnalysis.jobId, analyzedAt: latestAnalysis.generatedAt,
        latestDataDate: latestAnalysis.latestDataDate, trendCoveragePct: latestAnalysis.trendCoveragePct,
        resultCount: latestAnalysis.items?.length || 0, executionPath: latestAnalysis.executionPath } : latestJob ? {
          jobId: latestJob.jobId, analyzedAt: latestJob.completedAt, latestDataDate: latestJob.latestDataDate,
          trendCoveragePct: latestJob.trendCoveragePct, resultCount: latestJob.resultCount, executionPath: latestJob.fastPath ? "fast" : "slow"
        } : null,
    }) };
  } catch (error) {
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: error.message }) };
  }
};
