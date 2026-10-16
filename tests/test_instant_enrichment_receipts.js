const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), crypto = require("node:crypto");
const copy = value => structuredClone(value);
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const METRICS = ["calls", "retries", "keywords", "http200", "http429", "httpOther"];
const emptyMetrics = () => Object.fromEntries(["searchTrend", "shoppingInsight", "news"].map(type => [type,
  { ...Object.fromEntries(METRICS.map(metric => [metric, 0])), exhausted: false }]));
const crash = () => Object.assign(new Error("Simulated process death"), { code: "INSTANT_TEST_CRASH" });

// Run the exact production function with only its I/O dependencies replaced.
// No module import can open a real provider, Blob, or publication connection.
function fixture(phase = "shopping", jobOptions = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, "../netlify/functions/instant-pipeline.js"), "utf8");
  const functionSource = source.slice(source.indexOf("async function enrich("), source.indexOf("\nasync function finalize("));
  const blobs = new Map(), cache = new Map(), calls = [], faults = {}, invocations = new Map(), usage = emptyMetrics();
  const seed = { rows: [{ keyword: "fixture", category: "beauty", estimatedSurgeCount: 7031, relativeRatioLift: 420,
    shoppingTrend: [], shoppingRise: 0, trendSlope: 3, matchScore: 82 }] };
  blobs.set("seed", copy(seed));
  let persisted = { stage: "enrichment", result: { key: "seed" }, enrichmentPhase: phase, cursor: phase === "shopping" ? 0 : 1,
    newsCursor: 0, apiMetrics: emptyMetrics() }, sequence = 0;
  const receiptStore = {
    async get(key) { return copy(blobs.get(key) || null); },
    async setJSON(key, value, options) {
      if (options.onlyIfNew && blobs.has(key)) return { modified: false };
      blobs.set(key, copy(value));
      if (faults.receiptAfterWrite) { faults.receiptAfterWrite = false; throw crash(); }
      return { modified: true };
    }
  };
  const artifacts = {
    async readArtifact(ref) { const data = blobs.get(ref.key); assert.ok(data, `Missing fixture artifact ${ref.key}`); return copy(data); },
    async writeArtifact(lease, label, value) {
      const key = `${label}/${digest(value)}`; blobs.set(key, copy(value));
      if (faults.resultAfterWrite && /^(shopping|news)-results$/.test(label)) { faults.resultAfterWrite = false; throw crash(); }
      return { key };
    }
  };
  const quota = {
    async readUsage() { return { remaining: 100 }; }, statusFor() { return { remaining: 100, exhausted: false }; },
    async recordUsageBatch(metricsByType, options) {
      const prior = invocations.get(options.invocationId) || emptyMetrics();
      for (const [type, metrics] of Object.entries(metricsByType)) for (const metric of METRICS) {
        const value = Number(metrics[metric] || 0);
        usage[type][metric] += Math.max(0, value - prior[type][metric]); prior[type][metric] = Math.max(value, prior[type][metric]);
      }
      invocations.set(options.invocationId, prior);
    }
  };
  const core = {
    isSearchTrendOnly: job => job.collectionScope === "search-trend-only", median: values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)] || 0,
    reuseCachedNews(rows) { rows[0].news = { keyword: rows[0].keyword, total: 1, items: [{ title: "cached news" }] }; return 1; },
    async api(endpoint, options) {
      calls.push(endpoint); options.metrics.calls++; await options.onMetrics();
      if (faults.ambiguousProvider) { faults.ambiguousProvider = false; throw crash(); }
      options.metrics.http200++; await options.onMetrics();
      return endpoint.includes("shopping") ? { results: [{ title: "fixture", data: [{ period: "2026-10-14", ratio: 20 }, { period: "2026-10-15", ratio: 50 }] }] }
        : { total: 8, items: [{ title: "real fixture news", link: "https://fixture.invalid/article" }] };
    }
  };
  const enrich = vm.runInNewContext(`(${functionSource})`, {
    artifacts, quota, worker: { async assertInstantWorker() {} }, getCompatibleStore: () => receiptStore,
    digest, key: value => String(value).toLowerCase().replace(/\s/g, ""), METRICS, COLLECTION_MS: 180000,
    Date, Math, Number, String, Boolean, Map, structuredClone, error: (code, text) => Object.assign(new Error(text), { code }),
    async saveSeries(lease, updates) {
      for (const value of updates) cache.set(value.keyword, copy(value));
      if (faults.cacheAfterWrite) { faults.cacheAfterWrite = false; throw crash(); }
    },
    async combine() { throw new Error("Unexpected calculation in enrichment fixture"); }
  });
  const job = { jobId: "receipt-fixture", mode: "instant", queryStartDate: "2026-09-16", endDate: "2026-10-16", ...jobOptions };
  blobs.set("previous", {});
  return { blobs, cache, calls, faults, usage, job, get state() { return copy(persisted); },
    result() { return copy(blobs.get(persisted.result.key)); },
    async run() {
      const state = copy(persisted), lease = { owner: `invocation-${++sequence}` };
      // The production coordinator restores stronger quota totals before enrich.
      for (const type of Object.keys(usage)) for (const metric of METRICS)
        state.apiMetrics[type][metric] = Math.max(state.apiMetrics[type][metric], usage[type][metric]);
      await enrich({ job, lease, input: { previous: { key: "previous" } }, state, core, started: Date.now(),
        async save() {
          if (faults.stateBeforeCommit && state.enrichmentInflight === null) { faults.stateBeforeCommit = false; throw crash(); }
          persisted = copy(state);
        }, async patch() {}, log() {} });
      // The caller's normal continuation commits final stage changes as well.
      persisted = copy(state);
    }
  };
}

