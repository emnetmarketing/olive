const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm");
const policy = require("../netlify/functions/instant-selection-policy");
const snapshots = require("../netlify/functions/signal-snapshot-cache");
const { stagePointer, visiblePointer } = require("../netlify/functions/instant-publication");
const excel = require("../netlify/functions/unified-excel");
const { extractFunction } = require("../scripts/verify-deployed-period-display.cjs");
const html = fs.readFileSync("index.html", "utf8");
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const job = (id, date, extra = {}) => ({ jobId: id, mode: "instant", state: "completed", latestDataDate: date,
  createdAt: "2026-10-27T00:00:00Z", completedAt: "2026-10-27T00:10:00Z", trendCoveragePct: 100,
  results: [{ keyword: id, latestDataDate: date }], ...extra });

test("Instant selection prioritizes observed date over late completion or newer creation", () => {
  const current = job("current", "2026-10-25");
  const oldRecovery = job("old-recovery", "2026-10-15", { createdAt: "2026-10-28T00:00:00Z", completedAt: "2026-10-28T01:00:00Z" });
  assert.equal(policy.selectCompletedInstant([oldRecovery, current]).jobId, "current");
  assert.equal(snapshots.shouldPromoteInstant(snapshots.buildSnapshot(oldRecovery), snapshots.buildSnapshot(current)), false);
});

test("requested target date alone never supplies a newer observation or a date coverage", () => {
  const old = job("target-only", "2026-10-15", { targetDataDate: "2026-10-26", sourceFreshness: { targetDataDate: "2026-10-26", targetDataCoveragePct: 0 } });
  const current = job("current", "2026-10-25", { targetDataDate: "2026-10-26" });
  assert.equal(policy.freshness(old).actualDataCoveragePct, null);
  assert.equal(policy.selectCompletedInstant([old, current]).jobId, "current");
});

test("same-date snapshots compare actual observation coverage before completion time", () => {
  const sufficient = job("sufficient", "2026-10-25", { sourceFreshness: { targetDataDate: "2026-10-25", targetDataCoveragePct: 90, validSeriesCount: 4900 } });
  const lower = job("lower", "2026-10-25", { completedAt: "2026-10-29T00:00:00Z", sourceFreshness: { targetDataDate: "2026-10-25", targetDataCoveragePct: 30, validSeriesCount: 4900 } });
  assert.equal(policy.selectCompletedInstant([lower, sufficient]).jobId, "sufficient");
  assert.equal(policy.canPromoteInstant(lower, sufficient), false);
});

test("invalid, empty-only, low-coverage and Period results cannot displace valid Instant", () => {
  const valid = job("valid", "2026-10-25");
  const values = [job("low", "2026-10-26", { trendCoveragePct: 0.36 }), job("period", "2026-10-26", { mode: "period" }),
    job("running", "2026-10-26", { state: "running" }), job("empty", "2026-10-26", { sourceFreshness: { validSeriesCount: 0 } }), valid];
  assert.equal(policy.selectCompletedInstant(values).jobId, "valid");
  assert.equal(policy.canPromoteInstant(job("drop", "2026-10-26", { trendCoveragePct: 20 }), valid), false);
  assert.equal(policy.canPromoteInstant(job("partial", "2026-10-26", { trendCoveragePct: 66.6 }), valid), true);
});

test("unknown historical observation coverage remains unknown instead of inventing zero", () => {
  const legacy = job("legacy", "2026-10-25");
  assert.equal(policy.freshness(legacy).actualDataCoveragePct, null);
  assert.equal(policy.freshness(legacy).targetDataCoveragePct, null);
  assert.equal(policy.isMeaningfulInstant(legacy), true);
});

function storeFixture() {
  const records = new Map(); let sequence = 0;
  return { async get(key) { return clone(records.get(key)?.data || null); }, async getWithMetadata(key) { return clone(records.get(key) || null); },
    async setJSON(key, value, options = {}) { const old = records.get(key);
      if (options.onlyIfNew && old || options.onlyIfMatch && options.onlyIfMatch !== old?.etag) return { modified: false };
      records.set(key, { data: clone(value), etag: String(++sequence) }); return { modified: true }; } };
}

