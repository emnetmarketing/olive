const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const clone = value => value == null ? value : structuredClone(value);
const SCOPE = "search-trend-only";

function runtime(overrides = {}) {
  const stores = new Map(), modules = new Map(); let revision = 0;
  const getStore = value => {
    const name = typeof value === "string" ? value : value.name;
    if (!stores.has(name)) {
      const records = new Map(), writes = [];
      stores.set(name, { records, writes,
        async get(key) { return clone(records.get(key)?.data || null); },
        async getWithMetadata(key) { return clone(records.get(key) || null); },
        async setJSON(key, data, condition = {}) {
          const prior = records.get(key);
          if (condition.onlyIfNew && prior || condition.onlyIfMatch && condition.onlyIfMatch !== prior?.etag) return { modified: false };
          records.set(key, { data: clone(data), etag: String(++revision) }); writes.push(key); return { modified: true };
        }
      });
    }
    return stores.get(name);
  };
  function load(file) {
    if (overrides[file]) return overrides[file];
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    const filename = path.resolve(__dirname, "../netlify/functions", file);
    vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, { filename })(
      id => id === "@netlify/blobs" ? { getStore, connectLambda() {} }
        : id.startsWith("./") ? load(`${id.slice(2)}.js`) : require(id), module, module.exports);
    return module.exports;
  }
  overrides["blob-store-compat.js"] = { connectLambda() {}, getCompatibleStore: getStore };
  return { getStore, load, stores };
}

function startFixture(existing = null) {
  const acquisitions = [], jobs = new Map();
  const rt = runtime({
    "trend-analysis-cache.js": { connect() {}, acquireJob: async input => {
      acquisitions.push(input); return { existing: Boolean(existing), job: existing || { ...input, jobId: "new-instant" } };
    }, writeJob: async (id, data) => jobs.set(id, data), readJob: async id => jobs.get(id), readCurrentJob: async () => null },
    "trend-api-quota.js": { connect() {} }, "signal-snapshot-cache.js": { connect() {}, readLatest: async () => null },
    "keyword-candidate-cache.js": { readCandidateCache: async () => ({ candidates: [{ keyword: "fixture" }] }) },
    "search-ad-cache.js": { readCache: async () => ({ items: [{ product: "fixture" }] }) },
    "operating-settings-cache.js": { readOperatingSettings: async () => ({ surgeThreshold: 300, matchThreshold: 40 }) }
  });
  return { ...rt, acquisitions, start: rt.load("trend-analysis-start.js") };
}
function fakeNetwork(t, responder) {
  const original = global.fetch, previousId = process.env.NAVER_CLIENT_ID, previousSecret = process.env.NAVER_CLIENT_SECRET;
  const calls = []; process.env.NAVER_CLIENT_ID = "fixture-only"; process.env.NAVER_CLIENT_SECRET = "fixture-only";
  global.fetch = async (url, options = {}) => { calls.push({ url: String(url), options }); return responder(url, options); };
  t.after(() => { global.fetch = original;
    if (previousId === undefined) delete process.env.NAVER_CLIENT_ID; else process.env.NAVER_CLIENT_ID = previousId;
    if (previousSecret === undefined) delete process.env.NAVER_CLIENT_SECRET; else process.env.NAVER_CLIENT_SECRET = previousSecret;
  });
  return calls;
}

test("search-only scope is accepted only for explicit Instant Slow Path and survives the Job/dispatch response", async t => {
  const fixture = startFixture(); const calls = fakeNetwork(t, async () => ({ ok: true, status: 202 }));
  const response = await fixture.start.handle({ httpMethod: "POST", body: JSON.stringify({ mode: "instant", collectionScope: SCOPE }) }, { fastPath: false });
  assert.equal(response.statusCode, 202); assert.equal(fixture.acquisitions[0].collectionScope, SCOPE);
  assert.equal(JSON.parse(response.body).collectionScope, SCOPE);
  assert.equal(JSON.parse(calls[0].options.body).job.collectionScope, SCOPE);
  assert.equal(fixture.acquisitions[0].historicalCollection, false);
});

