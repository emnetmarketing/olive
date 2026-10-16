const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const sdk = require("@netlify/blobs");
const ExcelJS = require("exceljs");
const probe = require("../netlify/functions/runtime-storage-verification")._test;
const runId = "2d065892-35dd-491e-a59c-af96d8a98d78";
const token = "fixture-runtime-authorization-not-a-real-secret";
const timestamp = Date.parse("2026-10-16T12:00:00Z");
const encoded = value => Buffer.from(JSON.stringify(value)).toString("base64");

// Real SDK10.7.12 HTTP/ETag/CAS behavior, fake transport only. No test can
// address another store or write an operator authorization record over HTTP.
function runtime(t, overrides = {}) {
  const beforeFetch = global.fetch, beforeContext = process.env.NETLIFY_BLOBS_CONTEXT,
    beforeGlobal = globalThis.netlifyBlobsContext, beforeToken = process.env.NETLIFY_BLOBS_API_TOKEN;
  delete globalThis.netlifyBlobsContext; delete process.env.NETLIFY_BLOBS_API_TOKEN;
  const records = new Map(), requests = [], queue = []; let revision = 0;
  function seed(key, value) { records.set(key, { bytes: JSON.stringify(value), etag: `"${++revision}"` }); }
  seed(`authorization/${runId}`, { tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(timestamp + 60000).toISOString(), jobId: `runtime-fixture-${runId}` });
  global.fetch = async (input, options = {}) => {
    const url = new URL(input); assert.ok(["edge-fixture.invalid", "strong-fixture.invalid"].includes(url.hostname), "all real network forbidden");
    const route = decodeURIComponent(url.pathname).match(/^\/probe-site\/site:([^/]+)\/(.+)$/);
    assert.ok(route); assert.equal(route[1], probe.STORE_NAME);
    const key = route[2], method = String(options.method || "GET").toUpperCase(), headers = new Headers(options.headers);
    requests.push({ key, method, host: url.hostname }); const previous = records.get(key);
    if (["GET", "HEAD"].includes(method)) return new Response(previous && method !== "HEAD" ? previous.bytes : null,
      { status: previous ? 200 : 404, headers: previous ? { etag: previous.etag } : {} });
    assert.equal(method, "PUT"); assert.ok(key.startsWith(`runs/${runId}/`), "writes must remain isolated");
    if (headers.get("if-none-match") === "*" && previous || headers.has("if-match") && headers.get("if-match") !== previous?.etag)
      return new Response(null, { status: 412 });
    const bytes = String(options.body); assert.equal(bytes.includes(token), false, "authorization token must never be persisted");
    const etag = `"${++revision}"`; records.set(key, { bytes, etag });
    return new Response(null, { status: 200, headers: { etag } });
  };
  function context(strong = true) {
    sdk.setEnvironmentContext({ siteID: "probe-site", token: "fixture-edge-credentials", edgeURL: "https://edge-fixture.invalid",
      ...(strong ? { uncachedEdgeURL: "https://strong-fixture.invalid" } : {}) });
  }
  context();
  const handlers = probe.createHandlers({ now: () => timestamp, dispatch: async input => { queue.push(input); return 202; }, ...overrides });
  const event = (method = "GET", body = null, query = {}) => ({ httpMethod: method, body: body && JSON.stringify(body),
    queryStringParameters: { runId, ...query }, blobs: encoded({ url: "https://edge-fixture.invalid", token: "fixture-edge-credentials" }),
    headers: { authorization: `Bearer ${token}`, "x-nf-site-id": "probe-site", "x-nf-deploy-id": "probe-deploy" } });
  async function next() {
    const value = queue.shift(); assert.ok(value, "continuation must have been dispatched"); context();
    const request = event("POST", { runId: value.runId, phase: value.phase });
    if (value.phase === 2) delete request.blobs; // Native background runtime has no legacy event.blobs.
    const result = await handlers.backgroundHandler(request, { awsRequestId: `fixture-request-${value.phase}` });
    assert.equal(result.statusCode, 200, result.body); return JSON.parse(result.body);
  }
  t.after(() => {
    global.fetch = beforeFetch;
    for (const [name, value] of [["NETLIFY_BLOBS_CONTEXT", beforeContext], ["NETLIFY_BLOBS_API_TOKEN", beforeToken]])
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    if (beforeGlobal === undefined) delete globalThis.netlifyBlobsContext; else globalThis.netlifyBlobsContext = beforeGlobal;
  });
  return { handlers, event, context, next, queue, requests, records, seed };
}

