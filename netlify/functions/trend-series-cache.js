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
function windowKey(startDate, endDate) { return `${startDate}_${endDate}`; }
function seoulDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function targetDataDate(endDate, now = new Date()) { return [endDate, shiftDate(seoulDate(now), -1)].sort()[0]; }

// Window compatibility and source freshness are different claims. In particular,
// a response fetched this morning can still end two days ago. Keep exact-window
// reads unchanged (including Fast Path/period); only the slow collector uses this
// bounded recheck decision. Missing days are not invented or zero-filled.
function assessSearchFreshness(record, startDate, endDate, now = new Date()) {
  const target = targetDataDate(endDate, now);
  if (!record || !Array.isArray(record.rawRatioSeries)) return { state: "missing", targetDataDate: target, needsRefresh: true };
  if (record.requestStartDate > startDate || record.requestEndDate < endDate) return { state: "window-unavailable", targetDataDate: target, needsRefresh: true };
  const dates = record.rawRatioSeries.map(p => p.period).filter(Boolean).sort();
  const actual = dates.at(-1) || null;
  const fetched = Date.parse(record.fetchedAt || "");
  const age = Number.isFinite(fetched) ? Math.max(0, now.getTime() - fetched) : Infinity;
  const empty = dates.length === 0;
  const fetchedDate = Number.isFinite(fetched) ? seoulDate(new Date(fetched)) : null;
  const historical = endDate <= shiftDate(seoulDate(now), -3);
  const settledHistorical = historical && fetchedDate && fetchedDate >= shiftDate(endDate, 2);
  if (actual && actual >= target) return { state: historical ? "historical" : "target-current", targetDataDate: target, actualDataDate: actual, needsRefresh: false, empty: false };
  if (settledHistorical) return { state: empty ? "empty-response" : "sparse-historical", targetDataDate: target, actualDataDate: actual, needsRefresh: false, empty };
  // Sparse/empty series remain legitimate responses. Do not repeatedly query
  // them in one run or pretend absence means zero demand. A recent incomplete
  // window is rechecked after a bounded delay, not cached as complete forever.
  const recheckMs = (empty ? 24 : 2) * 60 * 60 * 1000;
  return { state: empty ? "empty-response" : "recent-provider-delay", targetDataDate: target, actualDataDate: actual,
    needsRefresh: age >= recheckMs, empty, nextCheckAt: Number.isFinite(fetched) ? new Date(fetched + recheckMs).toISOString() : null };
}

function summarizeDateCoverage(seriesByKeyword, endDate, totalCount = seriesByKeyword.size, now = new Date()) {
  const target = targetDataDate(endDate, now);
  let targetCount = 0, validCount = 0, emptyCount = 0; const dates = [];
  for (const series of seriesByKeyword.values()) {
    const periods = (series || []).map(p => p.period).filter(Boolean).sort();
    if (!periods.length) { emptyCount += 1; continue; }
    validCount += 1; dates.push(periods[0], periods.at(-1));
    if (periods.some(date => date === target)) targetCount += 1;
  }
  dates.sort();
  return { targetDataDate: target, actualStartDate: dates[0] || null, actualDataDate: dates.at(-1) || null,
    cacheAvailableCount: seriesByKeyword.size, totalCount, validSeriesCount: validCount, emptySeriesCount: emptyCount,
    targetDataCandidateCount: targetCount, targetDataCoveragePct: totalCount ? Math.round(targetCount / totalCount * 10000) / 100 : 0,
    note: "목표일 관측값이 있는 후보 비율입니다. 희소·빈 응답은 미관측이며 수집 실패와 동일하지 않습니다." };
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
  const searchRecords = source === "search" ? [entry?.search, ...Object.values(entry?.searchWindows || {})].filter(Boolean) : [];
  const record = source === "search"
    ? searchRecords.filter((item) => item.requestStartDate <= startDate && item.requestEndDate >= endDate)
      .sort((a, b) => (Date.parse(b.fetchedAt || 0) - Date.parse(a.fetchedAt || 0)))[0] || entry?.search || searchRecords[0]
    : entry?.shopping?.[category];
  if (!record) return { state: "miss", record: null, series: null };
  if (record.requestStartDate > startDate || record.requestEndDate < endDate) {
    return { state: "window-unavailable", reason: "cache_window_unavailable", record, series: null };
  }
  if (!validSeriesRecord(record, startDate, endDate, now)) return { state: "stale", record, series: null };
  return { state: "hit", record, series: record.rawRatioSeries.filter((point) => point.period >= startDate && point.period <= endDate) };
}

function upsert(entries, { keyword, source, category, startDate, endDate, series, fetchedAt = new Date().toISOString(), cacheScope = "latest" }) {
  const key = normalizedKeyword(keyword); const previous = entries.get(key) || { keyword, normalizedKeyword: key, shopping: {} };
  const record = { version: CACHE_VERSION, normalizationVersion: NORMALIZATION_VERSION, source, timeUnit: "date",
    requestStartDate: startDate, requestEndDate: endDate, latestDataDate: (series || []).map((point) => point.period).sort().at(-1) || null,
    rawRatioSeries: series || [], fetchedAt };
  const next = source === "search" && cacheScope === "historical"
    ? { ...previous, keyword, normalizedKeyword: key, searchWindows: { ...(previous.searchWindows || {}), [windowKey(startDate, endDate)]: record } }
    : source === "search" ? { ...previous, keyword, normalizedKeyword: key, search: record }
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
  windowKey, CACHE_VERSION, NORMALIZATION_VERSION, SHARD_COUNT, MANIFEST_KEY, assessSearchFreshness, targetDataDate, summarizeDateCoverage };
