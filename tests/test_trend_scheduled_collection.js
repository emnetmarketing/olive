const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { run, collectedToday } = require("../netlify/functions/trend-scheduled-runner");

function mocks({ collection = null, running = null, response = { statusCode: 202, body: JSON.stringify({ jobId: "job-1" }) } } = {}) {
  const updates = []; let calls = 0;
  return { updates, get calls() { return calls; }, deps: { skipConnect: true,
    begin: async (source) => ({ executionId: "execution-1", source }), update: async (record, patch) => { updates.push(patch); return { ...record, ...patch }; },
    readLatestCollection: async () => collection, readCurrentJob: async () => running,
    handle: async (event, options) => { calls += 1; assert.equal(options.fastPath, false); const body = JSON.parse(event.body);
      assert.match(body.triggerSource, /^scheduled-/); assert.equal(body.schedulerExecutionId, "execution-1"); return response; } } };
}

test("scheduled cron is registered at 06:00 KST with one 08:00 recovery", () => {
  const toml = fs.readFileSync("netlify.toml", "utf8");
  assert.match(toml, /trend-data-collection-scheduled[\s\S]*0 21 \* \* \*/);
  assert.match(toml, /trend-data-collection-recovery-scheduled[\s\S]*0 23 \* \* \*/);
});

test("scheduled entry dispatches the same slow collection core and records state", async () => {
  const mock = mocks(); const result = await run({ body: "{}" }, "scheduled-primary", mock.deps);
  assert.equal(result.statusCode, 202); assert.equal(mock.calls, 1);
  assert.equal(mock.updates.at(-1).state, "dispatched"); assert.equal(mock.updates.at(-1).jobId, "job-1");
});

test("recovery skips without external collection when today already completed", async () => {
  const now = new Date(); const mock = mocks({ collection: { collectedAt: now.toISOString(), latestDataDate: "2026-09-02" } });
  assert.equal(collectedToday({ collectedAt: now.toISOString() }, now), true);
  const result = await run({ body: "{}" }, "scheduled-recovery", mock.deps);
  assert.equal(result.statusCode, 200); assert.equal(mock.calls, 0); assert.equal(mock.updates.at(-1).stage, "already-collected");
});

test("scheduled duplicate respects the existing atomic analysis lock", async () => {
  const mock = mocks({ running: { jobId: "running-job" } });
  await run({ body: "{}" }, "scheduled-recovery", mock.deps);
  assert.equal(mock.calls, 0); assert.equal(mock.updates.at(-1).stage, "analysis-lock");
});

test("scheduled start failures leave an auditable retryable record", async () => {
  const mock = mocks({ response: { statusCode: 500, body: JSON.stringify({ error: "background unavailable" }) } });
  await run({ body: "{}" }, "scheduled-primary", mock.deps);
  assert.equal(mock.updates.at(-1).state, "failed"); assert.equal(mock.updates.at(-1).retryable, true);
});

test("main Trend status is based on latest-valid while retaining latest attempt diagnostics", () => {
  const source = fs.readFileSync("netlify/functions/trend-cache-status.js", "utf8");
  assert.match(source, /const latestAttempt/);
  assert.match(source, /const latestJob = validSnapshot\?\.jobId \? await readJob/);
  assert.match(source, /schedulerExecution/);
});

test("background completion and failure update scheduled execution without changing analysis calculations", () => {
  const source = fs.readFileSync("netlify/functions/trend-analysis-background.js", "utf8");
  assert.match(source, /schedulerExecutions\.updateById[\s\S]*state: "completed"/);
  assert.match(source, /schedulerExecutions\.updateById[\s\S]*state: "failed"/);
});