test("invalid, Period, and Fast Path collection scopes fail before Job creation or transport", async t => {
  const calls = fakeNetwork(t, async () => { throw new Error("No transport permitted"); });
  for (const [mode, fastPath, collectionScope] of [["instant", false, "all"], ["period", false, SCOPE], ["instant", true, SCOPE], ["period", true, SCOPE]]) {
    const fixture = startFixture();
    const response = await fixture.start.handle({ httpMethod: "POST", body: JSON.stringify({ mode, collectionScope,
      startDate: "2026-10-01", endDate: "2026-10-16" }) }, { fastPath });
    assert.equal(response.statusCode, 400); assert.equal(JSON.parse(response.body).errorCode, "INVALID_COLLECTION_SCOPE");
    assert.equal(fixture.acquisitions.length, 0);
  }
  assert.equal(calls.length, 0);
});

test("default collection keeps its unrestricted contract; differently scoped running Job is not silently reused", async t => {
  fakeNetwork(t, async () => ({ ok: true, status: 202 }));
  const ordinary = startFixture();
  assert.equal((await ordinary.start.handle({ httpMethod: "POST", body: '{"mode":"instant"}' }, { fastPath: false })).statusCode, 202);
  assert.ok(!ordinary.acquisitions[0].collectionScope);
  const active = { ...ordinary.acquisitions[0], jobId: "ordinary-existing", state: "running" };
  const restricted = startFixture(active);
  const response = await restricted.start.handle({ httpMethod: "POST", body: JSON.stringify({ mode: "instant", collectionScope: SCOPE }) }, { fastPath: false });
  assert.equal(response.statusCode, 409); assert.equal(JSON.parse(response.body).errorCode, "INCOMPATIBLE_ACTIVE_JOB");
});

test("provider guard rejects Shopping, News, YouTube and Search Ad before counter reservation or fetch", async t => {
  const calls = fakeNetwork(t, async () => { throw new Error("Provider transport must stay blocked"); });
  const { api } = require("../netlify/functions/trend-analysis-background")._test;
  for (const route of ["/shopping/v1/category/keywords", "/search/v1/news", "https://www.googleapis.com/youtube/v3/search", "https://api.searchad.naver.com/keywordstool"]) {
    const metrics = { calls: 0 }; let reservations = 0;
    await assert.rejects(api(route, { collectionPolicy: { mode: "instant", fastPath: false, collectionScope: SCOPE }, metrics,
      onMetrics: async () => { reservations++; } }), { code: "COLLECTION_SCOPE_BLOCKED" });
    assert.equal(metrics.calls, 0); assert.equal(reservations, 0);
  }
  assert.equal(calls.length, 0);
});

test("provider guard permits only the exact Search Trend route and preserves normal reservation/accounting", async t => {
  const calls = fakeNetwork(t, async () => ({ ok: true, status: 200, headers: { get() { return null; } }, json: async () => ({ results: [] }) }));
  const { api } = require("../netlify/functions/trend-analysis-background")._test;
  const metrics = { calls: 0, http200: 0, http429: 0, httpOther: 0 }; let reservations = 0;
  await api("/search-trend/v1/search", { method: "POST", body: {}, collectionPolicy: { mode: "instant", fastPath: false, collectionScope: SCOPE },
    metrics, onMetrics: async () => { reservations++; } });
  assert.equal(calls.length, 1); assert.equal(metrics.calls, 1); assert.equal(metrics.http200, 1); assert.ok(reservations >= 2);
  await assert.rejects(api("/search-trend/v1/search/extra", { collectionPolicy: { mode: "instant", fastPath: false, collectionScope: SCOPE } }), { code: "COLLECTION_SCOPE_BLOCKED" });
  assert.equal(calls.length, 1);
});

test("malformed persisted scoped Jobs also fail closed, while absent scope does not block ordinary providers", () => {
  const { assertProviderAllowed } = require("../netlify/functions/trend-analysis-background")._test;
  for (const extra of [{ mode: "period" }, { fastPath: true }, { historicalCollection: true }, { collectionScope: "unexpected" }])
    assert.throws(() => assertProviderAllowed("/search-trend/v1/search", { mode: "instant", fastPath: false, collectionScope: SCOPE, ...extra }), { code: "COLLECTION_SCOPE_BLOCKED" });
  for (const route of ["/search-trend/v1/search", "/search/v1/news", "/shopping/v1/category/keywords"])
    assert.doesNotThrow(() => assertProviderAllowed(route, { mode: "instant", fastPath: false }));
});

