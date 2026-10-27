const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ExcelJS = require("exceljs");
const sdk = require("@netlify/blobs");

const clone = value => JSON.parse(JSON.stringify(value));
const html = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");

// Exercise the installed SDK, including connectLambda(), serialization, HTTP
// routing, ETags and response parsing. Only the transport is mocked. Neither a
// real network request nor a Production download-history write is possible.
function fixtureRuntime(t) {
  const originalFetch = global.fetch;
  const originalContext = process.env.NETLIFY_BLOBS_CONTEXT;
  const originalGlobal = globalThis.netlifyBlobsContext;
  delete globalThis.netlifyBlobsContext;
  delete process.env.NETLIFY_BLOBS_CONTEXT;
  const records = new Map(); const requests = []; const writes = []; const modules = new Map();
  let revision = 0;
  const keyFor = (store, key) => `${store}/${key}`;
  const seed = (store, key, data) => records.set(keyFor(store, key), { bytes: Buffer.from(JSON.stringify(data)), etag: `"${++revision}"` });
  global.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    assert.equal(url.origin, "https://fixture-blobs.invalid", "unexpected network target is forbidden");
    const match = decodeURIComponent(url.pathname).match(/^\/fixture-site\/site:([^/]+)\/(.+)$/);
    assert.ok(match, `unexpected SDK route: ${url.pathname}`);
    const [, store, key] = match; const method = String(options.method || "GET").toUpperCase();
    requests.push({ store, key, method });
    const address = keyFor(store, key); const record = records.get(address);
    if (method === "GET" || method === "HEAD") {
      if (!record) return new Response(null, { status: 404 });
      return new Response(method === "HEAD" ? null : record.bytes, { status: 200, headers: { etag: record.etag } });
    }
    assert.equal(method, "PUT", "delete/other mutation is forbidden");
    assert.equal(store, "analysis-downloads", "only an in-memory workbook/history write is allowed");
    const bytes = typeof options.body === "string" ? Buffer.from(options.body) : Buffer.from(options.body);
    const etag = `"${++revision}"`; records.set(address, { bytes, etag }); writes.push({ store, key });
    return new Response(null, { status: 200, headers: { etag } });
  };
  t.after(() => {
    global.fetch = originalFetch;
    if (originalContext === undefined) delete process.env.NETLIFY_BLOBS_CONTEXT;
    else process.env.NETLIFY_BLOBS_CONTEXT = originalContext;
    if (originalGlobal === undefined) delete globalThis.netlifyBlobsContext;
    else globalThis.netlifyBlobsContext = originalGlobal;
  });
  function load(file) {
    const absolute = path.resolve(__dirname, "../netlify/functions", file);
    if (modules.has(absolute)) return modules.get(absolute).exports;
    const module = { exports: {} }; modules.set(absolute, module);
    const wrapper = vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${fs.readFileSync(absolute, "utf8")}\n})`, { filename: absolute });
    const localRequire = id => id.startsWith("./") ? load(id.endsWith(".js") ? id.slice(2) : `${id.slice(2)}.js`) : require(id);
    wrapper(localRequire, module, module.exports, absolute, path.dirname(absolute));
    return module.exports;
  }
  const event = (method, query = {}, body) => ({
    httpMethod: method, queryStringParameters: query, body: body === undefined ? null : JSON.stringify(body),
    // Legacy Lambda payload intentionally has NO uncachedEdgeURL. Installing a
    // mock getStore/connectLambda here would hide the real compatibility bug.
    blobs: Buffer.from(JSON.stringify({ url: "https://fixture-blobs.invalid", token: "fixture-only-token" })).toString("base64"),
    headers: { "x-nf-site-id": "fixture-site", "x-nf-deploy-id": "fixture-deploy" }
  });
  const invoke = (name, method = "GET", query = {}, body) => load(`${name}.js`).handler(event(method, query, body));
  return { records, requests, writes, seed, load, invoke, event };
}

function periodFixture(id = "period-fixture") {
  const results = Array.from({ length: 365 }, (_, i) => ({
    keyword: `기간-${String(365 - i).padStart(3, "0")}`, resultType: "product_match",
    estimatedSurgeCount: 7031 - i, peakRelativeLiftPct: 420 - i / 10, latestDataDate: "2026-10-14",
    periodMarketConfidenceScore: 66, periodMarketConfidenceGrade: "medium",
    periodMarketConfidenceReasons: ["NAVER 기간 상승 확인", "저장된 상품 직접 매칭"],
    match: { score: 87, item: { product: "fixture product", brand: "fixture brand" } },
    periodMarketEvidence: { dataAvailability: "no_data", dataGaps: ["기간 보조 데이터 없음"],
      youtube: { availability: "no_data", current: null, previous: null, delta: null },
      searchAd: { availability: "no_data", newQuery: null, delta: null, clickDelta: null } }
  }));
  return { jobId: id, mode: "period", state: "completed", createdAt: "2026-10-16T05:22:24.238Z",
    completedAt: "2026-10-16T06:10:00.000Z", updatedAt: "2026-10-16T06:10:00.000Z", currentStage: "completed",
    startDate: "2026-10-01", endDate: "2026-10-16", queryStartDate: "2026-09-16",
    latestDataDate: "2026-10-14", partialAnalysis: false, trendCoveragePct: 100,
    trendAvailableCount: 5000, analyzedCandidateCount: 5000, surgeThreshold: 300, matchThreshold: 40,
    resultCount: results.length, results };
}

function seedFixtures(runtime, format) {
  const period = periodFixture();
  const instant = { ...periodFixture("instant-fixture"), mode: "instant", results: [{ keyword: "instant-only", resultType: "product_match" }], resultCount: 1 };
  const snapshots = runtime.load("signal-snapshot-cache.js");
  runtime.seed("trend-analysis", `jobs/${instant.jobId}`, instant);
  runtime.seed("trend-analysis", "last-success/instant", { jobId: instant.jobId });
  runtime.seed("trend-signal-snapshots", "latest-valid-v1/instant", { jobId: instant.jobId });
  runtime.seed("trend-signal-snapshots", `snapshots/${instant.jobId}`, snapshots.buildSnapshot(instant));
  runtime.seed("today-early-signals", "current-v1", { version: 1, items: [{ keyword: "today-only" }], history: [] });
  if (format === "legacy") {
    runtime.seed("trend-analysis", `jobs/${period.jobId}`, period);
    runtime.seed("trend-analysis", "last-success/period", { jobId: period.jobId });
    runtime.seed("trend-signal-snapshots", "latest-valid-v1/period", { jobId: period.jobId });
    const snapshot = snapshots.buildSnapshot(period); delete snapshot.createdAt;
    runtime.seed("trend-signal-snapshots", `snapshots/${period.jobId}`, snapshot);
  } else {
    const publication = runtime.load("period-publication.js");
    const body = clone({ ...period, state: "calculated", currentStage: "publishing", publicationState: "prepared" });
    const snapshot = clone(snapshots.buildSnapshot(period));
    const commit = { version: 1, jobId: period.jobId, mode: "period", state: "published", partialAnalysis: false,
      generation: Date.parse(period.createdAt), publishedAt: period.completedAt,
      bodyKey: "prepared/fixture/body", snapshotKey: "prepared/fixture/snapshot",
      bodyHash: publication.digest(body), snapshotHash: publication.digest(snapshot),
      startDate: period.startDate, endDate: period.endDate, queryStartDate: period.queryStartDate };
    runtime.seed("trend-analysis", `jobs/${period.jobId}`, { ...period, state: "interrupted", results: [] });
    runtime.seed("trend-period-publications", commit.bodyKey, body);
    runtime.seed("trend-period-publications", commit.snapshotKey, snapshot);
    runtime.seed("trend-period-publications", "latest-v1", commit);
    runtime.seed("trend-period-publications", publication.receiptKey(period.jobId), commit);
  }
  return { period, instant };
}

function uiFunction(name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, "m").exec(html);
  assert.ok(start, `missing real UI function ${name}`);
  const rest = html.slice(start.index); const next = /\n    (?:async )?function \w+\(/.exec(rest);
  assert.ok(next, `missing boundary for UI function ${name}`);
  return rest.slice(0, next.index);
}

function uiRuntime(runtime, fixtures) {
  const nodes = new Map(); const apiRequests = []; const downloads = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: "", innerHTML: "", textContent: "", classList: { toggle() {} } });
    return nodes.get(id);
  };
  node("collectionStart").value = fixtures.period.startDate; node("collectionEnd").value = fixtures.period.endDate;
  const context = vm.createContext({
    state: { currentAnalysisJob: fixtures.instant, currentPeriodAnalysisJob: null, periodResultQuery: "", marketDiscoveryRows: [] },
    $: node, escapeHtml: value => String(value ?? ""), formatHistoryDate: value => value,
    surgeSignalSummary: () => "", periodSourceEvidence: source => source?.availability === "no_data" ? "데이터 없음" : "기간 근거",
    periodDataStatus: evidence => (evidence?.dataGaps || []).join(" / "),
    log() {}, showApiErrors(errors) { throw new Error(JSON.stringify(errors)); }, alert(message) { throw new Error(message); },
    triggerXlsxDownload(filename, contentBase64) { downloads.push({ filename, contentBase64 }); },
    async renderDownloadHistoryShared() {},
    async fetch(route, options = {}) {
      const url = new URL(route, "https://fixture-ui.invalid");
      assert.equal(url.origin, "https://fixture-ui.invalid");
      const name = url.pathname.split("/").at(-1);
      assert.ok(["trend-analysis-latest", "download-history"].includes(name), `unexpected UI fetch ${name}`);
      const body = options.body ? JSON.parse(options.body) : undefined;
      apiRequests.push({ name, body });
      const response = await runtime.invoke(name, options.method || "GET", Object.fromEntries(url.searchParams), body);
      return new Response(response.body, { status: response.statusCode, headers: response.headers });
    }
  });
  for (const name of ["storedInstantConfidenceDisplay", "storedPeriodConfidenceDisplay", "periodSelectionMatchesJob", "periodConfidenceSummary", "periodRelationSummary", "periodResultRow",
    "renderPeriodResultTables", "refreshPeriodSelectionDisplay", "displayPeriodAnalysis", "loadLastSuccessfulAnalysis", "downloadExcelShared"])
    vm.runInContext(uiFunction(name), context);
  context.displayCompletedAnalysis = (job, options) => context.displayPeriodAnalysis(job, options);
  return { context, nodes, node, apiRequests, downloads };
}

for (const format of ["legacy", "canonical"]) {
  test(`real SDK legacy Lambda: ${format} Period API, dashboard and Excel share identical Job and rows`, async t => {
    const runtime = fixtureRuntime(t); const fixtures = seedFixtures(runtime, format);
    // Prove that this is the real SDK context setup, without a supplied strong
    // endpoint, rather than the no-op connectLambda used by older unit tests.
    sdk.connectLambda(runtime.event("GET"));
    const context = JSON.parse(Buffer.from(process.env.NETLIFY_BLOBS_CONTEXT, "base64").toString());
    assert.equal(context.uncachedEdgeURL, undefined);
    assert.equal(require("@netlify/blobs/package.json").version, "10.7.12");
    const status = await runtime.invoke("trend-analysis-status", "GET", { jobId: fixtures.period.jobId });
    assert.equal(status.statusCode, 200); const exact = JSON.parse(status.body);
    const snapshotResponse = await runtime.invoke("signal-snapshot-latest", "GET", { mode: "period" });
    assert.equal(snapshotResponse.statusCode, 200); const snapshot = JSON.parse(snapshotResponse.body);
    const digest = runtime.load("period-publication.js").digest;
    assert.equal(exact.state, "completed"); assert.equal(exact.jobId, snapshot.jobId);
    assert.equal(exact.queryStartDate, fixtures.period.queryStartDate);
    assert.equal(digest(exact.results), digest(fixtures.period.results));
    assert.deepEqual(snapshot.items.map(row => row.keyword), exact.results.map(row => row.keyword));
    assert.equal(runtime.writes.length, 0, "all result API reads must remain read-only");
    const ui = uiRuntime(runtime, fixtures);
    const loaded = await ui.context.loadLastSuccessfulAnalysis("period");
    assert.equal(loaded.jobId, exact.jobId);
    assert.equal(digest(ui.context.state.currentPeriodAnalysisJob.results), digest(exact.results));
    assert.match(ui.node("periodAnalysisMeta").textContent, /365건/);
    assert.equal((ui.node("periodAnalysisTopBody").innerHTML.match(/data-period-keyword=/g) || []).length, 10);
    assert.equal((ui.node("periodAnalysisBody").innerHTML.match(/data-period-keyword=/g) || []).length, 365);
    assert.match(ui.node("periodAnalysisBody").innerHTML, /데이터 없음/);
    const renderedKeywords = [...ui.node("periodAnalysisBody").innerHTML.matchAll(/data-period-keyword="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(renderedKeywords, exact.results.map(row => row.keyword));
    await ui.context.downloadExcelShared();
    const request = ui.apiRequests.find(item => item.name === "download-history");
    assert.equal(request.body.periodJobId, exact.jobId);
    assert.equal(ui.downloads.length, 1);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(ui.downloads[0].contentBase64, "base64"));
    const sheet = workbook.getWorksheet("07_선택기간분석");
    assert.equal(sheet.rowCount - 11, exact.results.length);
    const excelRows = exact.results.map((row, i) => ({ keyword: sheet.getCell(i + 12, 3).value,
      surge: sheet.getCell(i + 12, 4).value, rise: sheet.getCell(i + 12, 5).value,
      confidence: sheet.getCell(i + 12, 6).value, grade: sheet.getCell(i + 12, 7).value }));
    assert.equal(digest(excelRows), digest(exact.results.map(row => ({ keyword: row.keyword, surge: row.estimatedSurgeCount,
      rise: row.peakRelativeLiftPct / 100, confidence: row.periodMarketConfidenceScore, grade: "보통" }))));
    const summaryRows = []; workbook.getWorksheet("00_요약").eachRow(row => summaryRows.push(row.values));
    assert.ok(summaryRows.some(row => row[1] === "선택 기간 결과 건수" && row[2] === 365));
    const history = JSON.parse(runtime.records.get("analysis-downloads/shared-history/v1").bytes.toString());
    assert.equal(history.items[0].periodJobId, exact.jobId);
    assert.equal(ui.context.state.currentAnalysisJob.jobId, fixtures.instant.jobId);
    assert.ok(runtime.requests.length > 0);
    assert.ok(runtime.writes.every(write => write.store === "analysis-downloads"));
  });
}

test("changed selected dates hide old Period rows and cannot export them as the new period", async t => {
  const runtime = fixtureRuntime(t); const fixtures = seedFixtures(runtime, "canonical");
  const ui = uiRuntime(runtime, fixtures);
  await ui.context.loadLastSuccessfulAnalysis("period");
  ui.node("collectionStart").value = "2026-09-01";
  ui.context.refreshPeriodSelectionDisplay();
  assert.equal((ui.node("periodAnalysisBody").innerHTML.match(/data-period-keyword=/g) || []).length, 0);
  assert.match(ui.node("periodAnalysisMeta").textContent, /일치하는 분석 결과가 없습니다/);
  await ui.context.downloadExcelShared();
  assert.equal(ui.apiRequests.find(item => item.name === "download-history").body.periodJobId, null);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(ui.downloads[0].contentBase64, "base64"));
  assert.equal(workbook.getWorksheet("07_선택기간분석").getCell("A12").value, "분석 결과 없음");
  const history = JSON.parse(runtime.records.get("analysis-downloads/shared-history/v1").bytes.toString());
  assert.equal(history.items[0].periodJobId, null);
  assert.equal(history.items[0].periodStatus, "not_analyzed");
});
