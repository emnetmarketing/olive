const test = require("node:test");
const assert = require("node:assert/strict");
const worker = require("../netlify/functions/instant-worker");
const quota = require("../netlify/functions/trend-api-quota");
const publication = require("../netlify/functions/instant-publication");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const clone = value => value == null ? value : structuredClone(value);

function memoryStore() {
  const records = new Map(); let revision = 0;
  return { records, before: null,
    async get(key) { return clone(records.get(key)?.data || null); },
    async getWithMetadata(key) { return clone(records.get(key) || null); },
    async setJSON(key, data, condition = {}) {
      await this.before?.(key, data);
      const previous = records.get(key);
      if (condition.onlyIfNew && previous || condition.onlyIfMatch && condition.onlyIfMatch !== previous?.etag) return { modified: false };
      records.set(key, { data: clone(data), etag: String(++revision) }); return { modified: true };
    }
  };
}
const job = id => ({ jobId: id, mode: "instant", state: "running", createdAt: new Date().toISOString(),
  startDate: "2026-09-17", endDate: "2026-10-16", queryStartDate: "2026-09-16", surgeThreshold: 500, matchThreshold: 70 });

test("same Instant Job allows only one live worker and does not reset running progress", async () => {
  const store = memoryStore(); await store.setJSON("jobs/example", { ...job("example"), progress: 82, processedCount: 2500 });
  const claims = await Promise.all([worker.claimInstantWorker("example", { store, owner: "first" }), worker.claimInstantWorker("example", { store, owner: "duplicate" })]);
  assert.equal(claims.filter(value => value.claimed).length, 1);
  assert.equal(claims.find(value => !value.claimed).reason, "worker-active");
  assert.equal((await store.get("jobs/example")).processedCount, 2500);
});

test("expired Instant worker cannot overwrite its replacement or dispatch further work", async () => {
  const store = memoryStore(); await store.setJSON("jobs/example", job("example"));
  let clock = Date.now(); const options = { store, now: () => clock };
  const first = await worker.claimInstantWorker("example", options);
  clock += worker.LEASE_MS + 1;
  const second = await worker.claimInstantWorker("example", options);
  await worker.writeOwnedInstantJob(second.lease, { progress: 89, processedCount: 5000 }, options);
  await assert.rejects(worker.writeOwnedInstantJob(first.lease, { progress: 75 }, options), { code: "INSTANT_WORKER_LOST" });
  await assert.rejects(worker.assertInstantWorker(first.lease, options), { code: "INSTANT_WORKER_LOST" });
  assert.equal((await store.get("jobs/example")).progress, 89);
});

test("unowned Instant write cannot erase live worker progress; same-owner progress is monotonic", async () => {
  const store = memoryStore(); const value = job("example"); await store.setJSON("jobs/example", value);
  const claimed = await worker.claimInstantWorker("example", { store });
  await worker.writeOwnedInstantJob(claimed.lease, { progress: 82, processedCount: 2500, currentStage: "calculation-matching" }, { store });
  const kept = await worker.writeOwnedInstantJob(claimed.lease, { progress: 75, processedCount: 500, currentStage: "calculation-matching" }, { store });
  assert.equal(kept.progress, 82); assert.equal(kept.processedCount, 2500);
  await assert.rejects(publication.writeInstantJobGuarded("example", { ...value, state: "failed" }, { store }), { code: "INSTANT_WORKER_LOST" });
});

test("Instant publication handoff releases exactly one owner and old catch cannot fail new worker", async () => {
  const store = memoryStore(); await store.setJSON("jobs/example", job("example"));
  const first = await worker.claimInstantWorker("example", { store });
  await worker.writeOwnedInstantJob(first.lease, { state: "publishing", currentStage: "publishing", results: [{ keyword: "fixture" }] }, { store });
  await worker.releaseInstantWorker(first.lease, { publicationAttempt: 1 }, { store });
  const second = await worker.claimInstantWorker("example", { store });
  assert.equal(second.claimed, true);
  await assert.rejects(worker.writeOwnedInstantJob(first.lease, { state: "publication_failed" }, { store }), { code: "INSTANT_WORKER_LOST" });
  await assert.rejects(worker.writeOwnedInstantJob(second.lease, { state: "running" }, { store }), { code: "INSTANT_WRITE_PROTECTED" });
});

test("quota counts attempted before response and crash leaves the reservation persisted", async () => {
  const store = memoryStore(); const options = { store, jobId: "example", invocationId: "first", source: "automatic", cumulative: true };
  await quota.recordUsageBatch({ searchTrend: { calls: 5 } }, options);
  const interrupted = await quota.readUsage(new Date(), { store });
  assert.equal(interrupted.daily.searchTrend, 5); assert.equal(interrupted.daily.searchTrendHttp200, 0);
  assert.equal(interrupted.jobs.example.metricsByType.searchTrend.calls, 5);
  assert.equal(interrupted.invocations.first.source, "automatic");
});