test("cached News is cloned from completed Instant only, never fabricated from Period or missing evidence", () => {
  const { reuseCachedNews } = require("../netlify/functions/trend-analysis-background")._test;
  const previous = { mode: "instant", state: "completed", jobId: "old", latestDataDate: "2026-10-14", results: [
    { keyword: "라카 트윈 립", news: { total: 2, items: [{ title: "saved" }] } }] };
  const rows = [{ keyword: "라카트윈립", news: null }, { keyword: "없음", news: null }];
  assert.equal(reuseCachedNews(rows, { ...previous, mode: "period" }), 0);
  assert.equal(reuseCachedNews(rows, { ...previous, state: "running" }), 0);
  assert.equal(reuseCachedNews(rows, previous), 1); assert.equal(rows[1].news, null);
  assert.equal(rows[0].newsCacheOrigin.jobId, "old"); assert.equal(rows[0].newsCacheOrigin.latestDataDate, "2026-10-14");
  rows[0].news.items[0].title = "local"; assert.equal(previous.results[0].news.items[0].title, "saved");
});

function backgroundFixture({ scope = SCOPE, cachedShopping = true, cachedNews = true } = {}) {
  const seriesCache = require("../netlify/functions/trend-series-cache");
  const keywords = ["라카트윈립", "메디힐비타민씨세럼", "제로이드포밍클렌저"];
  const candidates = keywords.map(keyword => ({ keyword, category: "beauty", monthlyTotalSearches: 120000,
    sources: ["keywordstool"], firstSeenAt: "2026-09-01T00:00:00Z", priorityScore: 50, monthlyVolumeStatus: "available" }));
  const products = [{ product: "라카 퍼펙트 트윈 립 4.7g", account: "fixture" },
    { product: "메디힐 비타민씨 세럼", brand: "메디힐", account: "fixture" },
    { product: "제로이드 포밍 클렌저 200ml", brand: "제로이드", account: "fixture" }];
  const series = Array.from({ length: 30 }, (_, i) => ({ period: new Date(Date.UTC(2026, 8, 16 + i)).toISOString().slice(0, 10), ratio: i === 29 ? 100 : 1 }));
  const shopping = series.map((point, i) => ({ ...point, ratio: i === 29 ? 25 : 5 }));
  const entries = new Map();
  for (const keyword of keywords) {
    seriesCache.upsert(entries, { keyword, source: "search", startDate: "2026-09-16", endDate: "2026-10-16", series: series.slice(0, -1), fetchedAt: "2026-10-15T00:00:00Z" });
    if (cachedShopping) seriesCache.upsert(entries, { keyword, category: "beauty", source: "shopping", startDate: "2026-09-16", endDate: "2026-10-16", series: shopping, fetchedAt: new Date().toISOString() });
  }
  const news = keyword => ({ keyword, total: 2, items: [{ title: "저장된 근거", pubDate: "2026-10-15T00:00:00Z" }] });
  const early = { jobId: "preserved-early", signalDate: "2026-10-16", items: [{ keyword: "preserved" }], history: [{ keyword: "preserved" }] };
  let earlyWrites = 0, earlyConfirms = 0;
  const dirty = [];
  const rt = runtime({
    "keyword-candidate-cache.js": { readCandidateCache: async () => ({ candidates: clone(candidates) }) },
    "market-discovery-cache.js": { readCache: async () => ({ items: [] }) },
    "search-ad-cache.js": { readCache: async () => ({ items: clone(products) }) },
    "trend-series-cache.js": { ...seriesCache, connect() {}, readCache: async () => ({ entries: new Map(entries) }),
      writeDirty: async (map, keys) => { dirty.push(...keys); } },
    "today-early-signal-cache.js": { readCache: async () => clone(early), confirmSignals: value => { earlyConfirms++; return value; },
      writeCache: async () => { earlyWrites++; } },
    "market-discovery-history-cache.js": { readHistory: async () => null },
  });
  return { ...rt, keywords, series, shopping, news, cachedNews, early, dirty, get earlyWrites() { return earlyWrites; }, get earlyConfirms() { return earlyConfirms; },
    job: { jobId: scope ? "scoped-instant" : "ordinary-instant", mode: "instant", state: "running", currentStage: "preparing", fastPath: false,
      collectionScope: scope, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      startDate: "2026-09-17", endDate: "2026-10-16", queryStartDate: "2026-09-16", surgeThreshold: 300, matchThreshold: 40 } };
}

