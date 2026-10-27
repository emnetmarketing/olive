const { handle } = require("./trend-analysis-start");
const { connect: connectSnapshot, readLatestCollection } = require("./signal-snapshot-cache");
const { connect: connectAnalysis, readCurrentJob } = require("./trend-analysis-cache");
const executions = require("./trend-scheduler-execution-cache");
const { recoverWaiting } = require("./instant-dispatch");

function seoulDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(value).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function collectedToday(collection, now = new Date()) {
  const target = new Date(`${seoulDate(now)}T00:00:00Z`); target.setUTCDate(target.getUTCDate() - 1);
  return Boolean(collection?.collectedAt) && seoulDate(new Date(collection.collectedAt)) === seoulDate(now)
    && Boolean(collection.latestDataDate) && collection.latestDataDate >= target.toISOString().slice(0, 10)
    && Number(collection.sourceFreshness?.refreshPendingCount || 0) === 0;
}
async function run(event, source, overrides = {}) {
  const deps = { handle, readLatestCollection, readCurrentJob, recoverWaiting, begin: executions.begin, update: executions.update, ...overrides };
  if (!overrides.skipConnect) { connectSnapshot(event); connectAnalysis(event); executions.connect(event); }
  let execution;
  try {
    execution = await deps.begin(source, (() => { try { return JSON.parse(event.body || "{}").next_run || null; } catch { return null; } })());
    if (String(process.env.DISABLE_SCHEDULED_TREND_COLLECTION || "false").toLowerCase() === "true") {
      await deps.update(execution, { state: "skipped", stage: "disabled", retryable: false });
      return { statusCode: 200, body: "scheduled Trend collection is explicitly disabled" };
    }
    const [collection, running] = await Promise.all([deps.readLatestCollection(), deps.readCurrentJob()]);
    if (collectedToday(collection)) {
      await deps.update(execution, { state: "skipped", stage: "already-collected", retryable: false,
        latestCollectionAt: collection.collectedAt, latestDataDate: collection.latestDataDate || null });
      return { statusCode: 200, body: "today's Trend collection is already complete" };
    }
    if (running) {
      await deps.update(execution, { state: "skipped", stage: "analysis-lock", retryable: true, jobId: running.jobId });
      return { statusCode: 200, body: "an analysis job is already running" };
    }
    const now = new Date(), target = new Date(`${seoulDate(now)}T00:00:00Z`);
    target.setUTCDate(target.getUTCDate() - 1);
    const resumed = await deps.recoverWaiting({ requiredCollectionTarget: target.toISOString().slice(0, 10),
      dispatchDeadline: now.getTime() + 12000 });
    if (resumed) {
      await deps.update(execution, { state: "skipped", stage: "existing-checkpoint-queued", jobId: resumed.jobId,
        resumedExecutionId: resumed.schedulerExecutionId || null, retryable: false });
      return { statusCode: 202, body: JSON.stringify({ jobId: resumed.jobId, existing: true, resumed: true }) };
    }
    const response = await deps.handle({ ...event, httpMethod: "POST", body: JSON.stringify({ mode: "instant", triggerSource: source,
      schedulerExecutionId: execution.executionId }) }, { fastPath: false });
    let payload = {}; try { payload = JSON.parse(response.body || "{}"); } catch {}
    const ok = response.statusCode >= 200 && response.statusCode < 300;
    await deps.update(execution, { state: ok ? "dispatched" : "failed", stage: ok ? "background-dispatched" : "start-failed",
      jobId: payload.jobId || null, statusCode: response.statusCode, failedAt: ok ? null : new Date().toISOString(),
      errorCode: ok ? null : `HTTP_${response.statusCode}`, errorMessage: ok ? null : payload.error || response.body || "start failed", retryable: !ok });
    return response;
  } catch (error) {
    if (execution) await deps.update(execution, { state: "failed", stage: "scheduler-exception", failedAt: new Date().toISOString(),
      errorCode: "SCHEDULER_EXCEPTION", errorMessage: error.message, retryable: true }).catch(() => {});
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
}

module.exports = { run, seoulDate, collectedToday };