test("response accounting and identical receipt retry never double-charge attempts", async () => {
  const store = memoryStore(); const options = { store, jobId: "example", invocationId: "first", cumulative: true };
  await quota.recordUsageBatch({ searchTrend: { calls: 5 } }, options);
  await quota.recordUsageBatch({ searchTrend: { calls: 5, http200: 4, http429: 1, exhausted: true } }, options);
  await quota.recordUsageBatch({ searchTrend: { calls: 5, http200: 4, http429: 1, exhausted: true } }, options);
  const usage = await quota.readUsage(new Date(), { store });
  assert.equal(usage.daily.searchTrend, 5); assert.equal(usage.daily.searchTrendHttp200, 4);
  assert.equal(usage.daily.searchTrendHttp429, 1); assert.equal(usage.exhausted.searchTrend, true);
});

test("two actual invocations accumulate Shopping 4 + 4 = 8 on the same Job", async () => {
  const store = memoryStore();
  for (const invocationId of ["first", "second"]) await quota.recordUsageBatch({ shoppingInsight: { calls: 4, http200: 4 } },
    { store, jobId: "example", invocationId, cumulative: true });
  const usage = await quota.readUsage(new Date(), { store });
  assert.equal(usage.daily.shoppingInsight, 8); assert.equal(usage.jobs.example.metricsByType.shoppingInsight.calls, 8);
  assert.equal(usage.jobs.example.metricsByType.shoppingInsight.http200, 8);
});

test("legacy saved Job baseline survives a lost Job write without charging historic usage again", async () => {
  const store = memoryStore(); const baseline = { shoppingInsight: { calls: 4, http200: 4 } };
  await quota.recordUsageBatch({ shoppingInsight: { calls: 4, http200: 4 } }, { store, jobId: "legacy",
    invocationId: "first", jobBaseline: baseline, cumulative: true });
  await quota.recordUsageBatch({ shoppingInsight: { calls: 1, http200: 1 } }, { store, jobId: "legacy",
    invocationId: "second", jobBaseline: baseline, cumulative: true });
  const usage = await quota.readUsage(new Date(), { store });
  assert.equal(usage.daily.shoppingInsight, 5);
  assert.equal(usage.jobs.legacy.metricsByType.shoppingInsight.calls, 9);
});

test("concurrent quota writers retry CAS rather than losing provider usage", async () => {
  const store = memoryStore();
  await Promise.all(Array.from({ length: 8 }, (_, n) => quota.recordUsageBatch({ searchTrend: { calls: 1, http200: 1 } },
    { store, jobId: `job-${n}`, invocationId: `invoke-${n}`, cumulative: true })));
  const usage = await quota.readUsage(new Date(), { store }); assert.equal(usage.daily.searchTrend, 8);
  assert.equal(usage.monthly.searchTrendHttp200, 8);
});

test("lost quota response retries the same cumulative receipt without charging twice", async () => {
  const store = memoryStore(); const original = store.setJSON.bind(store); let lose = true;
  store.setJSON = async (...args) => { const result = await original(...args); if (lose) { lose = false; throw new Error("response lost"); } return result; };
  const options = { store, jobId: "example", invocationId: "first", cumulative: true };
  await assert.rejects(quota.recordUsageBatch({ searchTrend: { calls: 5, http200: 5 } }, options), /response lost/);
  await quota.recordUsageBatch({ searchTrend: { calls: 5, http200: 5 } }, options);
  assert.equal((await quota.readUsage(new Date(), { store })).daily.searchTrend, 5);
});

test("News audit metrics do not change Search Trend or Shopping budgets; historical accounting remains separate", async () => {
  const store = memoryStore();
  await quota.recordUsageBatch({ news: { calls: 20, http200: 19, httpOther: 1 } }, { store, jobId: "example", invocationId: "news", cumulative: true });
  await quota.recordUsageBatch({ searchTrend: { calls: 2, http200: 2, historicalCalls: 2 } },
    { store, jobId: "period", invocationId: "period", source: "historical", cumulative: true });
  const usage = await quota.readUsage(new Date(), { store });
  assert.equal(usage.daily.news, 20); assert.equal(usage.daily.searchTrend, 2);
  assert.equal(usage.daily.shoppingInsight || 0, 0); assert.equal(usage.monthly.searchTrendHistorical, 2);
});

