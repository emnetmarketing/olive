const { connect, readCache } = require("./trend-series-cache");
const { connect: connectQuota, readUsage, statusFor } = require("./trend-api-quota");
const { connect: connectAnalysis, readLastSuccess, readLastPartial } = require("./trend-analysis-cache");
const { connect: connectSnapshot, readLatest: readLatestSnapshot } = require("./signal-snapshot-cache");

exports.handler = async (event) => {
  connect(event); connectQuota(event); connectAnalysis(event); connectSnapshot(event);
  if (event.httpMethod !== "GET") return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  try {
    const [cache, usage, full, partial, snapshot] = await Promise.all([readCache(), readUsage(), readLastSuccess().catch(() => null),
      readLastPartial().catch(() => null), readLatestSnapshot().catch(() => null)]);
    const latestJob = [full, partial].filter(Boolean).sort((a, b) => Date.parse(b.completedAt || 0) - Date.parse(a.completedAt || 0))[0] || null;
    return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify({
      ok: true,
      cache: { ...(cache.manifest || {}), loadedEntryCount: cache.entries.size,
        searchTrendEntryCount: [...cache.entries.values()].filter((entry) => entry.search).length,
        shoppingInsightEntryCount: [...cache.entries.values()].filter((entry) => Object.keys(entry.shopping || {}).length).length },
      quota: { searchTrend: statusFor(usage, "searchTrend"), shoppingInsight: statusFor(usage, "shoppingInsight"), updatedAt: usage.updatedAt },
      latestJob: latestJob ? { jobId: latestJob.jobId, latestDataDate: latestJob.latestDataDate, completedAt: latestJob.completedAt,
        trendCoveragePct: latestJob.trendCoveragePct, candidateTiers: latestJob.diagnostic?.funnel?.trendCache?.candidateTiers || {},
        tierPending: latestJob.diagnostic?.funnel?.trendCache?.tierPending || {}, executionPath: latestJob.fastPath ? "fast" : "slow" } : null,
      snapshot: snapshot ? { jobId: snapshot.jobId, generatedAt: snapshot.generatedAt, latestDataDate: snapshot.latestDataDate,
        trendCoveragePct: snapshot.trendCoveragePct, resultCount: snapshot.items?.length || 0 } : null,
    }) };
  } catch (error) {
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: error.message }) };
  }
};
