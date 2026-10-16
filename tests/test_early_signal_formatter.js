const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const filename = path.join(__dirname, "../netlify/functions/today-early-signal-cache.js");
const source = fs.readFileSync(filename, "utf8").replace(/\r\n/g, "\n");
const sharedFormatter = 'const kstDateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" });\nfunction kstDate(value = Date.now()) { return kstDateFormatter.format(new Date(value)); }';
const legacyFormatter = 'function kstDate(value = Date.now()) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(value)); }';
const clock = "2026-10-16T14:59:59.999Z";
const plain = value => JSON.parse(JSON.stringify(value));

function load(legacy = false) {
  assert.ok(source.includes(sharedFormatter), "The comparison must replace only the formatter implementation");
  let constructors = 0, networkCalls = 0, storageCalls = 0;
  function CountingFormatter(...args) { constructors += 1; return new Intl.DateTimeFormat(...args); }
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return Date.parse(clock); }
  }
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, Date: FixedDate,
    Intl: { DateTimeFormat: CountingFormatter },
    fetch() { networkCalls += 1; throw new Error("External API forbidden in formatter regression"); },
    require(name) {
      assert.equal(name, "@netlify/blobs");
      return { connectLambda() { storageCalls += 1; throw new Error("Storage access forbidden"); },
        getStore() { storageCalls += 1; throw new Error("Storage access forbidden"); } };
    } });
  vm.runInContext(legacy ? source.replace(sharedFormatter, legacyFormatter) : source, context, { filename });
  return { functions: module.exports, counts: () => ({ constructors, networkCalls, storageCalls }) };
}

function fixture(now) {
  const ago = hours => new Date(Date.parse(now) - hours * 3600000).toISOString();
  const base = { keyword: "테스트쿠션", normalizedKeyword: "테스트쿠션", discoverySource: ["youtube"],
    discoveredAt: ago(1), lastSeenAt: now, relatedBrand: "테스트", relatedProductType: "쿠션",
    youtubeEvidence: [{ publishedAt: ago(1) }] };
  return {
    items: [base,
      { ...base, keyword: "복합근거", normalizedKeyword: "복합근거", discoverySource: ["youtube", "searchad-new-query", "product-cache"],
        productMatchScore: 87, relatedProductLine: "보습", youtubeEvidence: [0, 1, 2, 6, 11.99, 12, -1].map(hours => ({ publishedAt: ago(hours) })),
        searchAdEvidence: { observedAt: now, recentImpressions: 80, previousImpressions: 20, recentClicks: 8, previousClicks: 3 } },
      { ...base, keyword: "검색신규", normalizedKeyword: "검색신규", discoverySource: ["searchad-new-query"], youtubeEvidence: [],
        searchAdEvidence: { observedAt: now, recentImpressions: 3 } },
      { ...base, keyword: "이전검색", normalizedKeyword: "이전검색", discoverySource: ["searchad-new-query"], youtubeEvidence: [],
        searchAdEvidence: { observedAt: ago(30), recentImpressions: 40, previousImpressions: 10 } },
      { ...base, keyword: "상품만", normalizedKeyword: "상품만", discoverySource: ["product-cache"], youtubeEvidence: [] },
      { ...base, keyword: "잘못된영상일", normalizedKeyword: "잘못된영상일", youtubeEvidence: [{ publishedAt: "invalid" }] },
      { ...base, keyword: "최초관측없음", normalizedKeyword: "최초관측없음", discoveredAt: null, lastSeenAt: null },
      { ...base, productMatchScore: 90 },
      { ...base, keyword: "", normalizedKeyword: "", youtubeEvidence: [] }],
    history: { items: [{ normalizedKeyword: "테스트쿠션", everSurged: true, lastResultType: "product_match", lastEstimatedSurgeCount: 432 },
      { normalizedKeyword: "최초관측없음", firstSeenAt: ago(40), everSurged: false }] }
  };
}

test("Early Signal formatter preserves complete scores, order, reasons and timestamps against the previous implementation", () => {
  const old = load(true), current = load();
  for (const now of ["2026-09-02T04:00:00.000Z", "2026-10-16T14:59:59.999Z", "2026-10-16T15:00:00.000Z", "2026-12-31T15:00:00.000Z"]) {
    const { items, history } = fixture(now);
    for (const options of [{}, { requireFreshSource: true }]) {
      const expected = plain(old.functions.buildEarlySignals(items, history, now, options));
      const actual = plain(current.functions.buildEarlySignals(items, history, now, options));
      assert.deepEqual(actual, expected);
      assert.ok(actual.length >= 3, "Use real nonempty signals, not an empty-output equivalence");
      assert.equal(actual[0].normalizedKeyword, "복합근거");
      assert.equal(actual[0].todayEarlySignalScore, 100);
      assert.equal(actual[0].strength, "strong");
      assert.equal(actual[0].detectedAt, now);
      assert.match(actual[0].reasons.join(" "), /복수 source/);
      assert.equal(actual.filter(row => row.normalizedKeyword === "테스트쿠션").length, 1);
    }
  }
  assert.equal(current.counts().networkCalls + current.counts().storageCalls, 0);
});