async function runBackground(t, options) {
  const fixture = backgroundFixture(options), store = fixture.getStore("trend-analysis");
  await store.setJSON("jobs/previous-instant", { jobId: "previous-instant", mode: "instant", state: "completed", completedAt: "2026-10-16T01:00:00Z",
    results: fixture.keywords.map(keyword => ({ keyword, news: fixture.cachedNews ? fixture.news(keyword) : null })) });
  await store.setJSON("last-success/instant", { jobId: "previous-instant" });
  await store.setJSON("last-success/period", { jobId: "preserved-period439" });
  await fixture.getStore("trend-signal-snapshots").setJSON("latest-valid-v1/period", { jobId: "preserved-period439", resultCount: 439 });
  await store.setJSON(`jobs/${fixture.job.jobId}`, fixture.job);
  const calls = fakeNetwork(t, async (url, options) => {
    const route = new URL(url).pathname;
    if (route === "/search-trend/v1/search") return { ok: true, status: 200, headers: { get() { return null; } },
      json: async () => ({ results: JSON.parse(options.body).keywordGroups.map(group => ({ title: group.groupName, data: fixture.series })) }) };
    if (route === "/shopping/v1/category/keywords" && !fixture.job.collectionScope) return { ok: true, status: 200, headers: { get() { return null; } },
      json: async () => ({ results: JSON.parse(options.body).keyword.map(group => ({ title: group.name, data: fixture.shopping })) }) };
    if (route === "/search/v1/news" && !fixture.job.collectionScope) { const value = fixture.news(new URL(url).searchParams.get("query"));
      return { ok: true, status: 200, headers: { get() { return null; } }, json: async () => ({ total: value.total, items: value.items }) }; }
    throw new Error(`Unexpected source provider ${route}`);
  });
  await fixture.load("trend-analysis-background.js").handler({ body: JSON.stringify({ jobId: fixture.job.jobId }) }, { awsRequestId: `${fixture.job.jobId}-request` });
  const result = await store.get(`jobs/${fixture.job.jobId}`);
  assert.equal(result.state, "completed", JSON.stringify(result.errors));
  assert.deepEqual(await store.get("last-success/period"), { jobId: "preserved-period439" });
  assert.deepEqual(await fixture.getStore("trend-signal-snapshots").get("latest-valid-v1/period"), { jobId: "preserved-period439", resultCount: 439 });
  return { fixture, result, calls };
}

test("actual restricted Instant worker fetches only Search Trend and reuses cached Shopping/News without Early writes", async t => {
  const { fixture, result, calls } = await runBackground(t, {});
  assert.ok(result.results.length > 0); assert.equal(result.latestDataDate, "2026-10-15");
  assert.equal(result.searchTrendApiCallCount, 1); assert.equal(result.searchTrendHttp200Count, 1);
  assert.equal(result.shoppingInsightApiCallCount, 0); assert.equal(result.newsApiCallCount || 0, 0);
  assert.equal(calls.length, 1); assert.ok(calls.every(call => new URL(call.url).pathname === "/search-trend/v1/search"));
  assert.equal(fixture.earlyWrites, 0); assert.equal(fixture.earlyConfirms, 0);
  for (const row of result.results) { assert.equal(row.shoppingRise, 20); assert.deepEqual(row.news, fixture.news(row.keyword)); assert.ok(row.newsCacheOrigin); }
  assert.equal(fixture.dirty.length, 3);
});

test("restricted worker does not request missing Shopping or News, and ordinary provider behavior remains intact", async t => {
  const restricted = await runBackground(t, { cachedShopping: false, cachedNews: false });
  assert.equal(restricted.calls.length, 1); assert.equal(restricted.result.shoppingInsightApiCallCount, 0);
  assert.ok(restricted.result.results.every(row => row.news === null && !row.newsCacheOrigin));
  const ordinary = await runBackground(t, { scope: null, cachedShopping: false });
  assert.ok(ordinary.calls.some(call => new URL(call.url).pathname === "/shopping/v1/category/keywords"));
  assert.ok(ordinary.calls.some(call => new URL(call.url).pathname === "/search/v1/news"));
  assert.equal(ordinary.fixture.earlyWrites, 1); assert.equal(ordinary.fixture.earlyConfirms, 1);
  const metrics = rows => rows.map(row => ({ keyword: row.keyword, estimatedSurgeCount: row.estimatedSurgeCount,
    peakRelativeLiftPct: row.peakRelativeLiftPct, peakDailyLift: row.peakDailyLift, estimatedBaseline: row.estimatedBaseline,
    absoluteSurgePassed: row.absoluteSurgePassed, relativeSurgePassed: row.relativeSurgePassed, resultType: row.resultType, matchScore: row.match?.score }));
  assert.deepEqual(metrics(restricted.result.results), metrics(ordinary.result.results));
});
