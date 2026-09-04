const { connect, readCurrentJob } = require("./trend-analysis-cache");
const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  connect(event);
  if (event.httpMethod !== "GET") return json(405, { error: "Only GET is allowed." });
  try {
    // A status read must never mutate or release a job owned by another client.
    // Stale cleanup is intentionally limited to acquireJob(), immediately before
    // a caller attempts to start a new analysis.
    const activeJob = await readCurrentJob();
    const job = activeJob || await readCurrentJob({ includeStale: true });
    return json(200, job ? { running: !job.stale, stale: Boolean(job.stale), resumable: Boolean(job.resumable), job }
      : { running: false, stale: false, job: null });
  } catch (error) {
    return json(500, { error: error.message || "Failed to read the current analysis job." });
  }
};
