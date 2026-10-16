const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const core = require("../netlify/functions/market-discovery-core");
const history = require("../netlify/functions/market-discovery-history-cache");
const early = require("../netlify/functions/today-early-signal-cache");
const background = require("../netlify/functions/market-discovery-refresh-background")._test;

const clone = (value) => structuredClone(value);
const products = [{ brand: "테스트", product: "테스트 쿠션", adGroupId: "a" }, { brand: "테스트", product: "테스트 크림", adGroupId: "b" }];
function loadWith(dependencies) {
  const filename = path.resolve("netlify/functions/market-discovery-refresh-background.js");
  const instance = new Module(filename, module); instance.filename = filename;
  const ordinary = Module.createRequire(filename);
  instance.require = (name) => dependencies[name] || ordinary(name);
  instance._compile(fs.readFileSync(filename, "utf8"), filename); return instance.exports;
}
function fixture(options = {}) {
  const now = new Date().toISOString(), old = new Date(Date.now() - 36 * 3600000).toISOString();
  const status = { jobId: "discovery-fixture", state: "running", sourceMode: options.sourceMode || "cache-only", workerOwner: null,
    youtubeSearchLimit: 3, youtubeSupplementalLimit: 1, keywordtoolBackfill: false };
  const saved = { status, stages: [], quota: null, market: { refreshedAt: old, items: [] }, early: { generatedAt: old, signalDate: early.kstDate(old), items: [], history: [] },
    youtube: { refreshedAt: old, items: [{ videoId: "old", title: "테스트 쿠션 추천", channelId: "old-channel", publishedAt: old }] }, productCandidates: null };
  const cache = {
    connect() {}, readCache: async () => clone(saved.market), writeCache: async (value) => { if (options.failPublication) throw new Error("fixture publication failure"); saved.market = clone(value); },
    readTrustedChannels: async () => ({ channels: ["must-not-call-in-bounded-mode"] }), readYoutubeSnapshot: async () => clone(saved.youtube),
    writeYoutubeSnapshot: async (value) => { saved.youtube = clone(value); saved.sourceSaved = true; },
    readProductCandidates: async () => saved.productCandidates, writeProductCandidates: async (value) => { saved.productCandidates = clone(value); },
    readYoutubeUsage: async () => clone(saved.quota), mutateYoutubeUsage: async (fn) => { saved.quota = clone(fn(saved.quota)); return clone(saved.quota); },
    claimWorker: async (jobId) => { if (saved.status.jobId !== jobId || saved.status.state !== "running" || saved.status.workerOwner) return null;
      saved.status.workerOwner = "owner"; return clone(saved.status); },
    writeOwnedStatus: async (jobId, owner, patch) => { assert.equal(jobId, saved.status.jobId); assert.equal(owner, "owner");
      saved.status = { ...saved.status, ...clone(patch), updatedAt: new Date().toISOString() }; saved.stages.push(saved.status.stage); return clone(saved.status); },
  };
  const sourceTime = options.oldSearch ? old : now;
  const candidate = { keyword: "오늘신규크림", isNewSearchQuery: true, sources: ["searchad-query"], category: "beauty", firstSeenAt: sourceTime, lastSeenAt: sourceTime,
    impressions30d: 20, clicks30d: 3, monthlyVolumeStatus: "available", monthlyTotalSearches: 300 };
  const handler = loadWith({ "./market-discovery-cache": cache,
    "./search-ad-cache": { readCache: async () => ({ refreshedAt: old, items: products }), accounts: () => [], searchAdGet: async () => { throw new Error("unexpected Search Ad API"); } },
    "./keyword-candidate-cache": { readCandidateCache: async () => ({ refreshedAt: sourceTime, candidates: [candidate] }) },
    "./market-discovery-history-cache": { ...history, readHistory: async () => ({ items: [] }), writeHistory: async (value) => { saved.history = clone(value); } },
    "./today-early-signal-cache": { ...early, readCache: async () => clone(saved.early), writeCache: async (value) => { saved.early = clone(value); } },
  }).handler;
  return { saved, run: () => handler({ body: JSON.stringify({ jobId: status.jobId }) }) };
}

