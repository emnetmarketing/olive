const { connect, readCache } = require("./trend-series-cache");
const { connect: connectQuota, readUsage, statusFor } = require("./trend-api-quota");
const { connect: connectAnalysis, readLastSuccess, readLastPartial, readJob } = require("./trend-analysis-cache");
const { connect: connectSnapshot, readLatest: readLatestSnapshot, readLatestAnalysis, readLatestCollection } = require("./signal-snapshot-cache");
const schedulerExecutions = require("./trend-scheduler-execution-cache");

exports.handler = async (event) => {
  connect(event); connectQuota(event); connectAnalysis(event); connectSnapshot(event); schedulerExecutions.connect(event);
  if (event.httpMethod !== "GET") return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  try {
    const [cache, usage, full, partial, snapshot, latestAnalysis, collectionPointer, schedulerExecution] = await Promise.all([readCache(), readUsage(), readLastSuccess("instant").catch(() => null),
      readLastPartial("instant").catch(() => null), readLatestSnapshot("instant").catch(() => null), readLatestAnalysis("instant").catch(() => null),
      readLatestCollection().catch(() => null), schedulerExecutions.readLatest().catch(() => null)]);
    const latestAttempt = [full, partial].filter(Boolean).sort((a, b) => Date.parse(b.completedAt || 0) - Date.parse(a.completedAt || 0))[0] || null;
    const searchRecords = [...cache.entries.values()].map((entry) => entry.search).filter(Boolean);
    const cacheCollectedAt = searchRecords.map((record) => record.fetchedAt).filter(Boolean).sort().at(-1) || null;
    const cacheLatestDataDate = searchRecords.map((record) => record.latestDataDate).filter(Boolean).sort().at(-1) || null;
    const latestCollection = collectionPointer || (cacheCollectedAt ? { collectedAt: cacheCollectedAt, latestDataDate: cacheLatestDataDate,
      source: "trend-cache-records" } : null);
    const fallbackJob = [full, partial].filter((job) => job?.latestDataDate && Number(job?.trendCoveragePct || 0) >= 10)
      .sort((a, b) => Date.parse(b.completedAt || 0) - Date.parse(a.completedAt || 0))[0] || null;
    const validSnapshot = snapshot || (fallbackJob ? { jobId: fallbackJob.jobId, generatedAt: fallbackJob.completedAt, latestDataDate: fallbackJob.latestDataDate,
      trendCoveragePct: fallbackJob.trendCoveragePct ?? 100, items: fallbackJob.results || [], source: "instant-analysis-fallback" } : null);
    const latestJob = validSnapshot?.jobId ? await readJob(validSnapshot.jobId).catch(() => null) : fallbackJob;
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
      schedulerExecution,
      latestAttempt: latestAttempt ? { jobId: latestAttempt.jobId, completedAt: latestAttempt.completedAt, state: latestAttempt.state,
        trendCoveragePct: latestAttempt.trendCoveragePct, latestDataDate: latestAttempt.latestDataDate,
        executionPath: latestAttempt.fastPath ? "fast" : "slow" } : null,
      automation: { marketDiscoverySchedule: "every-6-hours", keywordCandidateSchedule: "daily-17:00-UTC",
        trendCollectionSchedule: "daily-21:00-UTC", trendRecoverySchedule: "daily-23:00-UTC",
        trendCollectionEnabled: String(process.env.DISABLE_SCHEDULED_TREND_COLLECTION || "false").toLowerCase() !== "true",
        legacyEnableSetting: process.env.ENABLE_SCHEDULED_TREND_COLLECTION == null ? "unset" : String(process.env.ENABLE_SCHEDULED_TREND_COLLECTION) },
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
