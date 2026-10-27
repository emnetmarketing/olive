const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const quota = require("../netlify/functions/trend-api-quota");
const { api } = require("../netlify/functions/trend-analysis-background")._test;

const START = new Date("2026-10-27T07:00:00.000Z");
const JOB = { jobId: "dispatch-gate-job", mode: "instant", state: "running", fastPath: false,
  collectionScope: "search-trend-only", targetDataDate: "2026-10-26", createdAt: "2026-10-27T06:59:00.000Z",
  startDate: "2026-09-28", endDate: "2026-10-27", queryStartDate: "2026-09-27", surgeThreshold: 500, matchThreshold: 70 };
const APPROVAL = { maxAttempts: 1000, expiresAt: "2026-10-27T08:00:00.000Z", automaticReserve: 8763, safetyReserve: 12000,
  officialObservation: { observedAt: "2026-10-27T06:56:57.000Z", month: "2026-10", monthlyLimit: 50000,
    used: 27283, remaining: 22717, internalMonthlyBaseline: 11244 } };
const pipeline = fs.readFileSync(path.resolve(__dirname, "../netlify/functions/instant-pipeline.js"), "utf8");
const gateBody = pipeline.match(/beforeDispatch: async \(\) => \{([\s\S]*?)\n\s*\} \} : \{\}\)/)?.[1];
assert.ok(gateBody, "Execute the actual pipeline beforeDispatch callback, not a replacement guard");

function memoryStore() {
  let revision = 1;
  let saved = { version: 1, date: "2026-10-27", month: "2026-10", daily: { searchTrend: 1000 },
    monthly: { searchTrend: 11244, searchTrendHistorical: 7 }, exhausted: {}, invocations: {}, jobs: {} };
  return { async get() { return structuredClone(saved); },
    async getWithMetadata() { return { data: structuredClone(saved), etag: String(revision) }; },
    async setJSON(key, data, condition = {}) {
      if (condition.onlyIfMatch && condition.onlyIfMatch !== String(revision)) return { modified: false };
      saved = structuredClone(data); revision++; return { modified: true };
    } };
}
async function fixture(t, options = {}) {
  const store = memoryStore(); let now = new Date(START), sequence = Promise.resolve(), afterRecord = null;
  const metrics = { calls: 0, retries: 0, keywords: 0, http200: 0, http429: 0, httpOther: 0 };
  const events = [], transports = [];
  await quota.provisionEmergencyGrant(JOB, { ...APPROVAL, ...options.approval }, { store, now });
  const id = process.env.NAVER_CLIENT_ID, secret = process.env.NAVER_CLIENT_SECRET, originalFetch = global.fetch;
  process.env.NAVER_CLIENT_ID = "fixture-only"; process.env.NAVER_CLIENT_SECRET = "fixture-only";
  global.fetch = async (url, init) => {
    assert.equal(new URL(url).pathname, "/search-trend/v1/search");
    events.push("transport"); transports.push({ at: now.toISOString(), body: init.body });
    return options.response ? options.response({ transports, advance: value => { now = new Date(value); } })
      : { ok: true, status: 200, headers: { get() { return null; } }, json: async () => ({ results: [] }) };
  };
  t.after(() => {
    global.fetch = originalFetch;
    if (id === undefined) delete process.env.NAVER_CLIENT_ID; else process.env.NAVER_CLIENT_ID = id;
    if (secret === undefined) delete process.env.NAVER_CLIENT_SECRET; else process.env.NAVER_CLIENT_SECRET = secret;
  });
  const record = () => {
    const pending = sequence.then(async () => {
      events.push("account");
      await quota.recordUsageBatch({ searchTrend: { ...metrics } }, { store, now, jobId: JOB.jobId,
        invocationId: "dispatch-gate-invocation", cumulative: true, enforceBudget: { emergencyJob: JOB } });
      await afterRecord?.();
    });
    sequence = pending.catch(() => null); return pending;
  };
  const executeGate = new Function("worker", "lease", "quota", "emergencyJob", "error", "Date", `return async () => {${gateBody}\n};`)(
    { assertInstantWorker: async () => { events.push("gate"); } }, {},
    { ...quota, readUsage: () => quota.readUsage(now, { store }), emergencyStatus: (usage, job) => quota.emergencyStatus(usage, job, now) },
    JOB, (code, message) => Object.assign(new Error(message), { code }), { now: () => now.getTime(), parse: Date.parse });
  return { store, metrics, events, transports, record, executeGate,
    setAfterRecord(fn) { afterRecord = fn; }, advance(value) { now = new Date(value); },
    read: () => store.get(quota.USAGE_KEY),
    close: () => quota.closeEmergencyGrant(JOB.jobId, { store, now, reason: "fixture-closed" }),
    request: () => api("/search-trend/v1/search", { method: "POST", body: { keywordGroups: [] }, metrics,
      collectionPolicy: JOB, onMetrics: record, beforeDispatch: executeGate }) };
}

