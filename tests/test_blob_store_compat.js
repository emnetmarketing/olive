const test = require("node:test");
const assert = require("node:assert/strict");
const sdk = require("@netlify/blobs");
let compat = require("../netlify/functions/blob-store-compat");

const encoded = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
function isolated(fn) {
  return async () => {
    const env = process.env.NETLIFY_BLOBS_CONTEXT; const globalContext = globalThis.netlifyBlobsContext;
    const apiToken = process.env.NETLIFY_BLOBS_API_TOKEN; const apiSite = process.env.NETLIFY_BLOBS_SITE_ID;
    delete globalThis.netlifyBlobsContext; delete process.env.NETLIFY_BLOBS_CONTEXT;
    delete process.env.NETLIFY_BLOBS_API_TOKEN; delete process.env.NETLIFY_BLOBS_SITE_ID;
    delete require.cache[require.resolve("../netlify/functions/blob-store-compat")];
    compat = require("../netlify/functions/blob-store-compat");
    try { await fn(); }
    finally {
      if (env === undefined) delete process.env.NETLIFY_BLOBS_CONTEXT; else process.env.NETLIFY_BLOBS_CONTEXT = env;
      if (globalContext === undefined) delete globalThis.netlifyBlobsContext; else globalThis.netlifyBlobsContext = globalContext;
      if (apiToken === undefined) delete process.env.NETLIFY_BLOBS_API_TOKEN; else process.env.NETLIFY_BLOBS_API_TOKEN = apiToken;
      if (apiSite === undefined) delete process.env.NETLIFY_BLOBS_SITE_ID; else process.env.NETLIFY_BLOBS_SITE_ID = apiSite;
    }
  };
}
function event(siteID = "fixture-site", token = "fixture-edge-token") {
  return { blobs: encoded({ url: "https://edge.invalid", token }),
    headers: { "x-nf-site-id": siteID, "x-nf-deploy-id": "fixture-deploy" } };
}
function transport() {
  const requests = []; let value = { cursor: 4000 }; let etag = '"etag-1"'; let revision = 1;
  const fetch = async (input, options = {}) => {
    const url = new URL(input); const method = String(options.method || "GET").toUpperCase();
    const headers = new Headers(options.headers); requests.push({ url, method, headers });
    if (url.hostname === "api.invalid" && method !== "HEAD")
      return Response.json({ url: "https://origin.invalid/blob" });
    if (method === "GET" || method === "HEAD") return new Response(method === "HEAD" ? null : JSON.stringify(value),
      { status: 200, headers: { etag, "content-type": "application/json" } });
    if (method === "PUT") {
      if (headers.get("if-none-match") === "*" || headers.has("if-match") && headers.get("if-match") !== etag)
        return new Response(null, { status: 412 });
      value = JSON.parse(options.body); etag = `"etag-${++revision}"`;
      return new Response(null, { status: 200, headers: { etag } });
    }
    throw new Error("Unexpected fixture request");
  };
  return { fetch, requests };
}

test("installed SDK reproduces Lambda strong-context failure without any network request", isolated(async () => {
  sdk.connectLambda(event()); const fake = transport();
  const store = sdk.getStore({ name: "fixture", consistency: "strong", fetch: fake.fetch });
  await assert.rejects(store.get("checkpoint", { type: "json" }), { name: "BlobsConsistencyError" });
  assert.equal(fake.requests.length, 0);
}));

test("compatibility helper does not downgrade strong reads or reuse edge token as API credentials", isolated(async () => {
  compat.connectLambda(event()); const fake = transport();
  assert.throws(() => compat.getStore({ name: "fixture", consistency: "strong", fetch: fake.fetch }),
    { code: "BLOBS_STRONG_TRANSPORT_UNAVAILABLE" });
  assert.equal(fake.requests.length, 0);
  assert.equal(compat.readEnvironmentContext().uncachedEdgeURL, undefined);
}));