test("cache-only discovery rebuilds sources and Early Signal without any provider request", async () => {
  const f = fixture(); const original = global.fetch;
  global.fetch = async () => { throw new Error("network forbidden"); };
  try { await f.run(); } finally { global.fetch = original; }
  assert.equal(f.saved.status.state, "completed"); assert.ok(f.saved.market.items.length);
  assert.equal(f.saved.market.youtube.lastSuccessAt, f.saved.youtube.refreshedAt);
  assert.ok(f.saved.early.items.some((item) => item.keyword === "오늘신규크림"));
  assert.ok(f.saved.early.items.every((item) => !item.comparisons.youtube || item.comparisons.youtube.current === 0));
  assert.equal(early.freshness(f.saved.early).status, "partial");
  assert.equal(f.saved.quota, null); assert.equal(f.saved.market.keywordtool.apiCalls, 0);
  assert.ok(f.saved.stages.includes("derived-cache-publication")); assert.ok(f.saved.stages.includes("history-publication"));
});

test("cached older Search Ad increases are not relabelled as today's signals", () => {
  const now = "2026-10-16T09:00:00Z";
  const item = { keyword: "과거크림", normalizedKeyword: "과거크림", discoverySource: ["searchad-new-query"], discoveredAt: "2026-10-16T00:00:00Z",
    searchAdEvidence: { lastSeenAt: "2026-10-14T00:00:00Z", recentImpressions: 100, previousImpressions: 20 } };
  assert.equal(early.buildEarlySignals([item], { items: [] }, now, { requireFreshSource: true }).length, 0);
  assert.equal(early.freshness({ generatedAt: now, signalDate: "2026-10-16", sourceSuccessTimes: { searchAd: "2026-10-14T00:00:00Z" } }, now).status, "stale");
});

test("a cache-only rebuild without current sources preserves the prior signal day and results", async () => {
  const f = fixture({ oldSearch: true }); const prior = clone(f.saved.early);
  await f.run(); assert.equal(f.saved.early.generatedAt, prior.generatedAt); assert.equal(f.saved.early.signalDate, prior.signalDate);
  assert.deepEqual(f.saved.early.items, prior.items); assert.equal(f.saved.early.refreshFailure.code, "NO_CURRENT_SOURCE");
  assert.equal(early.freshness(f.saved.early).status, "stale");
});

test("bounded source collection records every request before fetch and preserves originals on downstream failure", async () => {
  const f = fixture({ sourceMode: "collect", failPublication: true }); const original = global.fetch, originalKey = process.env.YOUTUBE_API_KEY;
  let calls = 0, searches = 0, statistics = 0; process.env.YOUTUBE_API_KEY = "fixture-only";
  global.fetch = async (input) => {
    const url = new URL(input); calls += 1; assert.equal(f.saved.quota.api, calls);
    if (url.pathname.endsWith("/search")) { searches += 1; return new Response(JSON.stringify({ items: [{ id: { videoId: `video-${searches}` }, snippet: {
      title: "테스트 쿠션 추천", channelId: "fixture", publishedAt: new Date().toISOString() } }], nextPageToken: "next" }), { status: 200 }); }
    assert.ok(url.pathname.endsWith("/videos")); statistics += 1;
    return new Response(JSON.stringify({ items: url.searchParams.get("id").split(",").map((id) => ({ id, statistics: { viewCount: "10" } })) }), { status: 200 });
  };
  try { await f.run(); } finally { global.fetch = original; if (originalKey == null) delete process.env.YOUTUBE_API_KEY; else process.env.YOUTUBE_API_KEY = originalKey; }
  assert.equal(searches, 3); assert.equal(statistics, 1); assert.equal(calls, 4);
  assert.equal(f.saved.status.state, "failed"); assert.equal(f.saved.status.failedStage, "derived-cache-publication");
  assert.equal(f.saved.sourceSaved, true); assert.equal(f.saved.youtube.items.length, 3); assert.equal(f.saved.youtube.partial, true);
  assert.equal(f.saved.quota.api, 4); assert.equal(f.saved.quota.http200, 4); assert.equal(f.saved.quota.officialRemaining, null);
  assert.equal(f.saved.status.resumableFromSources, true);
});

