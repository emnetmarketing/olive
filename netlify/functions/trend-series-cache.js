const crypto = require("node:crypto");
const { connectLambda, getStore } = require("@netlify/blobs");

const STORE_NAME = "trend-series-cache";
const CACHE_VERSION = 1;
const NORMALIZATION_VERSION = "keyword-v1";
const SHARD_COUNT = 32;
const MANIFEST_KEY = "manifest-v1";

function connect(event) { if (event?.blobs) connectLambda(event); }
function store() { return getStore(STORE_NAME); }
function normalizedKeyword(value) { return String(value || "").normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[^0-9a-z가-힣]/g, ""); }
function shardFor(key) { return Number.parseInt(crypto.createHash("sha1").update(key).digest("hex").slice(0, 8), 16) % SHARD_COUNT; }
function shardKey(index) { return `shards/v1/${index}`; }
function seoulDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function readCache() {
  const shards = await Promise.all(Array.from({ length: SHARD_COUNT }, (_, index) => store().get(shardKey(index), { type: "json" }).catch(() => null)));
  const entries = new Map();
  for (const shard of shards) for (const [key, value] of Object.entries(shard?.entries || {})) entries.set(key, value);
  return { entries, manifest: await store().get(MANIFEST_KEY, { type: "json" }).catch(() => null) };
}

function validSeriesRecord(record, startDate, endDate, now = new Date()) {
  if (!record || record.version !== CACHE_VERSION || record.normalizationVersion !== NORMALIZATION_VERSION || record.timeUnit !== "date") return false;
  // An empty upstream series is also a reusable response. Treating it as a miss
  // would spend quota on the same no-data keyword every analysis.
  if (!Array.isArray(record.rawRatioSeries)) return false;
  if (record.requestStartDate > startDate || record.requestEndDate < endDate) return false;
  const historical = endDate < seoulDate(now);
  const fetchedAt = Date.parse(record.fetchedAt || "");
  return historical || Number.isFinite(fetchedAt) && seoulDate(new Date(fetchedAt)) === seoulDate(now);
}

function lookup(entries, keyword, source, category, startDate, endDate, now = new Date()) {
  const entry = entries.get(normalizedKeyword(keyword));
  const record = source === "search" ? entry?.search : entry?.shopping?.[category];
  if (!record) return { state: "miss", record: null, series: null };
  if (!validSeriesRecord(record, startDate, endDate, now)) return { state: "stale", record, series: null };
  return { state: "hit", record, series: record.rawRatioSeries.filter((point) => point.period >= startDate && point.period <= endDate) };
}

function upsert(entries, { keyword, source, category, startDate, endDate, series, fetchedAt = new Date().toISOString() }) {
  const key = normalizedKeyword(keyword); const previous = entries.get(key) || { keyword, normalizedKeyword: key, shopping: {} };
  const record = { version: CACHE_VERSION, normalizationVersion: NORMALIZATION_VERSION, source, timeUnit: "date",
    requestStartDate: startDate, requestEndDate: endDate, latestDataDate: (series || []).map((point) => point.period).sort().at(-1) || null,
    rawRatioSeries: series || [], fetchedAt };
  const next = source === "search" ? { ...previous, keyword, normalizedKeyword: key, search: record }
    : { ...previous, keyword, normalizedKeyword: key, shopping: { ...(previous.shopping || {}), [category]: record } };
  entries.set(key, next); return key;
}

async function writeDirty(cache, dirtyKeys) {
  const dirtyShards = new Set([...dirtyKeys].map(shardFor));
  await Promise.all([...dirtyShards].map(async (index) => {
    const entries = {};
    for (const [key, value] of cache.entries) if (shardFor(key) === index) entries[key] = value;
    await store().setJSON(shardKey(index), { version: CACHE_VERSION, shard: index, updatedAt: new Date().toISOString(), entries });
  }));
  const manifest = { version: CACHE_VERSION, normalizationVersion: NORMALIZATION_VERSION, shardCount: SHARD_COUNT,
    entryCount: cache.entries.size, updatedAt: new Date().toISOString() };
  await store().setJSON(MANIFEST_KEY, manifest); cache.manifest = manifest; return manifest;
}

module.exports = { connect, readCache, lookup, upsert, writeDirty, normalizedKeyword, validSeriesRecord, shardFor,
  CACHE_VERSION, NORMALIZATION_VERSION, SHARD_COUNT, MANIFEST_KEY };