test("actual API gate runs after durable reservation and before transport; final reserved call remains permitted", async t => {
  const f = await fixture(t, { approval: { maxAttempts: 1 } });
  await f.request();
  assert.deepEqual(f.events, ["account", "gate", "transport", "account"]);
  const saved = await f.read();
  assert.equal(saved.emergencyInstantGrants[JOB.jobId].used, 1);
  assert.equal(saved.jobs[JOB.jobId].metricsByType.searchTrend.http200, 1);
  assert.equal(f.transports.length, 1);
});

test("expiry after cumulative reservation blocks all concurrent transports while preserving conservative reservations", async t => {
  const f = await fixture(t);
  f.setAfterRecord(() => f.advance(APPROVAL.expiresAt));
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => f.request()));
  assert.equal(results.filter(result => result.status === "rejected" && result.reason.code === "EMERGENCY_DISPATCH_STOPPED").length, 5);
  assert.equal(f.transports.length, 0);
  const saved = await f.read();
  assert.equal(saved.emergencyInstantGrants[JOB.jobId].used, 5, "Reserved attempts are not falsely reported as actual transports");
  assert.equal(saved.daily.searchTrend, 1005);
  assert.equal(saved.daily.searchTrendHttp200, 0);
});

test("grant closure after reservation blocks transport rather than treating zero delta as response permission", async t => {
  const f = await fixture(t);
  f.setAfterRecord(() => f.close());
  await assert.rejects(f.request(), { code: "EMERGENCY_DISPATCH_STOPPED" });
  assert.equal(f.transports.length, 0);
  assert.equal((await f.read()).emergencyInstantGrants[JOB.jobId].used, 1);
});

test("a response arriving after expiry is accounted without re-running the dispatch gate or adding another call", async t => {
  const f = await fixture(t, { response: ({ advance }) => {
    advance(APPROVAL.expiresAt);
    return { ok: true, status: 200, headers: { get() { return null; } }, json: async () => ({ results: [] }) };
  } });
  await f.request();
  assert.equal(f.transports.length, 1); assert.equal(f.events.filter(event => event === "gate").length, 1);
  const saved = await f.read();
  assert.equal(saved.emergencyInstantGrants[JOB.jobId].used, 1);
  assert.equal(saved.daily.searchTrendHttp200, 1);
  assert.equal(quota.emergencyStatus(saved, JOB, new Date(APPROVAL.expiresAt)).eligible, false);
});

test("each retry has a separate dispatch gate and closing after its reservation prevents its transport", async t => {
  const f = await fixture(t, { response: () => ({ ok: false, status: 429,
    headers: { get(name) { return name === "retry-after" ? "0.001" : null; } }, json: async () => ({}) }) });
  f.setAfterRecord(async () => { if (f.metrics.calls === 2) await f.close(); });
  await assert.rejects(f.request(), { code: "EMERGENCY_DISPATCH_STOPPED" });
  assert.equal(f.transports.length, 1); assert.equal(f.events.filter(event => event === "gate").length, 2);
  const saved = await f.read();
  assert.equal(saved.emergencyInstantGrants[JOB.jobId].used, 2);
  assert.equal(saved.daily.searchTrendHttp429, 1); assert.equal(saved.daily.searchTrendRetries, 1);
});

test("failed quota reservation never reaches the dispatch gate; wrong provider fails even before reservation", async t => {
  const f = await fixture(t); f.advance(APPROVAL.expiresAt);
  await assert.rejects(f.request(), { code: "QUOTA_BUDGET_EXHAUSTED" });
  assert.equal(f.metrics.calls, 0); assert.deepEqual(f.events, ["account"]);
  await assert.rejects(api("/search/v1/news", { collectionPolicy: JOB, metrics: f.metrics,
    onMetrics: f.record, beforeDispatch: f.executeGate }), { code: "COLLECTION_SCOPE_BLOCKED" });
  assert.deepEqual(f.events, ["account"]); assert.equal(f.transports.length, 0);
  assert.equal((await f.read()).emergencyInstantGrants[JOB.jobId].used, 0);
});

test("pipeline classifies dispatch denial as budget limitation while retaining cache-only calculation transition", () => {
  assert.match(pipeline, /\["QUOTA_BUDGET_EXHAUSTED", "EMERGENCY_DISPATCH_STOPPED"\]\.includes\(response\.reason\?\.code\)/);
  assert.match(pipeline, /state\.stage = "numeric"; state\.cursor = 0;/);
  assert.match(pipeline, /const providersAllowed = !job\.fastPath && !scoped/);
});