test("a genuine runtime uncached endpoint remains the strong route through the actual SDK", isolated(async () => {
  sdk.setEnvironmentContext({ siteID: "fixture-site", token: "fixture-edge-token", edgeURL: "https://edge.invalid",
    uncachedEdgeURL: "https://strong.invalid" });
  compat.connectLambda(event()); const fake = transport();
  const store = compat.getStore({ name: "fixture", consistency: "strong", fetch: fake.fetch });
  assert.equal((await store.get("checkpoint", { type: "json" })).cursor, 4000);
  assert.equal(fake.requests.length, 1); assert.equal(fake.requests[0].url.hostname, "strong.invalid");
}));

test("native endpoint is never copied across a different site or authentication context", isolated(async () => {
  sdk.setEnvironmentContext({ siteID: "other-site", token: "other-token", edgeURL: "https://edge.invalid", uncachedEdgeURL: "https://strong.invalid" });
  compat.connectLambda(event());
  assert.equal(compat.readEnvironmentContext().uncachedEdgeURL, undefined);
  assert.throws(() => compat.getStore({ name: "fixture", consistency: "strong" }), { code: "BLOBS_STRONG_TRANSPORT_UNAVAILABLE" });
}));

test("later legacy connectLambda calls cannot erase a genuine endpoint already observed for the same site and token", isolated(async () => {
  sdk.setEnvironmentContext({ siteID: "fixture-site", token: "fixture-edge-token", edgeURL: "https://edge.invalid",
    uncachedEdgeURL: "https://strong.invalid" });
  const fake = transport();
  compat.getCompatibleStore({ name: "first", consistency: "strong", fetch: fake.fetch });
  sdk.connectLambda(event()); assert.equal(compat.readEnvironmentContext().uncachedEdgeURL, undefined);
  const next = compat.getCompatibleStore({ name: "next", consistency: "strong", fetch: fake.fetch });
  assert.equal((await next.get("key", { type: "json" })).cursor, 4000);
  assert.equal(fake.requests[0].url.hostname, "strong.invalid");
  sdk.connectLambda(event("fixture-site", "rotated-token"));
  assert.throws(() => compat.getCompatibleStore({ name: "next", consistency: "strong", fetch: fake.fetch }),
    { code: "BLOBS_STRONG_TRANSPORT_UNAVAILABLE" });
}));

test("dedicated API environment configuration uses runtime site without CLI credentials or invented endpoints", isolated(async () => {
  compat.connectLambda(event()); process.env.NETLIFY_BLOBS_API_TOKEN = "explicit-configured-api-token";
  const requests = [];
  const fetch = async (input, options = {}) => {
    const url = new URL(input); requests.push({ url, headers: new Headers(options.headers) });
    if (url.hostname === "api.netlify.com") return Response.json({ url: "https://origin.invalid/blob" });
    assert.equal(url.hostname, "origin.invalid"); return Response.json({ cursor: 4000 });
  };
  const store = compat.getCompatibleStore({ name: "fixture", consistency: "strong", fetch });
  assert.equal((await store.get("key", { type: "json" })).cursor, 4000);
  assert.ok(requests[0].url.pathname.includes("fixture-site"));
  assert.equal(requests[0].headers.get("authorization"), "Bearer explicit-configured-api-token");
  process.env.NETLIFY_BLOBS_SITE_ID = "different-site";
  assert.throws(() => compat.getCompatibleStore({ name: "fixture", consistency: "strong", fetch }),
    { code: "BLOBS_API_SITE_MISMATCH" });
}));