test("Early Signal formatter preserves merge retention, confirmation, history and order", () => {
  const old = load(true), current = load(), now = clock;
  const { items, history } = fixture(now);
  const signals = current.functions.buildEarlySignals(items, history, now, { requireFreshSource: true });
  const previous = { history: [
    { earlySignalDate: "2026-08-01", normalizedKeyword: "만료", confirmation: null },
    { earlySignalDate: "2026-10-15", normalizedKeyword: "전일", confirmation: { naverConfirmed: true } },
    { earlySignalDate: "2026-10-16", normalizedKeyword: "테스트쿠션", todayEarlySignalScore: 1, confirmation: { naverConfirmed: true, nextTrendDate: "2026-10-17" } }
  ] };
  const actual = plain(current.functions.mergeCache(previous, signals, now));
  assert.deepEqual(actual, plain(old.functions.mergeCache(previous, signals, now)));
  assert.equal(actual.history.some(row => row.normalizedKeyword === "만료"), false);
  assert.equal(actual.items.find(row => row.normalizedKeyword === "테스트쿠션").confirmation.naverConfirmed, true);
  assert.deepEqual(actual.items.map(row => row.normalizedKeyword), actual.history.filter(row => row.earlySignalDate === "2026-10-16").map(row => row.normalizedKeyword));
});

test("Early Signal formatter constructs once per loaded module across repeated public calls", () => {
  const current = load(), now = clock, { items, history } = fixture(now);
  assert.equal(current.counts().constructors, 1);
  let cache = null;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    current.functions.kstDate(now);
    const signals = current.functions.buildEarlySignals(items, history, now, { requireFreshSource: true });
    cache = current.functions.mergeCache(cache, signals, now);
    current.functions.freshness(cache, now);
  }
  assert.deepEqual(current.counts(), { constructors: 1, networkCalls: 0, storageCalls: 0 });
});

test("KST midnight, year and leap-day boundaries retain the same date strings", () => {
  const old = load(true), current = load();
  for (const [value, expected] of [
    ["2026-10-16T14:59:59.999Z", "2026-10-16"], ["2026-10-16T15:00:00.000Z", "2026-10-17"],
    ["2026-12-31T14:59:59.999Z", "2026-12-31"], ["2026-12-31T15:00:00.000Z", "2027-01-01"],
    ["2024-02-28T15:00:00.000Z", "2024-02-29"], ["2024-02-29T15:00:00.000Z", "2024-03-01"],
    [0, "1970-01-01"], [null, "1970-01-01"], [undefined, "2026-10-16"],
    [new Date("2026-10-16T15:00:00.000Z"), "2026-10-17"]
  ]) {
    assert.equal(current.functions.kstDate(value), expected);
    assert.equal(current.functions.kstDate(value), old.functions.kstDate(value));
  }
});

test("Invalid date behavior remains RangeError instead of silently fabricating a date", () => {
  const old = load(true), current = load();
  for (const value of ["not-a-date", "", NaN, Infinity, new Date(NaN)]) {
    for (const implementation of [old, current]) assert.throws(() => implementation.functions.kstDate(value), error => error.name === "RangeError");
  }
  const broken = fixture(clock); broken.items[0].discoveredAt = "invalid";
  for (const implementation of [old, current]) assert.throws(() => implementation.functions.buildEarlySignals(broken.items, broken.history, clock), error => error.name === "RangeError");
});

test("Freshness and no-source/missing-data decisions are identical across the formatter change", () => {
  const old = load(true), current = load();
  for (const cache of [null, {}, { generatedAt: clock, signalDate: "2026-10-16" },
    { generatedAt: clock, signalDate: "2026-10-16", sourceSuccessTimes: { youtube: clock, searchAd: clock } },
    { generatedAt: clock, signalDate: "2026-10-16", sourceSuccessTimes: { youtube: "2026-10-15T01:00:00Z" }, sourcePartial: true, sourceErrors: ["source unavailable"] }]) {
    assert.deepEqual(plain(current.functions.freshness(cache, clock)), plain(old.functions.freshness(cache, clock)));
  }
  assert.deepEqual(plain(current.functions.buildEarlySignals([], { items: [] }, clock)), []);
  const { items, history } = fixture(clock);
  const currentSignals = plain(current.functions.buildEarlySignals(items, history, clock, { requireFreshSource: true }));
  assert.equal(currentSignals.find(row => row.normalizedKeyword === "검색신규").comparisons.searchAd.delta, null);
  assert.equal(currentSignals.some(row => row.normalizedKeyword === "이전검색"), false);
  assert.deepEqual(current.counts(), { constructors: 1, networkCalls: 0, storageCalls: 0 });
});