test("429 quota use survives source failure and old originals remain reusable", async () => {
  const f = fixture({ sourceMode: "collect" }); const original = global.fetch, originalKey = process.env.YOUTUBE_API_KEY;
  let calls = 0; process.env.YOUTUBE_API_KEY = "fixture-only";
  global.fetch = async () => { calls += 1; return new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 429 }); };
  try { await f.run(); } finally { global.fetch = original; if (originalKey == null) delete process.env.YOUTUBE_API_KEY; else process.env.YOUTUBE_API_KEY = originalKey; }
  assert.equal(calls, 1); assert.equal(f.saved.quota.api, 1); assert.equal(f.saved.quota.http429, 1); assert.equal(f.saved.quota.providerBlocked, true);
  assert.equal(f.saved.youtube.items[0].videoId, "old"); assert.equal(f.saved.market.youtube.searchCallsToday, 1);
  assert.equal(f.saved.status.state, "completed"); assert.equal(early.freshness(f.saved.early).status, "partial");
});

test("explicit 403 quota reasons block further requests but a permission error is not called quota", async () => {
  const original = global.fetch, originalKey = process.env.YOUTUBE_API_KEY; process.env.YOUTUBE_API_KEY = "fixture-only";
  try {
    for (const reason of ["quotaExceeded", "dailyLimitExceeded", "forbidden"]) {
      const f = fixture({ sourceMode: "collect" }); let calls = 0;
      global.fetch = async () => { calls += 1; return new Response(JSON.stringify({ error: { message: reason, errors: [{ reason }] } }), { status: 403 }); };
      await f.run(); assert.equal(calls, 1); assert.equal(f.saved.quota.api, 1); assert.equal(f.saved.quota.other, 1);
      assert.equal(Boolean(f.saved.quota.providerBlocked), reason !== "forbidden");
    }
  } finally { global.fetch = original; if (originalKey == null) delete process.env.YOUTUBE_API_KEY; else process.env.YOUTUBE_API_KEY = originalKey; }
});

test("duplicate background invocation never calls sources twice", async () => {
  const f = fixture(); await Promise.all([f.run(), f.run()]);
  assert.equal(f.saved.stages.filter((stage) => stage === "source-cache-read").length, 1);
  assert.equal(f.saved.status.state, "completed");
});

test("source execution budget stops before network and quota date matches Pacific reset", async () => {
  const original = global.fetch, originalKey = process.env.YOUTUBE_API_KEY; let calls = 0;
  process.env.YOUTUBE_API_KEY = "fixture-only"; global.fetch = async () => { calls += 1; throw new Error("forbidden"); };
  let value; try { value = await background.collectYoutube({}, products, { channels: [] }, { deadline: Date.now() }); }
  finally { global.fetch = original; if (originalKey == null) delete process.env.YOUTUBE_API_KEY; else process.env.YOUTUBE_API_KEY = originalKey; }
  assert.equal(calls, 0); assert.equal(value.partial, true); assert.match(value.error, /안전시간/);
  assert.equal(background.youtubeQuotaDay("2026-10-16T06:59:59Z"), "2026-10-15");
  assert.equal(background.youtubeQuotaDay("2026-10-16T07:00:00Z"), "2026-10-16");
});

test("cached product-type lookup keeps the original longest-match rule and vocabulary order", () => {
  for (const value of ["블랙쿠션", "선파우더", "아이크림", ...products.map((item) => item.product)]) {
    const compact = require("../netlify/functions/product-matching").compact;
    const expected = core.VERIFIED_TYPES.slice().sort((a, b) => compact(b).length - compact(a).length).find((type) => compact(value).includes(compact(type))) || "";
    assert.equal(core.productTypeIn(value), expected);
  }
});
