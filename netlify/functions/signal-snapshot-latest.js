const { connect, readLatest } = require("./signal-snapshot-cache");
const { connect: connectAnalysis, readLastSuccess, readLastPartial } = require("./trend-analysis-cache");
const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
exports.handler = async (event) => { connect(event); connectAnalysis(event); if (event.httpMethod !== "GET") return json(405, { error: "GET only" });
  const mode = event.queryStringParameters?.mode === "period" ? "period" : "instant";
  const snapshot = await readLatest(mode); if (snapshot) return json(200, snapshot);
  // Read-only compatibility fallback for the legacy empty latest pointer. The
  // last full result remains visible without mutating Production Blob state.
  const jobs = await Promise.all([readLastSuccess(mode).catch(() => null), readLastPartial(mode).catch(() => null)]);
  const job = jobs.filter(Boolean).sort((a, b) => Date.parse(b.completedAt || 0) - Date.parse(a.completedAt || 0))[0] || null;
  return job ? json(200, { version: 1, jobId: job.jobId, mode: job.mode, startDate: job.startDate, endDate: job.endDate,
    generatedAt: job.completedAt, latestDataDate: job.latestDataDate, trendCoveragePct: job.trendCoveragePct ?? 100,
    partialAnalysis: Boolean(job.partialAnalysis), executionPath: job.fastPath ? "fast" : "slow", items: job.results || [], source: "mode-analysis-fallback" })
    : json(404, { error: "No signal snapshot" }); };
