const test = require("node:test");
const assert = require("node:assert/strict");
const { client, parseArgs, makePlan, ensureCandidate, needsManifestUpload, verifyRemote } = require("../scripts/deploy-verified-functions.cjs");

const siteId = "dc4e873a-5b98-40de-a2f8-9c36e9f7e8bc";
const healthy = "6a9a6ee0f88f8300080bc18f";
const candidate = "6ad1da1688cfe007b433ef2b";
const commit = "a".repeat(40);
const schedules = [
  { name: "keyword-candidate-scheduled", cron: "0 17 * * *" },
  { name: "market-discovery-scheduled", cron: "0 */6 * * *" },
  { name: "trend-data-collection-recovery-scheduled", cron: "0 23 * * *" },
  { name: "trend-data-collection-scheduled", cron: "0 21 * * *" },
];
const verified = {
  functions: { "fixture-background": "b".repeat(64) }, functionsConfig: {}, schedules,
  inputDigest: "inputs", executionDigest: "execution", manifestDigest: "manifest",
};

test("deployment plan transport is GET-only and never follows redirects", async () => {
  const requests = [];
  const api = client("fixture-token-never-log", "plan", async (url, options) => {
    requests.push({ url, method: options.method, redirect: options.redirect });
    return new Response('{"id":"fixture"}', { status: 200 });
  });
  assert.equal((await api("/sites/fixture")).id, "fixture");
  await assert.rejects(api("/sites/fixture/deploys", { method: "POST", body: {} }), /cannot perform remote writes/);
  assert.deepEqual(requests, [{ url: "https://api.netlify.com/api/v1/sites/fixture", method: "GET", redirect: "error" }]);
});

test("deployment errors redact auth and never echo raw server bodies", async () => {
  const token = "fixture-token-never-log";
  const api = client(token, "plan", async () => new Response(JSON.stringify({ message: `Denied ${token} Bearer secret` }), { status: 401 }));
  await assert.rejects(api("/sites/fixture"), error => !error.message.includes(token) && !error.message.includes("Bearer secret"));
});

test("draft is default and Production requires explicit true", () => {
  assert.equal(parseArgs(["plan", "--commit", commit]).production, false);
  assert.equal(parseArgs(["plan", "--commit", commit, "--production", "true"]).production, true);
  assert.throws(() => parseArgs(["plan", "--commit", commit, "--production", "yes"]), /must be true or false/);
});

test("plan retains remote static SHA only and permits exactly three local files", async () => {
  const calls = [];
  const api = async route => {
    calls.push(route);
    if (route === `/sites/${siteId}`) return { published_deploy: { id: healthy } };
    assert.equal(route, `/sites/${siteId}/files`);
    return [{ path: "/index.html", sha: "c".repeat(40) }, { path: "/existing.txt", sha: "d".repeat(40) }];
  };
  const args = { expectedPublished: healthy, commit, production: true };
  const { plan, body, uploadFiles } = await makePlan(args, api, verified, null);
  assert.equal(body.files["existing.txt"], "d".repeat(40));
  assert.equal(body.draft, false);
  assert.equal(body.branch, "main");
  assert.deepEqual([...uploadFiles.values()].map(file => file.name).sort(), ["_headers", "index.html", "netlify.toml"]);
  assert.equal(plan.basePublishedId, healthy);
  assert.equal(calls.length, 2);
  await assert.rejects(makePlan(args, async () => ({ published_deploy: { id: "changed" } }), verified, null), /Published deploy changed/);
});

test("candidate CREATE carries complete manifest and retry reuses one ID", async () => {
  const calls = [], saved = [], state = { commit };
  const body = { draft: false, files: { "index.html": "x" }, functions: { example: "y" }, functions_config: { example: { build_data: { runtimeAPIVersion: 2 } } }, function_schedules: schedules };
  const api = async (route, options) => {
    assert.ok(saved.at(-1).creationAttemptedAt, "persist before network");
    assert.equal(saved.at(-1).deployId, undefined);
    calls.push({ route, options });
    return { id: candidate };
  };
  const persist = value => saved.push(JSON.parse(JSON.stringify(value)));
  await ensureCandidate(api, state, body, persist);
  await ensureCandidate(api, state, body, persist);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(calls[0].options.body, { ...body, deploy_source: "cli" });
  assert.equal(saved.at(-1).deployId, candidate);
});

test("unknown create outcome blocks any second creation", async () => {
  const state = { commit }; let calls = 0;
  const api = async () => { calls++; throw new Error("connection lost"); };
  await assert.rejects(ensureCandidate(api, state, { draft: true, functions: verified.functions }, () => {}), /connection lost/);
  await assert.rejects(ensureCandidate(api, state, { draft: true }, () => {}), /NEVER retry create/);
  assert.equal(calls, 1);
});

test("ready CREATE still needs manifest PUT with commit_ref before verification", () => {
  assert.equal(needsManifestUpload({}, { state: "ready" }), true);
  assert.equal(needsManifestUpload({ manifestUploadedAt: "now" }, { state: "uploading" }), true);
  assert.equal(needsManifestUpload({ manifestUploadedAt: "now" }, { state: "ready" }), false);
});

test("remote actual compact function metadata validates exact ZIP digests", () => {
  const functions = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`fixture-${i}`, i.toString(16).padStart(64, "0")]));
  const remote = { commit_ref: commit, function_schedules: schedules,
    available_functions: Object.entries(functions).map(([n, d]) => ({ n, d, bd: { runtimeAPIVersion: 2 }, r: "nodejs22.x", im: "stream" })) };
  verifyRemote(remote, { commit }, { functions });
  remote.available_functions[0].d = "f".repeat(64);
  assert.throws(() => verifyRemote(remote, { commit }, { functions }), /Remote function hash mismatch/);
});
