const { connect, readLatest } = require("./signal-snapshot-cache");
const { connect: connectAnalysis, readLastSuccess } = require("./trend-analysis-cache");
const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
exports.handler = async (event) => { connect(event); connectAnalysis(event); if (event.httpMethod !== "GET") return json(405, { error: "GET only" });
  const snapshot = await readLatest(); if (snapshot) return json(200, snapshot);
  // Read-only compatibility fallback for the legacy empty latest pointer. The
  // last full result remains visible without mutating Production Blob state.
  const job = await readLastSuccess().catch(() => null);
  return job ? json(200, { version: 1, jobId: job.jobId, mode: job.mode, startDate: job.startDate, endDate: job.endDate,
    generatedAt: job.completedAt, latestDataDate: job.latestDataDate, trendCoveragePct: job.trendCoveragePct ?? 100,
    partialAnalysis: false, executionPath: job.fastPath ? "fast" : "slow", items: job.results || [], source: "last-full-fallback" })
    : json(404, { error: "No signal snapshot" }); };
