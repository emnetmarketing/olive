const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { withLambda } = require("@netlify/aws-lambda-compat");
const sdk = require("@netlify/blobs");
const compat = require("../netlify/functions/blob-store-compat");

const root = path.resolve(__dirname, "..");
const legacyDirectory = path.join(root, "netlify/functions");
const entriesDirectory = path.join(root, "netlify/entries");
const handlers = fs.readdirSync(legacyDirectory).filter(name => name.endsWith(".js")
  && /^exports\.handler\s*=/m.test(fs.readFileSync(path.join(legacyDirectory, name), "utf8")))
  .map(name => name.slice(0, -3)).sort();

test("every existing endpoint has one native entry and implementation helpers are not deployed as endpoints", () => {
  const names = fs.readdirSync(entriesDirectory).filter(name => name.endsWith(".mjs")).map(name => name.slice(0, -4)).sort();
  assert.deepEqual(names, handlers);
  assert.match(fs.readFileSync(path.join(root, "netlify.toml"), "utf8"), /functions\s*=\s*"netlify\/entries"/);
  for (const name of names) {
    const source = fs.readFileSync(path.join(entriesDirectory, `${name}.mjs`), "utf8");
    assert.match(source, /export default withLambda\(/);
    if (name.endsWith("-background")) assert.match(source, /statusCode: 204/);
    else assert.match(source, /export default withLambda\(legacy\.handler\)/);
    assert.ok(source.includes(`../functions/${name}.js`));
    assert.doesNotMatch(source, /connectLambda|setEnvironmentContext|fetch\s*\(|NETLIFY_BLOBS_API_TOKEN/);
  }
});

test("all official native adapters preserve each legacy route's JSON, query, auth headers and response without invoking business logic", async () => {
  const savedFetch = global.fetch;
  global.fetch = async () => { throw new Error("A native adapter test must not make network calls."); };
  try {
    for (const name of handlers) {
      const legacy = require(path.join(legacyDirectory, `${name}.js`));
      const original = legacy.handler;
      let received;
      legacy.handler = async (event, context) => {
        received = { event, context };
        return { statusCode: 202, headers: { "content-type": "application/json", "x-fixture": name },
          body: JSON.stringify({ name, body: JSON.parse(event.body) }) };
      };
      let native;
      try { native = await import(pathToFileURL(path.join(entriesDirectory, `${name}.mjs`)).href); }
      catch (error) { legacy.handler = original; throw error; }
      try {
      const response = await native.default(new Request(`https://fixture.invalid/.netlify/functions/${name}?jobId=fixture&mode=period`, {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-only", "x-fixture-user": "reader" },
        body: JSON.stringify({ jobId: "fixture", startDate: "2026-10-01", endDate: "2026-10-16" })
      }), { requestId: `request-${name}` });
      assert.equal(response.status, 202);
      assert.equal((await response.json()).name, name);
      assert.equal(response.headers.get("x-fixture"), name);
      assert.equal(received.event.headers.authorization, "Bearer fixture-only");
      assert.equal(received.event.queryStringParameters.jobId, "fixture");
      assert.equal(received.event.httpMethod, "POST");
      assert.equal(received.event.blobs, undefined, "Native runtime Blob context must not be replaced by legacy event configuration.");
      assert.equal(received.context.awsRequestId, `request-${name}`);
      if (name.endsWith("-background")) assert.equal(native.config.background, true);
      if (legacy.config?.schedule) assert.equal(native.config.schedule, legacy.config.schedule);
      if (name.endsWith("-background")) {
        // The entry intentionally calls the same module property for each
        // invocation, matching the original worker's void-return contract.
        legacy.handler = async () => undefined;
        try {
          const done = await native.default(new Request("https://fixture.invalid/background", { method: "POST" }), { requestId: "void" });
          assert.equal(done.status, 204);
          assert.equal(await done.text(), "");
          legacy.handler = async () => { throw new Error("fixture worker failure"); };
          await assert.rejects(native.default(new Request("https://fixture.invalid/background", { method: "POST" }), { requestId: "failure" }), /fixture worker failure/);
        } finally { legacy.handler = original; }
      }
      } finally { legacy.handler = original; }
    }
  } finally { global.fetch = savedFetch; }
});

test("native schedules retain the existing UTC registrations including 06:00 KST and 08:00 KST recovery", async () => {
  const expected = { "keyword-candidate-scheduled": "0 17 * * *", "market-discovery-scheduled": "0 */6 * * *",
    "trend-data-collection-scheduled": "0 21 * * *", "trend-data-collection-recovery-scheduled": "0 23 * * *" };
  const toml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");
  for (const [name, schedule] of Object.entries(expected)) {
    const native = await import(pathToFileURL(path.join(entriesDirectory, `${name}.mjs`)).href);
    assert.equal(native.config.schedule, schedule);
    assert.ok(toml.includes(`[functions."${name}"]\n  schedule = "${schedule}"`)
      || toml.includes(`[functions."${name}"]\r\n  schedule = "${schedule}"`));
  }
});

test("native runtime genuine Blob context supports actual SDK strong reads and conditional writes without a PAT or invented endpoint", async () => {
  const savedEnv = process.env.NETLIFY_BLOBS_CONTEXT;
  const savedGlobal = globalThis.netlifyBlobsContext;
  const savedApiToken = process.env.NETLIFY_BLOBS_API_TOKEN;
  const savedApiSite = process.env.NETLIFY_BLOBS_SITE_ID;
  delete globalThis.netlifyBlobsContext;
  delete process.env.NETLIFY_BLOBS_API_TOKEN;
  delete process.env.NETLIFY_BLOBS_SITE_ID;
  sdk.setEnvironmentContext({ siteID: "native-fixture", token: "runtime-edge-token", edgeURL: "https://edge.invalid",
    uncachedEdgeURL: "https://native-strong.invalid" });
  const initial = process.env.NETLIFY_BLOBS_CONTEXT;
  const requests = []; let value = { cursor: 4000 }; let etag = '"first"';
  const mockFetch = async (input, options = {}) => {
    const url = new URL(input); const headers = new Headers(options.headers);
    requests.push({ url, method: String(options.method || "GET").toUpperCase() });
    assert.equal(url.hostname, "native-strong.invalid");
    assert.equal(headers.get("authorization"), "Bearer runtime-edge-token");
    if (String(options.method).toUpperCase() === "PUT") {
      if (headers.get("if-match") !== etag) return new Response(null, { status: 412 });
      value = JSON.parse(options.body); etag = '"second"';
      return new Response(null, { status: 200, headers: { etag } });
    }
    return Response.json(value, { headers: { etag } });
  };
  const native = withLambda(async event => {
    compat.connectLambda(event);
    const store = compat.getCompatibleStore({ name: "isolated-fixture", consistency: "strong", fetch: mockFetch });
    const before = await store.getWithMetadata("checkpoint", { type: "json" });
    assert.equal((await store.setJSON("checkpoint", { cursor: 4100 }, { onlyIfMatch: before.etag })).modified, true);
    assert.equal((await store.setJSON("checkpoint", { cursor: 3900 }, { onlyIfMatch: before.etag })).modified, false);
    const after = await store.get("checkpoint", { type: "json" });
    return { statusCode: 200, body: JSON.stringify(after) };
  });
  try {
    const response = await native(new Request("https://fixture.invalid/probe"), { requestId: "native-fixture-request" });
    assert.deepEqual(await response.json(), { cursor: 4100 });
    assert.equal(process.env.NETLIFY_BLOBS_CONTEXT, initial);
    assert.equal(requests.length, 4);
  } finally {
    if (savedEnv === undefined) delete process.env.NETLIFY_BLOBS_CONTEXT; else process.env.NETLIFY_BLOBS_CONTEXT = savedEnv;
    if (savedGlobal === undefined) delete globalThis.netlifyBlobsContext; else globalThis.netlifyBlobsContext = savedGlobal;
    if (savedApiToken === undefined) delete process.env.NETLIFY_BLOBS_API_TOKEN; else process.env.NETLIFY_BLOBS_API_TOKEN = savedApiToken;
    if (savedApiSite === undefined) delete process.env.NETLIFY_BLOBS_SITE_ID; else process.env.NETLIFY_BLOBS_SITE_ID = savedApiSite;
  }
});

test("official wrapper preserves binary Excel responses and GET request semantics", async () => {
  const file = Buffer.from([0x50, 0x4b, 0, 255, 128, 1]);
  const native = withLambda(event => {
    assert.equal(event.httpMethod, "GET");
    assert.equal(event.body, null);
    assert.equal(event.queryStringParameters.action, "download");
    return { statusCode: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="fixture.xlsx"' }, body: file.toString("base64"), isBase64Encoded: true };
  });
  const response = await native(new Request("https://fixture.invalid/download-history?action=download"), { requestId: "excel-fixture" });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), file);
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="fixture.xlsx"');
});
