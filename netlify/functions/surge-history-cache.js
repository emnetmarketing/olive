const crypto = require("node:crypto");
const { getStore } = require("@netlify/blobs");

const STORE = "trend-analysis";
const MANIFEST_KEY = "surge-history/current-v1";
const SHARD_COUNT = 16;
const CALCULATION_VERSION = 1;

function store() { return getStore(STORE); }
function normalizeKeyword(value) {
  return String(value || "").toLocaleLowerCase("ko-KR").replace(/[^0-9a-z가-힣]/g, "");
}
function shardNumber(normalizedKeyword) {
  return parseInt(crypto.createHash("sha256").update(normalizedKeyword).digest("hex").slice(0, 8), 16) % SHARD_COUNT;
}
function dateDiffDays(left, right) {
  return Math.round((Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / 86400000);
}
function recordKey(item) { return `${item.latestDataDate}|${item.mode}|${item.calculationVersion}`; }

async function readSurgeHistory() {
  const manifest = await store().get(MANIFEST_KEY, { type: "json" });
  if (!manifest?.shardKeys?.length) return { manifest: null, records: new Map() };
  const shards = await Promise.all(manifest.shardKeys.map((key) => store().get(key, { type: "json" })));
  const records = new Map();
  for (const item of shards.flatMap((shard) => shard?.items || [])) records.set(item.normalizedKeyword, item);
  return { manifest, records };
}

async function writeSurgeHistory(records, updatedAt = new Date().toISOString()) {
  const version = updatedAt.replace(/[^0-9]/g, "");
  const buckets = Array.from({ length: SHARD_COUNT }, () => []);
  for (const item of records.values()) buckets[shardNumber(item.normalizedKeyword)].push(item);
  const shardKeys = buckets.map((_, index) => `surge-history/shards/${version}/${index}`);
  await Promise.all(shardKeys.map((key, index) => store().setJSON(key, { items: buckets[index] })));
  const manifest = { version: 1, calculationVersion: CALCULATION_VERSION, updatedAt, shardCount: SHARD_COUNT,
    recordCount: records.size, shardKeys };
  await store().setJSON(MANIFEST_KEY, manifest);
  return manifest;
}

function upsertInstantHistory(records, entries, sourceJobId, calculatedAt = new Date().toISOString()) {
  for (const entry of entries) {
    const normalizedKeyword = normalizeKeyword(entry.keyword);
    if (!normalizedKeyword || !entry.latestDataDate) continue;
    const existing = records.get(normalizedKeyword) || { keyword: entry.keyword, normalizedKeyword, history: [] };
    const next = { keyword: entry.keyword, normalizedKeyword, latestDataDate: entry.latestDataDate,
      estimatedSurgeCount: Math.round(Number(entry.estimatedSurgeCount || 0)),
      estimatedBaseline: Math.round(Number(entry.estimatedBaseline || 0)),
      estimatedLatest: Math.round(Number(entry.estimatedLatest || 0)),
      monthlySearches: Number(entry.monthlySearches || 0), calculationVersion: CALCULATION_VERSION,
      mode: "instant", sourceJobId, calculatedAt };
    const history = [...(existing.history || [])];
    const index = history.findIndex((item) => recordKey(item) === recordKey(next));
    if (index >= 0) {
      if (String(next.calculatedAt) >= String(history[index].calculatedAt || "")) history[index] = next;
    } else history.push(next);
    history.sort((a, b) => a.latestDataDate.localeCompare(b.latestDataDate) || a.calculatedAt.localeCompare(b.calculatedAt));
    records.set(normalizedKeyword, { ...existing, keyword: entry.keyword, normalizedKeyword, history });
  }
  return records;
}

function deriveSurgeState(record, threshold, latestDataDate) {
  const history = (record?.history || []).filter((item) => item.mode === "instant" && item.calculationVersion === CALCULATION_VERSION)
    .slice().sort((a, b) => a.latestDataDate.localeCompare(b.latestDataDate));
  const latestIndex = latestDataDate ? history.findIndex((item) => item.latestDataDate === latestDataDate) : history.length - 1;
  if (latestIndex < 0) return null;
  const considered = history.slice(0, latestIndex + 1); const latest = considered.at(-1);
  const passed = (item) => Number(item.estimatedSurgeCount || 0) >= threshold;
  const passedHistory = considered.filter(passed);
  let consecutiveSurgeDays = 0; let dataGap = false;
  if (passed(latest)) {
    consecutiveSurgeDays = 1;
    for (let index = considered.length - 2; index >= 0; index -= 1) {
      const newer = considered[index + 1], older = considered[index];
      if (dateDiffDays(older.latestDataDate, newer.latestDataDate) !== 1) { dataGap = true; break; }
      if (!passed(older)) break;
      consecutiveSurgeDays += 1;
    }
  }
  const previous = considered.at(-2) || null;
  const priorPassed = considered.slice(0, -1).some(passed);
  const statuses = [];
  if (passed(latest)) {
    if (!priorPassed) statuses.push("신규 급등");
    else if (consecutiveSurgeDays >= 2) statuses.push(`${consecutiveSurgeDays}일 연속 급등`);
    else statuses.push("재급등");
    if (previous) {
      const difference = Number(latest.estimatedSurgeCount || 0) - Number(previous.estimatedSurgeCount || 0);
      statuses.push(difference > 0 ? "급등 강화" : difference < 0 ? "급등 둔화" : "급등 유지");
    }
  }
  if (dataGap) statuses.push("데이터 공백");
  return { firstSurgedAt: passedHistory[0]?.latestDataDate || null, lastSurgedAt: passedHistory.at(-1)?.latestDataDate || null,
    surgeDaysCount: passedHistory.length, consecutiveSurgeDays, previousSurgeCount: previous ? Number(previous.estimatedSurgeCount || 0) : null,
    latestSurgeCount: Number(latest.estimatedSurgeCount || 0), maxSurgeCount: Math.max(0, ...considered.map((item) => Number(item.estimatedSurgeCount || 0))),
    dataGap, statuses, statusText: statuses.join(" · "), threshold,
    recentHistory: considered.slice(-7).map((item) => ({ date: item.latestDataDate, estimatedSurgeCount: Number(item.estimatedSurgeCount || 0) })) };
}

function historyProtectionSignal(record, threshold) {
  const state = deriveSurgeState(record, threshold);
  if (!state) return null;
  const latestDate = record.history.filter((item) => item.mode === "instant").map((item) => item.latestDataDate).sort().at(-1);
  const ageDays = latestDate ? dateDiffDays(latestDate, new Date().toISOString().slice(0, 10)) : 999;
  const passed = state.latestSurgeCount >= threshold;
  const strengthening = state.previousSurgeCount !== null && state.latestSurgeCount > state.previousSurgeCount;
  const protectionPriority = (passed && ageDays <= 1 ? 1000 : 0) + (state.consecutiveSurgeDays >= 2 ? 600 : 0)
    + (passed && ageDays <= 7 ? 300 : 0) + (strengthening ? 150 : 0) + (state.statuses.includes("재급등") ? 100 : 0);
  return { estimatedSurgeCount: state.latestSurgeCount, latestDataDate: latestDate, protectionPriority,
    consecutiveSurgeDays: state.consecutiveSurgeDays, statusText: state.statusText };
}

module.exports = { readSurgeHistory, writeSurgeHistory, upsertInstantHistory, deriveSurgeState, historyProtectionSignal,
  normalizeKeyword, shardNumber, CALCULATION_VERSION, SHARD_COUNT, MANIFEST_KEY };