test("supported explicit API fallback uses origin access and preserves real SDK ETag CAS", isolated(async () => {
  compat.connectLambda(event()); const fake = transport();
  const store = compat.getStore({ name: "fixture", consistency: "strong", fetch: fake.fetch,
    apiAccess: { siteID: "fixture-site", token: "fixture-api-token", apiURL: "https://api.invalid" } });
  const original = await store.getWithMetadata("checkpoint", { type: "json" });
  assert.equal(original.data.cursor, 4000);
  const success = await store.setJSON("checkpoint", { cursor: 4100 }, { onlyIfMatch: original.etag });
  assert.equal(success.modified, true);
  const stale = await store.setJSON("checkpoint", { cursor: 3900 }, { onlyIfMatch: original.etag });
  assert.equal(stale.modified, false);
  const duplicate = await store.setJSON("checkpoint", { cursor: 0 }, { onlyIfNew: true });
  assert.equal(duplicate.modified, false);
  assert.equal((await store.get("checkpoint", { type: "json" })).cursor, 4100);
  assert.ok(fake.requests.every((request) => ["api.invalid", "origin.invalid"].includes(request.url.hostname)));
  assert.ok(fake.requests.filter((request) => request.url.hostname === "api.invalid")
    .every((request) => request.headers.get("authorization") === "Bearer fixture-api-token"));
  assert.ok(fake.requests.filter((request) => request.url.hostname === "origin.invalid")
    .every((request) => !request.headers.has("authorization")));
}));

test("explicit API credentials bypass unrelated inherited Lambda edge context using public SDK configuration", isolated(async () => {
  sdk.connectLambda(event()); const fake = transport();
  const store = compat.getStore({ name: "fixture", consistency: "strong", siteID: "operator-site",
    token: "operator-api-token", apiURL: "https://api.invalid", fetch: fake.fetch });
  assert.equal((await store.getWithMetadata("key", { type: "json" })).data.cursor, 4000);
  assert.ok(fake.requests[0].url.pathname.includes("operator-site"));
  assert.equal(fake.requests[0].headers.get("authorization"), "Bearer operator-api-token");
}));

test("explicit API configuration also works without a Lambda environment context", isolated(async () => {
  const fake = transport();
  const store = compat.getCompatibleStore({ name: "fixture", consistency: "strong", fetch: fake.fetch,
    apiAccess: { siteID: "fixture-site", token: "fixture-api-token", apiURL: "https://api.invalid" } });
  assert.equal((await store.getWithMetadata("key", { type: "json" })).data.cursor, 4000);
  assert.equal(fake.requests[0].url.hostname, "api.invalid");
  assert.equal(fake.requests[0].headers.get("authorization"), "Bearer fixture-api-token");
}));

test("individual strong reads follow the same compatibility policy while normal reads retain their chosen consistency", isolated(async () => {
  compat.connectLambda(event()); const fake = transport();
  const store = compat.getStore("fixture", { fetch: fake.fetch,
    apiAccess: { siteID: "fixture-site", token: "fixture-api-token", apiURL: "https://api.invalid" } });
  await store.get("key", { type: "json" }); assert.equal(fake.requests[0].url.hostname, "edge.invalid");
  await store.getMetadata("key", { consistency: "strong" }); assert.equal(fake.requests.at(-1).url.hostname, "api.invalid");
  await store.getWithMetadata("key", { consistency: "strong", type: "json" }); assert.equal(fake.requests.at(-1).url.hostname, "origin.invalid");
  const noFallback = compat.getStore("fixture", { fetch: fake.fetch });
  assert.throws(() => noFallback.get("key", { type: "json", consistency: "strong" }), { code: "BLOBS_STRONG_TRANSPORT_UNAVAILABLE" });
}));

test("API fallback configuration is fail closed on missing token, different site or invented edge transport", isolated(async () => {
  compat.connectLambda(event());
  for (const apiAccess of [{ siteID: "fixture-site" }, { siteID: "other-site", token: "fixture" },
    { siteID: "fixture-site", token: "fixture", edgeURL: "https://edge.invalid" }]) {
    assert.throws(() => compat.getStore({ name: "fixture", consistency: "strong", apiAccess }),
      (error) => ["BLOBS_API_CONFIGURATION_INVALID", "BLOBS_API_SITE_MISMATCH"].includes(error.code));
  }
}));