for (const phase of ["shopping", "news"]) {
  test(`${phase}: saved response survives death before the next Job state commit`, async () => {
    const value = fixture(phase); value.faults.receiptAfterWrite = true;
    await assert.rejects(value.run(), { code: "INSTANT_TEST_CRASH" });
    assert.ok(value.state.enrichmentInflight); assert.equal(value.calls.length, 1);
    assert.equal([...value.blobs.keys()].filter(key => key.includes("enrichment-receipts/")).length, 1);
    await value.run(); assert.equal(value.calls.length, 1); assert.equal(value.state.enrichmentInflight, null);
    if (phase === "shopping") { assert.equal(value.result().rows[0].shoppingRise, 30); assert.equal(value.cache.size, 1); }
    else { assert.equal(value.result().rows[0].news.total, 8); assert.equal(value.state.stage, "evidence"); }
    assert.equal(value.usage[phase === "shopping" ? "shoppingInsight" : "news"].calls, 1);
  });
  test(`${phase}: an orphan result artifact is rebuilt from the fixed receipt without another API request`, async () => {
    const value = fixture(phase); value.faults.resultAfterWrite = true;
    await assert.rejects(value.run(), { code: "INSTANT_TEST_CRASH" });
    await value.run(); assert.equal(value.calls.length, 1);
    const row = value.result().rows[0];
    assert.equal(row.estimatedSurgeCount, 7031); assert.equal(row.relativeRatioLift, 420); assert.equal(row.matchScore, 82);
    assert.equal(phase === "shopping" ? row.shoppingRise : row.news.total, phase === "shopping" ? 30 : 8);
  });
  test(`${phase}: an ambiguous provider outcome is recorded but never re-dispatched`, async () => {
    const value = fixture(phase); value.faults.ambiguousProvider = true;
    await assert.rejects(value.run(), { code: "INSTANT_TEST_CRASH" });
    await value.run(); assert.equal(value.calls.length, 1);
    assert.equal(value.state.enrichmentErrors[0].code, "REQUEST_OUTCOME_UNKNOWN");
    assert.equal(phase === "shopping" ? value.result().rows[0].shoppingRise : value.result().rows[0].news, phase === "shopping" ? 0 : undefined);
  });
}
test("Shopping cache and keyword accounting are idempotent after a cache write interruption", async () => {
  const value = fixture(); value.faults.cacheAfterWrite = true;
  await assert.rejects(value.run(), { code: "INSTANT_TEST_CRASH" });
  assert.equal(value.cache.size, 1); await value.run();
  assert.equal(value.cache.size, 1); assert.equal(value.calls.length, 1);
  assert.equal(value.usage.shoppingInsight.calls, 1); assert.equal(value.usage.shoppingInsight.http200, 1); assert.equal(value.usage.shoppingInsight.keywords, 1);
});
test("A response applied before a failed Job CAS does not double-count Shopping keywords on recovery", async () => {
  const value = fixture(); value.faults.stateBeforeCommit = true;
  await assert.rejects(value.run(), { code: "INSTANT_TEST_CRASH" });
  assert.equal(value.usage.shoppingInsight.keywords, 1); await value.run();
  assert.equal(value.usage.shoppingInsight.keywords, 1); assert.equal(value.calls.length, 1);
});
test("Receipt integrity failure stops without another provider request", async () => {
  const value = fixture("news"); value.faults.receiptAfterWrite = true;
  await assert.rejects(value.run(), { code: "INSTANT_TEST_CRASH" });
  const receiptKey = [...value.blobs.keys()].find(key => key.includes("enrichment-receipts/"));
  value.blobs.get(receiptKey).payload.total = 123;
  await assert.rejects(value.run(), { code: "INSTANT_ENRICHMENT_RECEIPT_INVALID" });
  assert.equal(value.calls.length, 1);
});
test("Search-only and Fast Path enrichment retain zero provider calls", async () => {
  for (const options of [{ collectionScope: "search-trend-only" }, { fastPath: true }]) {
    const value = fixture("shopping", options); await value.run(); await value.run();
    assert.equal(value.calls.length, 0); assert.equal(value.state.stage, "evidence");
    assert.equal([...value.blobs.keys()].filter(key => key.includes("enrichment-receipts/")).length, 0);
    if (options.collectionScope) assert.equal(value.result().reusedNewsCount, 1);
  }
});
