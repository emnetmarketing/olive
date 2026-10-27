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
      stores.set(name, { records, writes, before: null,
        async get(key) { return clone(records.get(key)?.data || null); },
        async getWithMetadata(key) { return clone(records.get(key) || null); },
        async setJSON(key, data, condition = {}) {
          await this.before?.(key, data);
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
  const acquisitions = [], queued = [], jobs = new Map();
  const rt = runtime({
    "trend-analysis-cache.js": { connect() {}, acquireJob: async input => {
      acquisitions.push(input); return { existing: Boolean(existing), job: existing || { ...input, jobId: "new-instant" } };
    }, writeJob: async (id, data) => jobs.set(id, data), readJob: async id => jobs.get(id), readCurrentJob: async () => null },
    "instant-dispatch.js": { enqueueInitial: async id => { queued.push(id); } },
    "trend-api-quota.js": { connect() {} }, "signal-snapshot-cache.js": { connect() {}, readLatest: async () => null },
    "keyword-candidate-cache.js": { readCandidateCache: async () => ({ candidates: [{ keyword: "fixture" }] }) },
    "search-ad-cache.js": { readCache: async () => ({ items: [{ product: "fixture" }] }) },
    "operating-settings-cache.js": { readOperatingSettings: async () => ({ surgeThreshold: 300, matchThreshold: 40 }) }
  });
  return { ...rt, acquisitions, queued, start: rt.load("trend-analysis-start.js") };
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
  assert.deepEqual(fixture.queued, ["new-instant"]); assert.equal(calls.length, 0);
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

test("resuming an older frozen window preserves newer automatic cache and other historical responses", async () => {
  const rt = runtime(), store = rt.getStore("trend-analysis"), series = rt.load("trend-series-cache.js");
  const job = { jobId: "old-window-resume", mode: "instant", state: "running", createdAt: "2026-10-16T13:00:00Z" };
  await store.setJSON(`jobs/${job.jobId}`, job);
  const { lease } = await rt.load("instant-worker.js").claimInstantWorker(job.jobId);
  const entries = new Map(), keyword = "fixture";
  series.upsert(entries, { keyword, source: "search", startDate: "2026-09-27", endDate: "2026-10-27",
    series: [{ period: "2026-10-26", ratio: 91 }], fetchedAt: "2026-10-27T00:00:00Z" });
  series.upsert(entries, { keyword, source: "search", startDate: "2026-08-01", endDate: "2026-08-31",
    series: [], fetchedAt: "2026-09-01T00:00:00Z", cacheScope: "historical" });
  const original = clone(entries.get(keyword)), shard = series.shardFor(keyword);
  const cache = rt.getStore("trend-series-cache");
  await cache.setJSON(`shards/v1/${shard}`, { entries: Object.fromEntries(entries) });
  await rt.load("instant-pipeline.js").saveSeries(lease, [{ keyword, source: "search", startDate: "2026-09-16", endDate: "2026-10-16",
    series: [{ period: "2026-10-15", ratio: 70 }], fetchedAt: "2026-10-27T03:00:00Z" }]);
  const saved = (await cache.get(`shards/v1/${shard}`)).entries[keyword];
  assert.deepEqual(saved.search, original.search);
  assert.deepEqual(saved.searchWindows["2026-08-01_2026-08-31"], original.searchWindows["2026-08-01_2026-08-31"]);
  assert.deepEqual(saved.searchWindows["2026-09-16_2026-10-16"].rawRatioSeries, [{ period: "2026-10-15", ratio: 70 }]);
});

test("an older resumed Job cannot roll shared diagnostic or candidate signal views back", async () => {
  const rt = runtime(), store = rt.getStore("trend-analysis");
  const job = { jobId: "older", mode: "instant", state: "running", createdAt: "2026-10-16T13:00:00Z" };
  await store.setJSON("jobs/older", job);
  await store.setJSON("jobs/newer", { ...job, jobId: "newer", createdAt: "2026-10-27T00:00:00Z" });
  const { lease } = await rt.load("instant-worker.js").claimInstantWorker(job.jobId);
  for (const key of ["signals/current", "diagnostics/latest-v1"]) {
    const previous = { jobId: "newer", items: [{ keyword: "keep-new" }] };
    await store.setJSON(key, previous);
    assert.deepEqual(await rt.load("instant-pipeline.js").writeCurrentProjection(lease, job, key, { items: [] }), { skippedNewer: true });
    assert.deepEqual(await store.get(key), previous);
  }
});

function backgroundFixture({ scope = SCOPE, cachedShopping = true, cachedNews = true } = {}) {
  const seriesCache = require("../netlify/functions/trend-series-cache");
  let candidateReads = 0;
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
    "keyword-candidate-cache.js": { readCandidateCache: async () => { candidateReads++; return { candidates: clone(candidates) }; } },
    "market-discovery-cache.js": { readCache: async () => ({ items: [] }) },
    "search-ad-cache.js": { readCache: async () => ({ items: clone(products) }) },
    "trend-series-cache.js": { ...seriesCache, connect() {}, readCache: async () => ({ entries: new Map(entries) }),
      writeDirty: async (map, keys) => { dirty.push(...keys); } },
    "today-early-signal-cache.js": { readCache: async () => clone(early), confirmSignals: value => { earlyConfirms++; return value; },
      writeCache: async () => { earlyWrites++; } },
    "market-discovery-history-cache.js": { readHistory: async () => null },
  });
  return { ...rt, keywords, series, shopping, news, cachedNews, early, dirty, entries, seriesCache,
    get earlyWrites() { return earlyWrites; }, get earlyConfirms() { return earlyConfirms; }, get candidateReads() { return candidateReads; },
    job: { jobId: scope ? "scoped-instant" : "ordinary-instant", mode: "instant", state: "running", currentStage: "preparing", fastPath: false,
      collectionScope: scope, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      startDate: "2026-09-17", endDate: "2026-10-16", queryStartDate: "2026-09-16", surgeThreshold: 300, matchThreshold: 40 } };
}

async function runBackground(t, options) {
  const optionsForRun = options;
  const fixture = backgroundFixture(options), store = fixture.getStore("trend-analysis");
  const seriesStore = fixture.getStore("trend-series-cache"), grouped = new Map();
  for (const [keyword, entry] of fixture.entries) {
    const shard = fixture.seriesCache.shardFor(keyword);
    if (!grouped.has(shard)) grouped.set(shard, {});
    grouped.get(shard)[keyword] = entry;
  }
  for (const [shard, entries] of grouped) await seriesStore.setJSON(`shards/v1/${shard}`, { version: 1, shard, entries });
  await store.setJSON("jobs/previous-instant", { jobId: "previous-instant", mode: "instant", state: "completed", completedAt: "2026-10-16T01:00:00Z",
    results: fixture.keywords.map(keyword => ({ keyword, news: fixture.cachedNews ? fixture.news(keyword) : null })) });
  await store.setJSON("last-success/instant", { jobId: "previous-instant" });
  await store.setJSON("last-success/period", { jobId: "preserved-period439" });
  await fixture.getStore("trend-signal-snapshots").setJSON("latest-valid-v1/period", { jobId: "preserved-period439", resultCount: 439 });
  await store.setJSON(`jobs/${fixture.job.jobId}`, fixture.job);
  const queue = [], previousUrl = process.env.URL;
  let lostDispatchResponse = false, dispatcherActive = false;
  const loseOneDispatchResponse = Boolean(options?.lostDispatchResponseOnce);
  process.env.URL = "https://instant-fixture.invalid";
  const calls = fakeNetwork(t, async (url, options) => {
    const route = new URL(url).pathname;
    if (route === "/.netlify/functions/trend-analysis-background") {
      assert.equal(dispatcherActive, true, "Worker must never invoke itself");
      assert.equal(new URL(url).origin, process.env.URL);
      const body = JSON.parse(options.body); assert.equal(body.jobId, fixture.job.jobId);
      queue.push(body);
      if (loseOneDispatchResponse && !lostDispatchResponse) {
        lostDispatchResponse = true;
        throw Object.assign(new Error("fixture accepted continuation but response was lost"), { name: "TimeoutError" });
      }
      return { ok: true, status: 202 };
    }
    if (route === "/search-trend/v1/search") return { ok: true, status: 200, headers: { get() { return null; } },
      json: async () => ({ results: JSON.parse(options.body).keywordGroups.map(group => ({ title: group.groupName,
        data: optionsForRun?.providerHasLaterDay ? [...fixture.series, { period: "2026-10-16", ratio: 99 }] : fixture.series })) }) };
    if (route === "/shopping/v1/category/keywords" && !fixture.job.collectionScope) return { ok: true, status: 200, headers: { get() { return null; } },
      json: async () => ({ results: JSON.parse(options.body).keyword.map(group => ({ title: group.name, data: fixture.shopping })) }) };
    if (route === "/search/v1/news" && !fixture.job.collectionScope) { const value = fixture.news(new URL(url).searchParams.get("query"));
      return { ok: true, status: 200, headers: { get() { return null; } }, json: async () => ({ total: value.total, items: value.items }) }; }
    throw new Error(`Unexpected source provider ${route}`);
  });
  let invocationCount = 0;
  queue.push({ jobId: fixture.job.jobId });
  await options?.setup?.({ fixture, store, seriesStore, queue });
  try {
    while (queue.length) {
      assert.ok(invocationCount < 128, "Instant continuation must be bounded");
      await fixture.load("trend-analysis-background.js").handler({ body: JSON.stringify(queue.shift()) },
        { awsRequestId: `${fixture.job.jobId}-request-${++invocationCount}` });
      dispatcherActive = true;
      try { await fixture.load("instant-dispatch.js").tick({ store, baseURL: process.env.URL, requestId: `cron-${invocationCount}` }); }
      finally { dispatcherActive = false; }
      await options?.afterInvocation?.({ fixture, store, seriesStore, queue, invocationCount });
    }
  } finally { if (previousUrl === undefined) delete process.env.URL; else process.env.URL = previousUrl; }
  const result = await store.get(`jobs/${fixture.job.jobId}`);
  assert.equal(result.state, "completed", JSON.stringify(result.errors));
  assert.deepEqual(await store.get("last-success/period"), { jobId: "preserved-period439" });
  assert.deepEqual(await fixture.getStore("trend-signal-snapshots").get("latest-valid-v1/period"), { jobId: "preserved-period439", resultCount: 439 });
  const savedKeywords = [];
  for (const shard of grouped.keys()) {
    const saved = await seriesStore.get(`shards/v1/${shard}`);
    for (const [keyword, entry] of Object.entries(saved.entries || {}))
      if (entry.search?.rawRatioSeries?.at(-1)?.period === "2026-10-15") savedKeywords.push(keyword);
  }
  assert.ok(invocationCount > 1, "Actual Instant stages must cross fresh invocation boundaries");
  return { fixture, result, calls: calls.filter(call => !new URL(call.url).pathname.startsWith("/.netlify/")), invocationCount, savedKeywords };
}

test("actual restricted Instant worker fetches only Search Trend and reuses cached Shopping/News without Early writes", async t => {
  const { fixture, result, calls, savedKeywords } = await runBackground(t, {});
  assert.ok(result.results.length > 0); assert.equal(result.latestDataDate, "2026-10-15");
  assert.equal(result.searchTrendApiCallCount, 1); assert.equal(result.searchTrendHttp200Count, 1);
  assert.equal(result.shoppingInsightApiCallCount, 0); assert.equal(result.newsApiCallCount || 0, 0);
  assert.equal(calls.length, 1); assert.ok(calls.every(call => new URL(call.url).pathname === "/search-trend/v1/search"));
  assert.equal(fixture.earlyWrites, 0); assert.equal(fixture.earlyConfirms, 0);
  for (const row of result.results) { assert.equal(row.shoppingRise, 20); assert.deepEqual(row.news, fixture.news(row.keyword)); assert.ok(row.newsCacheOrigin); }
  assert.equal(savedKeywords.length, 3);
});

test("late recovery preserves full original-window responses but calculates only through the frozen target", async t => {
  const { fixture, result } = await runBackground(t, { providerHasLaterDay: true });
  assert.equal(result.targetDataDate, "2026-10-15");
  assert.equal(result.latestDataDate, "2026-10-15");
  assert.ok(result.results.every(row => row.latestDataDate <= "2026-10-15"));
  for (const keyword of fixture.keywords) {
    const shard = fixture.seriesCache.shardFor(keyword);
    const stored = (await fixture.getStore("trend-series-cache").get(`shards/v1/${shard}`)).entries[keyword].search;
    assert.equal(stored.requestEndDate, "2026-10-16");
    assert.equal(stored.rawRatioSeries.at(-1).period, "2026-10-16");
  }
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

test("committed frozen inputs recover the initial missing state without rereading current candidates", async t => {
  let removed = false;
  const run = await runBackground(t, { afterInvocation: async ({ fixture, store, invocationCount }) => {
    if (invocationCount !== 1) return;
    const job = await store.get(`jobs/${fixture.job.jobId}`);
    assert.ok(job.instantInputsKey); assert.ok(job.instantStateKey);
    // A process can stop after inputs CAS but before its first state CAS. The
    // already-written orphan is deliberately retained, as in Blob storage.
    for (const field of ["instantStateKey", "instantStateHash", "instantStateRevision", "instantStage", "checkpointUpdatedAt"])
      delete job[field];
    await store.setJSON(`jobs/${fixture.job.jobId}`, job); removed = true;
  } });
  assert.equal(removed, true); assert.equal(run.fixture.candidateReads, 1);
  assert.equal(run.calls.length, 1); assert.equal(run.result.results.length, 3);
});

test("saved source receipt resumes cache storage without a second provider request", async t => {
  let injected = false, resumed = false, receiptSeen = false;
  const run = await runBackground(t, { setup: async ({ seriesStore }) => {
    seriesStore.before = async (key, data) => {
      if (!injected && key.startsWith("shards/") && Object.values(data.entries || {}).some(entry => entry.search?.rawRatioSeries?.at(-1)?.period === "2026-10-15")) {
        injected = true; throw Object.assign(new Error("fixture cache write interrupted after response receipt"), { code: "INSTANT_CACHE_CONFLICT" });
      }
    };
  }, afterInvocation: async ({ fixture, store, queue }) => {
    const job = await store.get(`jobs/${fixture.job.jobId}`);
    if (!resumed && job.state === "interrupted" && job.errorCode === "INSTANT_CACHE_CONFLICT") {
      const state = await fixture.load("instant-continuation.js").readState(job);
      receiptSeen = Boolean(state.inflight?.receipt); assert.equal(receiptSeen, true);
      assert.equal(state.calculationCursor, 0); assert.equal(job.searchTrendApiCallCount, 1);
      // Simulated authorized resume changes only the in-memory Job status. No
      // cache, receipt or cursor is discarded and no source request is replayed.
      await store.setJSON(`jobs/${fixture.job.jobId}`, { ...job, state: "running" });
      queue.push({ jobId: fixture.job.jobId, continuationTicket: job.continuationDispatch?.ticket }); resumed = true;
    }
  } });
  assert.equal(injected && resumed && receiptSeen, true);
  assert.equal(run.calls.length, 1); assert.equal(run.result.searchTrendApiCallCount, 1);
  assert.equal(run.savedKeywords.length, 3); assert.ok(run.result.trendCollectedAt);
  assert.equal(run.result.apiMetrics.searchTrend.keywords, 3);
});

test("enrichment resumes from saved cursor and restores counters written before state checkpoint", async t => {
  let injected = false, resumed = false;
  const run = await runBackground(t, { scope: null, cachedShopping: false, setup: async ({ store }) => {
    store.before = async (key, value) => {
      if (!injected && key.includes("/instant-v1/news-results/") && value.label === "news-results") {
        injected = true; throw new Error("fixture result save interrupted after News accounting");
      }
    };
  }, afterInvocation: async ({ fixture, store, queue }) => {
    const job = await store.get(`jobs/${fixture.job.jobId}`);
    if (!resumed && job.state === "interrupted" && injected) {
      const state = await fixture.load("instant-continuation.js").readState(job);
      assert.equal(state.stage, "enrichment"); assert.equal(state.enrichmentPhase, "news");
      assert.equal(job.apiMetrics.news.calls, 1); assert.equal(state.apiMetrics.news.calls, 0);
      await store.setJSON(`jobs/${fixture.job.jobId}`, { ...job, state: "running" });
      queue.push({ jobId: fixture.job.jobId, continuationTicket: job.continuationDispatch?.ticket }); resumed = true;
    }
  } });
  assert.equal(injected && resumed, true);
  const news = run.calls.filter(call => new URL(call.url).pathname === "/search/v1/news");
  assert.equal(news.length, 3); assert.equal(new Set(news.map(call => new URL(call.url).searchParams.get("query"))).size, 3);
  assert.equal(run.result.newsApiCallCount, 3); assert.equal(run.result.newsHttp200Count, 3);
  assert.equal(run.result.shoppingInsightApiCallCount, 1);
});

test("independent dispatch response loss preserves the ticket; unsolicited worker cannot bypass the ticket", async t => {
  let checked = false;
  const run = await runBackground(t, { lostDispatchResponseOnce: true,
    afterInvocation: async ({ fixture, store, queue, invocationCount }) => {
      if (invocationCount !== 1) return;
      const before = await store.get(`jobs/${fixture.job.jobId}`);
      assert.equal(before.state, "running"); assert.equal(before.resumable, true);
      assert.ok(queue[0].continuationTicket); assert.equal(queue[0].continuationTicket, before.continuationDispatch.ticket);
      await fixture.load("trend-analysis-background.js").handler({ body: JSON.stringify({ jobId: fixture.job.jobId }) },
        { awsRequestId: "unexpected-unticketed-retry" });
      assert.deepEqual(await store.get(`jobs/${fixture.job.jobId}`), before);
      checked = true;
    } });
  assert.equal(checked, true); assert.equal(run.result.state, "completed");
  assert.equal(run.calls.length, 1); assert.equal(run.result.searchTrendApiCallCount, 1);
  assert.equal(run.fixture.candidateReads, 1); assert.equal(run.result.results.length, 3);
});
