const { connectLambda, getStore } = require("@netlify/blobs");

const STORE_NAME = "market-discovery-history";
const KEY = "history-v1";

function connect(event) { if (event?.blobs) connectLambda(event); }
function store() { return getStore(STORE_NAME); }
async function readHistory() { return await store().get(KEY, { type: "json" }).catch(() => null) || { version: 1, items: [] }; }
async function writeHistory(value) { await store().setJSON(KEY, value); return value; }

function mergeHistory(previous, discovered, activeKeys, now = new Date().toISOString()) {
  const records = new Map((previous?.items || []).map((item) => [item.normalizedKeyword, { ...item }]));
  for (const item of discovered || []) {
    if (!item?.normalizedKeyword) continue;
    const old = records.get(item.normalizedKeyword) || {};
    records.set(item.normalizedKeyword, {
      ...old,
      keyword: item.keyword || old.keyword,
      normalizedKeyword: item.normalizedKeyword,
      firstSeenAt: old.firstSeenAt || old.discoveredAt || item.discoveredAt || now,
      lastSeenAt: item.lastSeenAt || now,
      discoverySource: [...new Set([...(old.discoverySource || []), ...(item.discoverySource || [])])],
      relatedBrand: item.relatedBrand || old.relatedBrand || "",
      relatedProductType: item.relatedProductType || old.relatedProductType || "",
      relatedProductLine: item.relatedProductLine || old.relatedProductLine || "",
      sourceConfidence: Math.max(Number(old.sourceConfidence || 0), Number(item.sourceConfidence || 0)),
      lastActiveAt: activeKeys.has(item.normalizedKeyword) ? now : old.lastActiveAt || null,
      active: activeKeys.has(item.normalizedKeyword),
    });
  }
  for (const [key, record] of records) if (!activeKeys.has(key)) records.set(key, { ...record, active: false });
  return { version: 1, updatedAt: now, items: [...records.values()] };
}

function restoreHistory(items, history) {
  const records = new Map((history?.items || []).map((item) => [item.normalizedKeyword, item]));
  return (items || []).map((item) => {
    const old = records.get(item.normalizedKeyword);
    if (!old) return item;
    return { ...item, discoveredAt: old.firstSeenAt || item.discoveredAt,
      discoverySource: [...new Set([...(old.discoverySource || []), ...(item.discoverySource || [])])],
      reappeared: !old.active, previousLastSeenAt: old.lastSeenAt || null };
  });
}

function mergeSignalHistory(previous, rows, analyzedAt = new Date().toISOString()) {
  const records = new Map((previous?.items || []).map((item) => [item.normalizedKeyword, { ...item }]));
  for (const row of rows || []) {
    const normalizedKeyword = String(row.normalizedKeyword || row.keyword || "").normalize("NFC").toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
    if (!normalizedKeyword) continue;
    const old = records.get(normalizedKeyword) || { keyword: row.keyword, normalizedKeyword, firstSeenAt: analyzedAt, discoverySource: [] };
    records.set(normalizedKeyword, { ...old, everSurged: true, lastTrendSignalAt: analyzedAt,
      lastResultType: row.resultType || old.lastResultType || null,
      lastEstimatedSurgeCount: row.estimatedSurgeCount ?? old.lastEstimatedSurgeCount ?? null,
      relatedBrand: row.relatedBrand || row.match?.item?.brand || old.relatedBrand || "",
      relatedProduct: row.relatedProduct || row.match?.item?.product || old.relatedProduct || "" });
  }
  return { version: 1, updatedAt: analyzedAt, items: [...records.values()] };
}

module.exports = { connect, readHistory, writeHistory, mergeHistory, restoreHistory, mergeSignalHistory, STORE_NAME, KEY };