test("date-based pointer CAS cannot publish a late old observation over a newer data day", async () => {
  const store = storeFixture(), current = job("current", "2026-10-25"), old = job("old", "2026-10-15", { createdAt: "2026-10-28T00:00:00Z" });
  await store.setJSON("latest-valid-v1/instant", { jobId: current.jobId, generation: Date.parse(current.createdAt) });
  const read = async id => id === current.jobId ? current : old;
  const result = await stagePointer(store, "latest-valid-v1/instant", { jobId: old.jobId, generation: Date.parse(old.createdAt) }, read,
    { preferDataFreshness: true, candidate: snapshots.buildSnapshot(old) });
  assert.equal(result.skippedOlderData, true);
  assert.equal((await visiblePointer(await store.get("latest-valid-v1/instant"), read)).jobId, current.jobId);
});

test("fresher published observations may supersede later-created old data, with visibility guarded until completed", async () => {
  const store = storeFixture(), old = job("old", "2026-10-15", { createdAt: "2026-10-28T00:00:00Z" });
  const current = job("current", "2026-10-25", { state: "publishing" });
  await store.setJSON("latest-valid-v1/instant", { jobId: old.jobId, generation: Date.parse(old.createdAt) });
  const read = async id => id === old.jobId ? old : current;
  await stagePointer(store, "latest-valid-v1/instant", { jobId: current.jobId, generation: Date.parse(current.createdAt) }, read,
    { preferDataFreshness: true, candidate: snapshots.buildSnapshot(current) });
  assert.equal((await visiblePointer(await store.get("latest-valid-v1/instant"), read)).jobId, old.jobId);
  current.state = "completed";
  assert.equal((await visiblePointer(await store.get("latest-valid-v1/instant"), read)).jobId, current.jobId);
});

function uiRuntime(responses = {}) {
  const requests = [], displayed = [], errors = [], nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, { innerHTML: "", textContent: "", style: {}, classList: { toggle() {} } }); return nodes.get(id); };
  const context = vm.createContext({ state: { currentAnalysisJob: { targetDataDate: "2026-10-26" } }, $, console,
    fetch: async route => { requests.push(route); assert.ok(Object.hasOwn(responses, route), "Unexpected request: " + route); return new Response(JSON.stringify(responses[route])); },
    displayCompletedAnalysis: value => displayed.push(value), showApiErrors: error => errors.push(error),
    marketConfidenceSummary: () => "confidence", surgeSignalSummary: () => "surge", sourceSummary: () => "sources", formatSurgeHistory: () => "history" });
  for (const name of ["escapeHtml", "instantRowDateSummary", "loadLastSuccessfulAnalysis", "renderTrendChart", "renderRatioOnlySignals", "renderLowIntensitySignals", "renderRelatedSignals"])
    vm.runInContext(extractFunction(html, name), context);
  return { context, $, requests, displayed, errors };
}

test("actual Instant UI loads the same latest-valid snapshot Job as Excel, never completedAt full/partial sorting", async () => {
  const current = job("published-current", "2026-10-25");
  const rt = uiRuntime({ "/.netlify/functions/signal-snapshot-latest?mode=instant": snapshots.buildSnapshot(current),
    "/.netlify/functions/trend-analysis-status?jobId=published-current": current });
  const selected = await rt.context.loadLastSuccessfulAnalysis("instant");
  assert.equal(selected.jobId, current.jobId); assert.equal(rt.displayed[0].jobId, current.jobId);
  assert.equal(rt.requests.length, 2); assert.equal(rt.errors.length, 0);
  assert.equal(rt.requests.some(route => route.includes("trend-analysis-latest")), false);
});

