const { connect, readCache, targetDataDate } = require("./trend-series-cache");
const { connect: connectQuota, readUsage, statusFor } = require("./trend-api-quota");
const { connect: connectAnalysis, readLastSuccess, readLastPartial, readJob } = require("./trend-analysis-cache");
const { connect: connectSnapshot, readLatest: readLatestSnapshot, readLatestAnalysis, readLatestCollection } = require("./signal-snapshot-cache");
const schedulerExecutions = require("./trend-scheduler-execution-cache");
const { selectCompletedInstant, selectionReason } = require("./instant-selection-policy");

function observationStatus({ selected, latestAnalysis, scheduledJob, collection, target }) {
  const preflight = scheduledJob?.targetDatePreflight;
  const currentPreflight = preflight?.targetDataDate === target ? preflight : null;
  const times = [currentPreflight?.lastCheckedAt, latestAnalysis?.sourceFreshness?.sourceObservedAt,
    latestAnalysis?.trendCollectedAt, collection?.collectedAt].filter(value => Number.isFinite(Date.parse(value || ""))).sort();
  const reason = selectionReason(latestAnalysis, selected);
  return { targetDataDate: target, lastSourceCheckedAt: times.at(-1) || null,
    preflight: currentPreflight || null, mainSelection: reason,
    lastAttempt: latestAnalysis ? { jobId: latestAnalysis.jobId, state: latestAnalysis.state,
      targetDataDate: latestAnalysis.targetDataDate || latestAnalysis.sourceFreshness?.targetDataDate || null,
      actualDataDate: latestAnalysis.latestDataDate || null, calculatedAt: latestAnalysis.calculatedAt || latestAnalysis.completedAt || null,
      publishedAt: latestAnalysis.publishedAt || null, resultCount: latestAnalysis.resultCount ?? latestAnalysis.results?.length ?? null } : null };
}

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
    const fallbackJob = selectCompletedInstant([full, partial]);
    const validSnapshot = snapshot || (fallbackJob ? { jobId: fallbackJob.jobId, generatedAt: fallbackJob.completedAt, latestDataDate: fallbackJob.latestDataDate,
      trendCoveragePct: fallbackJob.trendCoveragePct ?? 100, items: fallbackJob.results || [], source: "instant-analysis-fallback" } : null);
    const latestJob = validSnapshot?.jobId ? await readJob(validSnapshot.jobId).catch(() => null) : fallbackJob;
    const attemptJob = latestAnalysis?.jobId && latestAnalysis.jobId !== latestJob?.jobId
      ? await readJob(latestAnalysis.jobId).catch(() => null) : latestAnalysis?.jobId === latestJob?.jobId ? latestJob : latestAttempt;
    const scheduledJob = schedulerExecution?.jobId && schedulerExecution.jobId !== attemptJob?.jobId && schedulerExecution.jobId !== latestJob?.jobId
      ? await readJob(schedulerExecution.jobId).catch(() => null)
      : schedulerExecution?.jobId === attemptJob?.jobId ? attemptJob : schedulerExecution?.jobId === latestJob?.jobId ? latestJob : null;
    const target = targetDataDate("9999-12-31");
    const actual = validSnapshot?.latestDataDate || latestJob?.latestDataDate || null;
    const sourceFreshness = latestJob?.sourceFreshness || validSnapshot?.sourceFreshness || null;
    return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify({
      ok: true,
      observation: observationStatus({ selected: latestJob, latestAnalysis: attemptJob, scheduledJob, collection: latestCollection, target }),
      freshness: { ...(sourceFreshness || {}), targetDataDate: target, actualDataDate: actual,
        observedTargetDate: sourceFreshness?.targetDataDate || null,
        targetDataCandidateCount: sourceFreshness?.targetDataDate === target ? sourceFreshness.targetDataCandidateCount : null,
        targetDataCoveragePct: sourceFreshness?.targetDataDate === target ? sourceFreshness.targetDataCoveragePct : null,
        status: !actual ? "missing" : actual < target ? "delayed" : Number(sourceFreshness?.targetDataCoveragePct ?? 100) < 100 ? "partial" : "normal",
        lastCalculatedAt: latestJob?.calculatedAt || latestJob?.completedAt || validSnapshot?.generatedAt || null,
        lastPublishedAt: latestJob?.publishedAt || validSnapshot?.publishedAt || null,
        lastSuccessfulCollectionAt: latestCollection?.collectedAt || null },
      cache: { ...(cache.manifest || {}), loadedEntryCount: cache.entries.size,
        searchTrendEntryCount: [...cache.entries.values()].filter((entry) => entry.search).length,
        shoppingInsightEntryCount: [...cache.entries.values()].filter((entry) => Object.keys(entry.shopping || {}).length).length },
      quota: { searchTrend: statusFor(usage, "searchTrend"), shoppingInsight: statusFor(usage, "shoppingInsight"), updatedAt: usage.updatedAt },
      latestJob: latestJob ? { jobId: latestJob.jobId, latestDataDate: latestJob.latestDataDate, completedAt: latestJob.completedAt,
        trendCoveragePct: latestJob.trendCoveragePct, candidateTiers: latestJob.diagnostic?.funnel?.trendCache?.candidateTiers || {},
        tierPending: latestJob.diagnostic?.funnel?.trendCache?.tierPending || {}, budgetMode: latestJob.budgetMode || latestJob.diagnostic?.funnel?.trendCache?.budgetMode || "normal",
        analyzedCandidateCount: latestJob.analyzedCandidateCount || latestJob.totalCount || 0,
        trendAvailableCount: latestJob.trendAvailableCount || 0, state: latestJob.state,
        productCacheObservedAt: latestJob.productCacheObservedAt || null,
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
exports.observationStatus = observationStatus;
