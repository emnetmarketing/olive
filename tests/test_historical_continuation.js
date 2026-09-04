const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const continuation = require("../netlify/functions/historical-continuation");
const quota = require("../netlify/functions/trend-api-quota");

const job = { jobId: "job-1", startDate: "2026-08-30", endDate: "2026-09-01", queryStartDate: "2026-08-02",
  surgeThreshold: 300, matchThreshold: 50, historicalCollection: true };
const eligible = Array.from({ length: 4850 }, (_, index) => ({ keyword: `keyword-${index}` }));

test("historical calculation uses a bounded chunk instead of one 5,000-item invocation", () => {
  assert.equal(continuation.MAX_CALCULATION_CHUNK, 1000);
  assert.ok(continuation.MAX_CALCULATION_CHUNK < 5000);
});
test("safe execution time leaves substantial room before Netlify's 15 minute limit", () => {
  assert.equal(continuation.SAFE_EXECUTION_MS, 7 * 60 * 1000);
  assert.ok(continuation.SAFE_EXECUTION_MS < 15 * 60 * 1000);
});
test("calculation yields when the bounded chunk is reached", () => {
  assert.equal(continuation.shouldContinue({ startedAt: 0, now: 100, cursor: 1000, invocationStartCursor: 0, totalCount: 4850 }), true);
});
test("calculation yields when the safe clock budget is reached", () => {
  assert.equal(continuation.shouldContinue({ startedAt: 0, now: continuation.SAFE_EXECUTION_MS, cursor: 20, invocationStartCursor: 0, totalCount: 4850 }), true);
});
test("the final cursor does not schedule another calculation continuation", () => {
  assert.equal(continuation.shouldContinue({ startedAt: 0, now: 999999, cursor: 4850, invocationStartCursor: 4000, totalCount: 4850 }), false);
});
test("checkpoint key is exact-window and threshold scoped", () => {
  assert.match(continuation.checkpointKey(job), /2026-08-02_2026-09-01\/300_50-v1/);
});
test("a matching checkpoint resumes at its stored cursor", () => {
  const checkpoint = { version: 1, selectedStartDate: job.startDate, selectedEndDate: job.endDate,
    queryStartDate: job.queryStartDate, requiredWindow: `${job.queryStartDate}:${job.endDate}`,
    totalCount: eligible.length, eligibleKeywords: eligible.map((item) => item.keyword), calculationCursor: 2500 };
  assert.equal(continuation.isCompatible(checkpoint, job, eligible), true);
  assert.equal(checkpoint.calculationCursor, 2500);
});
test("candidate rotation invalidates an incompatible calculation checkpoint", () => {
  const checkpoint = { version: 1, selectedStartDate: job.startDate, selectedEndDate: job.endDate,
    queryStartDate: job.queryStartDate, requiredWindow: `${job.queryStartDate}:${job.endDate}`,
    totalCount: eligible.length, eligibleKeywords: eligible.map((item) => item.keyword) };
  const changed = eligible.slice(); changed[0] = { keyword: "new-keyword" };
  assert.equal(continuation.isCompatible(checkpoint, job, changed), false);
});
test("different requested windows never share calculation checkpoints", () => {
  const checkpoint = { version: 1, selectedStartDate: job.startDate, selectedEndDate: job.endDate,
    queryStartDate: job.queryStartDate, requiredWindow: `${job.queryStartDate}:${job.endDate}`,
    totalCount: eligible.length, eligibleKeywords: eligible.map((item) => item.keyword) };
  assert.equal(continuation.isCompatible(checkpoint, { ...job, endDate: "2026-09-02" }, eligible), false);
});
test("continuation failure is explicitly resumable", () => {
  const patch = continuation.resumablePatch({ calculationCursor: 2000 }, new Error("dispatch failed"));
  assert.equal(patch.state, "continuation_failed"); assert.equal(patch.resumable, true); assert.equal(patch.lastCursor, 2000);
});
test("continuation count is bounded", () => assert.equal(continuation.MAX_CONTINUATIONS, 20));

const background = fs.readFileSync("netlify/functions/trend-analysis-background.js", "utf8");
const cache = fs.readFileSync("netlify/functions/trend-analysis-cache.js", "utf8");
const current = fs.readFileSync("netlify/functions/trend-analysis-current.js", "utf8");
const html = fs.readFileSync("index.html", "utf8");

test("collection hands calculation to a new background invocation", () => {
  assert.match(background, /continuationPhase: "calculation"/); assert.match(background, /invokeContinuation/);
});
test("calculation cursor and job-specific intermediate results are checkpointed", () => {
  assert.match(background, /calculationCursor/); assert.match(background, /rows, calculated, matchedDiagnostics/);
});
test("completed chunks are skipped when calculation resumes", () => assert.match(background, /eligible\.slice\(calculationProcessed\)/));
test("historical exact-window cache lookup still precedes all API fetches", () => {
  assert.ok(background.indexOf("lookupTrendSeries") < background.indexOf("searchFetchLoop:"));
});
test("historical NAVER usage is recorded immediately around each request batch", () => {
  const request = background.indexOf("const settled = await Promise.allSettled");
  const record = background.indexOf('recordMetricDelta("searchTrend")', request);
  assert.ok(request >= 0 && record > request && record - request < 1000);
});
test("final accounting writes only metric deltas and cannot double count recorded batches", () => {
  assert.match(background, /recordedMetrics/); assert.match(background, /Number\(current\[key\]/);
});
test("stale historical jobs are exposed as interrupted and resumable", () => {
  assert.match(cache, /state: job\.historicalCollection \? "interrupted"/); assert.match(current, /includeStale: true/);
});
test("uncertain hard-timeout consumption reduces historical safe availability without fabricating actual usage", () => {
  const usage = { daily: {}, monthly: { searchTrendHistoricalUncertainReserve: 1000 } };
  assert.equal(quota.historicalRemaining(usage).uncertainUsageReserve, 1000);
  assert.equal(quota.historicalRemaining(usage).remaining, 1000);
});
test("period interruption UI reports checkpoint progress and resumability", () => {
  assert.match(html, /기간 분석 중단/); assert.match(html, /저장된 checkpoint\/cache에서 재개 가능/);
});
test("historical continuation does not alter instant or Early Signal code paths", () => {
  assert.match(background, /job\.historicalCollection/);
  assert.doesNotMatch(fs.readFileSync("netlify/functions/historical-continuation.js", "utf8"), /earlySignal|writeSnapshot|latestInstant|youtube|search.?ad/i);
});