test("UI refuses mismatching snapshot/Job instead of showing a result from another generation", async () => {
  const current = job("current", "2026-10-25");
  const rt = uiRuntime({ "/.netlify/functions/signal-snapshot-latest?mode=instant": snapshots.buildSnapshot(current),
    "/.netlify/functions/trend-analysis-status?jobId=current": { ...current, jobId: "other" } });
  assert.equal(await rt.context.loadLastSuccessfulAnalysis("instant"), null);
  assert.equal(rt.displayed.length, 0); assert.equal(rt.errors.length, 1);
});

test("TOP10 and every detail type show individual observation dates without changing values/order", () => {
  const rt = uiRuntime(); const rows = [{ keyword: "old", latestDataDate: "2026-10-15", today: 500, yesterday: 100 },
    { keyword: "recent", latestDataDate: "2026-10-25", today: 300, yesterday: 100 }];
  const before = JSON.stringify(rows); rt.context.renderTrendChart(rows);
  const chart = rt.$("trendChart").innerHTML;
  assert.ok(chart.indexOf("old") < chart.indexOf("recent")); assert.match(chart, /NAVER 기준 2026-10-15/);
  assert.match(chart, /NAVER 기준 2026-10-25/); assert.match(chart, /목표일 이전 관측/);
  assert.equal(JSON.stringify(rows), before);
  rt.context.renderRatioOnlySignals(rows); assert.match(rt.$("ratioOnlySignalBody").innerHTML, /NAVER 기준 2026-10-15/);
  rt.context.renderLowIntensitySignals(rows); assert.match(rt.$("lowIntensitySignalBody").innerHTML, /NAVER 기준 2026-10-25/);
  rt.context.renderRelatedSignals("fixture", rows, "empty"); assert.match(rt.$("fixture").innerHTML, /NAVER 기준 2026-10-25/);
  assert.match(rt.context.instantRowDateSummary({}), /확인 불가/);
  assert.match(extractFunction(html, "render"), /instantRowDateSummary\(row\)/);
});

test("Excel keeps per-row NAVER dates and product observation time separate without adding to quantities", async () => {
  const current = job("instant", "2026-10-25", { targetDataDate: "2026-10-26", productCacheObservedAt: "2026-10-13T01:00:00Z",
    sourceFreshness: { targetDataDate: "2026-10-26", targetDataCoveragePct: 0 },
    results: [{ keyword: "old", latestDataDate: "2026-10-15", estimatedSurgeCount: 7031 }, { keyword: "recent", latestDataDate: "2026-10-25", estimatedSurgeCount: 310 }] });
  const before = JSON.stringify(current), workbook = await excel.buildWorkbook({ instantJob: current, early: { items: [] } });
  const sheet = workbook.getWorksheet("02_어제 급등 확인");
  assert.equal(sheet.getCell("B2").value.toISOString().slice(0, 10), "2026-10-15");
  assert.equal(sheet.getCell("B3").value.toISOString().slice(0, 10), "2026-10-25");
  assert.equal(sheet.getCell("C2").value, 7031);
  const summary = new Map(); workbook.getWorksheet("00_요약").eachRow(row => summary.set(row.getCell(1).value, row.getCell(2).value));
  assert.equal(summary.get("상품 매칭 cache 관측 시각").toISOString(), "2026-10-13T01:00:00.000Z");
  assert.equal(summary.get("목표일 관측 비율"), 0); assert.equal(JSON.stringify(current), before);
});

test("Excel projects unverifiable legacy Search Ad evidence without changing saved score or source rows", () => {
  const raw = { keyword: "legacy", todayEarlySignalScore: 70, reasons: ["Search Ad 노출 증가"],
    comparisons: { searchAd: { current: 50, previous: 0, delta: 50, firstSeen: "2026-10-16", lastSeen: "2026-10-16" } } };
  const before = JSON.stringify(raw), row = excel.earlyRow(raw);
  assert.equal(row.score, 70); assert.match(row.searchAdChange, /비교 불가/); assert.doesNotMatch(row.searchAdChange, /이전 0|Δ 50/);
  assert.match(row.reasons, /기존 저장 점수/); assert.equal(JSON.stringify(raw), before);
});