test("atomic attempt reservation enforces the remaining budget but always accepts observed HTTP counters", async t => {
  const before = process.env.DAILY_TREND_FETCH_BUDGET; process.env.DAILY_TREND_FETCH_BUDGET = "3";
  t.after(() => { if (before === undefined) delete process.env.DAILY_TREND_FETCH_BUDGET; else process.env.DAILY_TREND_FETCH_BUDGET = before; });
  const store = memoryStore();
  const settled = await Promise.allSettled(Array.from({ length: 6 }, (_, n) => quota.recordUsageBatch({ searchTrend: { calls: 1 } },
    { store, jobId: `job-${n}`, invocationId: `invoke-${n}`, cumulative: true, enforceBudget: {} })));
  assert.equal(settled.filter(value => value.status === "fulfilled").length, 3);
  assert.equal(settled.filter(value => value.status === "rejected" && value.reason.code === "QUOTA_BUDGET_EXHAUSTED").length, 3);
  const accepted = settled.findIndex(value => value.status === "fulfilled");
  await quota.recordUsageBatch({ searchTrend: { calls: 1, http200: 1 } }, { store, jobId: `job-${accepted}`,
    invocationId: `invoke-${accepted}`, cumulative: true, enforceBudget: {} });
  const usage = await quota.readUsage(new Date(), { store });
  assert.equal(usage.daily.searchTrend, 3); assert.equal(usage.daily.searchTrendHttp200, 1);
});

test("a denied pre-request budget reservation never calls NAVER or counts a dispatched attempt", async t => {
  const beforeId = process.env.NAVER_CLIENT_ID, beforeSecret = process.env.NAVER_CLIENT_SECRET, beforeFetch = global.fetch;
  process.env.NAVER_CLIENT_ID = "fixture"; process.env.NAVER_CLIENT_SECRET = "fixture";
  let network = 0; global.fetch = async () => { network++; throw new Error("real network forbidden"); };
  t.after(() => { global.fetch = beforeFetch;
    if (beforeId === undefined) delete process.env.NAVER_CLIENT_ID; else process.env.NAVER_CLIENT_ID = beforeId;
    if (beforeSecret === undefined) delete process.env.NAVER_CLIENT_SECRET; else process.env.NAVER_CLIENT_SECRET = beforeSecret; });
  const metrics = { calls: 0 };
  await assert.rejects(require("../netlify/functions/trend-analysis-background")._test.api("/search-trend/v1/search", {
    metrics, onMetrics: async () => { throw Object.assign(new Error("budget exhausted"), { code: "QUOTA_BUDGET_EXHAUSTED" }); }
  }), { code: "QUOTA_BUDGET_EXHAUSTED" });
  assert.equal(network, 0); assert.equal(metrics.calls, 0);
});

test("actual Background entry skips duplicate Instant invocation before candidate or provider work", { timeout: 5000 }, async () => {
  const stores = new Map(), modules = new Map(); let candidateReads = 0, allowFirst, entered;
  const firstEntered = new Promise(resolve => { entered = resolve; });
  const firstGate = new Promise(resolve => { allowFirst = resolve; });
  const getStore = input => { const name = typeof input === "string" ? input : input.name;
    if (!stores.has(name)) stores.set(name, memoryStore()); return stores.get(name); };
  const overrides = {
    "blob-store-compat.js": { connectLambda() {}, getCompatibleStore: getStore },
    "keyword-candidate-cache.js": { readCandidateCache: async () => { candidateReads++; entered(); await firstGate; throw new Error("fixture stop after ownership check"); } },
    "market-discovery-cache.js": { readCache: async () => ({ items: [] }) },
    "search-ad-cache.js": { readCache: async () => ({ items: [{ productName: "fixture product" }] }) },
    "trend-series-cache.js": { connect() {}, readCache: async () => ({ entries: new Map() }) },
    "surge-history-cache.js": { readSurgeHistory: async () => ({ records: new Map() }) },
    "today-early-signal-cache.js": { readCache: async () => null },
  };
  function load(file) {
    if (overrides[file]) return overrides[file];
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    const absolute = path.resolve(__dirname, "../netlify/functions", file);
    vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(absolute, "utf8")}\n})`, { filename: absolute })(
      id => id === "@netlify/blobs" ? { getStore, connectLambda() {} } : id.startsWith("./") ? load(`${id.slice(2)}.js`) : require(id), module, module.exports);
    return module.exports;
  }
  const analysis = getStore("trend-analysis"); await analysis.setJSON("jobs/example", job("example"));
  const background = load("trend-analysis-background.js"); const originalFetch = global.fetch; let network = 0;
  global.fetch = async () => { network++; throw new Error("ALL external network forbidden"); };
  try {
    const first = background.handler({ body: '{"jobId":"example"}' }, { awsRequestId: "first" });
    // Fail clearly if preparation exits before reaching the ownership gate.
    // An unresolved firstEntered promise would otherwise stall the entire suite.
    await Promise.race([firstEntered, first.then(() => { throw new Error("Background exited before the candidate ownership gate"); })]);
    await background.handler({ body: '{"jobId":"example"}' }, { awsRequestId: "duplicate" });
    assert.equal(candidateReads, 1); assert.equal(network, 0);
    allowFirst(); await first;
    assert.equal((await analysis.get("jobs/example")).invocationCount, 1);
  } finally { allowFirst(); global.fetch = originalFetch; }
});