test("isolated runtime probe chains two fresh invocations and verifies real SDK checkpoint/publication/Excel", async t => {
  const r = runtime(t);
  const start = await r.handlers.handler(r.event("POST", { runId }));
  assert.equal(start.statusCode, 202, `${start.body} ${JSON.stringify(r.requests)}`); assert.equal(r.queue.length, 1);
  const duplicate = await r.handlers.handler(r.event("POST", { runId }));
  assert.equal(JSON.parse(duplicate.body).existing, true); assert.equal(r.queue.length, 1);
  const first = await r.next(); assert.equal(first.cursor, 1); assert.equal(first.status, "ready");
  assert.equal(r.queue.length, 1);
  const duplicatePhase = await r.handlers.backgroundHandler(r.event("POST", { runId, phase: 1 }));
  assert.equal(JSON.parse(duplicatePhase.body).cursor, 1); assert.equal(r.queue.length, 1);
  const final = await r.next(); assert.equal(final.status, "completed"); assert.equal(final.cursor, 2);
  assert.equal(final.invocations.length, 2); assert.notEqual(final.invocations[0].invocationId, final.invocations[1].invocationId);
  assert.deepEqual(final.invocations.map(row => row.resumedCursor), [0, 1]);
  assert.deepEqual(final.invocations.map(row => row.platformRequestId), ["fixture-request-1", "fixture-request-2"]);
  assert.ok(final.invocations.every(row => row.requestIdSource === "runtime"));
  assert.ok(final.invocations.every(row => row.nativeStrongEndpointPresent && row.sdkVersion === "10.7.12"));
  const report = final.report;
  for (const key of ["duplicateBlocked", "staleBlocked", "publicationFailureProtected", "publicationRetrySucceeded",
    "normalWorkerClaimVerified", "normalWorkerFrozenInputsVerified", "normalWorkerCheckpointResumeVerified",
    "instantPublicationVerified", "instantPreviousProtected", "instantSnapshotFailureProtected", "instantLastPointerFailureProtected"]) assert.equal(report[key], true);
  assert.equal(report.resultCount, 2); assert.equal(report.excelResultCount, 2);
  assert.equal(report.latestReaderJobId, report.exactReaderJobId); assert.equal(report.excelPeriodJobId, report.exactReaderJobId);
  const exported = await r.handlers.handler(r.event("GET", null, { export: "1" }));
  assert.equal(exported.statusCode, 200); assert.equal(exported.isBase64Encoded, true);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(exported.body, "base64"));
  assert.equal(workbook.getWorksheet("07_선택기간분석").getCell(8, 2).value, 2);
  assert.deepEqual([12, 13].map(row => workbook.getWorksheet("07_선택기간분석").getCell(row, 3).value), ["runtime-fixture-A", "runtime-fixture-B"]);
  assert.ok(r.requests.filter(row => row.method === "PUT").every(row => row.key.startsWith(`runs/${runId}/`)));
  assert.ok(r.requests.filter(row => !row.key.startsWith("authorization/")).every(row => row.host === "strong-fixture.invalid"));
  const writes = r.requests.filter(row => row.method === "PUT").length;
  const replay = await r.handlers.backgroundHandler(r.event("POST", { runId, phase: 2 }));
  assert.equal(JSON.parse(replay.body).status, "completed");
  assert.equal(r.requests.filter(row => row.method === "PUT").length, writes);
});

test("probe rejects unknown, expired or wrong authorization without fixture writes or invocation", async t => {
  const r = runtime(t);
  const bad = r.event("POST", { runId }); bad.headers.authorization = `Bearer ${"x".repeat(40)}`;
  assert.equal((await r.handlers.handler(bad)).statusCode, 403);
  r.seed(`authorization/${runId}`, { tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(timestamp - 1).toISOString(), jobId: `runtime-fixture-${runId}` });
  assert.equal((await r.handlers.handler(r.event("POST", { runId }))).statusCode, 403);
  assert.equal(r.requests.filter(row => row.method === "PUT").length, 0); assert.equal(r.queue.length, 0);
});

test("probe dispatch failure is explicit and cannot silently start a business Job", async t => {
  const r = runtime(t, { dispatch: async () => 503 });
  const result = await r.handlers.handler(r.event("POST", { runId }));
  assert.equal(result.statusCode, 503); assert.equal(JSON.parse(result.body).code, "PROBE_DISPATCH_REJECTED");
  const state = JSON.parse((await r.handlers.handler(r.event())).body);
  assert.equal(state.failure.code, "PROBE_DISPATCH_REJECTED"); assert.equal(state.failure.resumable, true);
  assert.equal(state.cursor, 0); assert.equal(state.businessStoreWrites, 0);
});

test("probe scope adapter rejects arbitrary absolute or traversal keys", () => {
  const adapter = probe.scopedStore({}, `runs/${runId}/`);
  for (const key of ["../trend-analysis/latest", "/latest", "a\\b", ""]) assert.throws(() => adapter.get(key), { code: "PROBE_SCOPE_VIOLATION" });
});

test("probe fails closed without a genuine strong runtime transport before fixture writes", async t => {
  const r = runtime(t);
  sdk.setEnvironmentContext({ siteID: "probe-site", token: "different-cold-context", edgeURL: "https://edge-fixture.invalid" });
  const request = r.event("POST", { runId });
  request.blobs = encoded({ url: "https://edge-fixture.invalid", token: "different-cold-context" });
  const result = await r.handlers.handler(request);
  assert.equal(result.statusCode, 503); assert.equal(JSON.parse(result.body).code, "BLOBS_STRONG_TRANSPORT_UNAVAILABLE");
  assert.equal(r.requests.filter(row => row.method === "PUT").length, 0); assert.equal(r.queue.length, 0);
});
