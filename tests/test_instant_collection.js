const test = require("node:test");
const assert = require("node:assert/strict");
const { classify, createPlan, frozenWindow } = require("../netlify/functions/instant-collection");
const now = new Date("2026-10-16T14:00:00Z");
const job = { jobId: "fixture-instant", mode: "instant", queryStartDate: "2026-09-16", endDate: "2026-10-16",
  targetDataDate: "2026-10-15", createdAt: "2026-10-16T10:51:48Z" };
function record(options = {}) {
  return { version: 1, normalizationVersion: "keyword-v1", timeUnit: "date", source: "search",
    requestStartDate: "2026-09-16", requestEndDate: "2026-10-16", fetchedAt: "2026-10-16T10:54:00Z",
    rawRatioSeries: [{ period: "2026-10-14", ratio: 34 }, { period: "2026-10-15", ratio: 63 }], ...options };
}
test("Instant collection requires an explicit frozen target, window and observation time", () => {
  assert.equal(frozenWindow(job).targetDataDate, "2026-10-15");
  for (const invalid of [{ ...job, targetDataDate: undefined }, { ...job, queryStartDate: "2026-10-17" },
    { ...job, targetDataDate: "2026-02-30" }, { ...job, createdAt: null }, { ...job, mode: "period" },
    { ...job, collectionObservationDate: "invalid-date" }])
    assert.throws(() => frozenWindow(invalid), { code: "INVALID_INSTANT_COLLECTION_INPUT" });
});
test("Target-confirmed cache never re-fetches when the continuation crosses a calendar day", () => {
  const result = classify(record(), {}, job, new Date("2026-10-18T10:00:00Z"));
  assert.equal(result.state, "target-confirmed"); assert.equal(result.targetDataDate, "2026-10-15");
  assert.equal(result.shouldFetch, false); assert.equal(result.reusable, true);
});
test("A later point alone is not fabricated into an observation on the missing target day", () => {
  const result = classify(record({ rawRatioSeries: [{ period: "2026-10-16", ratio: 40 }] }), {}, job, now);
  assert.equal(result.state, "confirmed-no-target"); assert.equal(result.actualDataDate, "2026-10-16");
});
test("Previously successful no-target and empty responses are reused beyond the ordinary 2h/24h delay", () => {
  const late = new Date("2026-10-18T14:00:00Z");
  for (const [rawRatioSeries, state] of [[[{ period: "2026-10-14", ratio: 1 }], "confirmed-no-target"], [[], "empty"]]) {
    const result = classify(record({ rawRatioSeries }), {}, job, late);
    assert.equal(result.state, state); assert.equal(result.shouldFetch, false); assert.equal(result.observedInCollection, true);
  }
});
test("Morning incomplete responses remain due while the prior 550 afternoon successes remain reusable", () => {
  const candidates = Array.from({ length: 5000 }, (_, index) => ({ keyword: `keyword${index}`, priorityScore: 5000 - index }));
  const entries = new Map(candidates.map((candidate, index) => [candidate.keyword, { search: record({
    fetchedAt: index < 550 ? "2026-10-16T10:54:00Z" : "2026-10-15T21:13:00Z",
    rawRatioSeries: [{ period: "2026-10-14", ratio: 1 }] }) }]));
  const result = createPlan(candidates, entries, job, { now });
  assert.equal(result.totalCount, 5000); assert.equal(result.reusableCount, 5000);
  assert.equal(result.counts["confirmed-no-target"], 550); assert.equal(result.fetchCount, 4450);
  assert.deepEqual(result.selected, candidates.slice(550)); assert.equal(result.targetConfirmedCount, 0);
});
test("A recovery Job can explicitly retain the prior successful observation start", () => {
  const recovery = { ...job, createdAt: "2026-10-16T13:00:00Z", collectionObservationStartedAt: job.createdAt };
  assert.equal(classify(record({ rawRatioSeries: [] }), {}, recovery, now).observedInCollection, true);
});
test("Healthy empty responses before this Job are reused for 24h without inventing zeros", () => {
  const result = classify(record({ fetchedAt: "2026-10-15T21:10:00Z", rawRatioSeries: [] }), {}, job, now);
  assert.equal(result.state, "empty"); assert.equal(result.actualDataDate, null); assert.equal(result.shouldFetch, false);
  assert.equal(classify(record({ fetchedAt: "2026-10-14T21:10:00Z", rawRatioSeries: [] }), {}, job, now).shouldFetch, true);
});
test("Fresh incomplete responses before the Job preserve the existing 2h recheck boundary", () => {
  const oldJob = { ...job, createdAt: "2026-10-16T14:00:00Z" };
  const value = record({ fetchedAt: "2026-10-16T12:00:00Z", rawRatioSeries: [{ period: "2026-10-14", ratio: 3 }] });
  assert.equal(classify(value, {}, oldJob, new Date("2026-10-16T13:59:59Z")).shouldFetch, false);
  assert.equal(classify(value, {}, oldJob, now).shouldFetch, true);
});
test("Missing, invalid, failed and insufficient-window cache states are distinct", () => {
  assert.equal(classify(null, {}, job, now).state, "needs-refresh");
  assert.equal(classify(record({ version: 99 }), {}, job, now).state, "error");
  assert.equal(classify(record({ rawRatioSeries: [{ period: "2026-10-15", ratio: null }] }), {}, job, now).state, "error");
  assert.equal(classify(null, { error: "fixture-error" }, job, now).state, "error");
  const mismatch = classify(record({ requestStartDate: "2026-09-17" }), {}, job, now);
  assert.equal(mismatch.state, "window-unavailable"); assert.equal(mismatch.reusable, false); assert.equal(mismatch.shouldFetch, true);
});
test("An attempted keyword is never automatically retried when its response or cache is uncertain", () => {
  const result = classify(null, { attempted: true }, job, now);
  assert.equal(result.state, "error"); assert.equal(result.reason, "already-attempted-in-job"); assert.equal(result.shouldFetch, false);
  const current = classify(record(), { attempted: true }, job, now);
  assert.equal(current.state, "target-confirmed"); assert.equal(current.shouldFetch, false);
});
test("Per-Job attempted receipts suppress duplicates across the frozen plan without hiding missing cache", () => {
  const result = createPlan([{ keyword: "재시도" }, { keyword: "신규" }], new Map(), job,
    { now, attempted: { "재시도": { attempted: true, httpStatus: 200 } } });
  assert.equal(result.fetchCount, 1); assert.equal(result.selected[0].keyword, "신규");
  assert.equal(result.blockedItems.length, 1); assert.equal(result.blockedItems[0].keyword, "재시도");
  assert.equal(result.reusableCount, 0);
});
test("Plan selection preserves frozen order, original objects and normalized keyword deduplication", () => {
  const candidates = [{ keyword: "A b", priorityScore: 4 }, { keyword: "ａｂ", priorityScore: 99 }, { keyword: "Z", priorityScore: 2 }];
  const original = structuredClone(candidates), result = createPlan(candidates, new Map(), job, { now });
  assert.deepEqual(result.selected, [candidates[0], candidates[2]]); assert.equal(result.items[0].candidate, candidates[0]);
  assert.deepEqual(candidates, original);
});
test("Only one compatible response window is selected; series from different windows are never merged", () => {
  const old = record({ fetchedAt: "2026-10-16T10:52:00Z" });
  const incompatible = record({ requestEndDate: "2026-10-15", fetchedAt: "2026-10-16T11:00:00Z", rawRatioSeries: [{ period: "2026-10-15", ratio: 99 }] });
  const result = createPlan([{ keyword: "키워드" }], new Map([["키워드", { search: incompatible, searchWindows: { old } }]]), job, { now });
  assert.equal(result.items[0].record, old); assert.equal(result.items[0].record.rawRatioSeries.length, 2);
  assert.equal(result.fetchCount, 0);
});
test("The pure policy performs no external calls and leaves cache and Job objects unchanged", () => {
  const value = record(), original = structuredClone(value), frozenJob = structuredClone(job);
  Object.freeze(job); Object.freeze(value.rawRatioSeries); Object.freeze(value);
  const prior = global.fetch; global.fetch = () => { throw new Error("External API forbidden"); };
  try { classify(value, {}, job, now); createPlan(["keyword"], new Map([["keyword", { search: value }]]), job, { now }); }
  finally { global.fetch = prior; }
  assert.deepEqual(value, original); assert.deepEqual(job, frozenJob);
});
