// Preserve concurrent/newer shared history while completing a frozen Instant
// Job. Calculations still use the established upsert formula and Job timestamp.
const crypto = require("node:crypto");
const { getCompatibleStore } = require("./blob-store-compat");
const { assertInstantWorker } = require("./instant-worker");
const history = require("./surge-history-cache");

const MAX_ATTEMPTS = 5;
const fail = (code, message) => Object.assign(new Error(message), { code });
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function mergeInstantHistory(lease, observations, options = {}) {
  if (!Array.isArray(observations)) throw fail("INSTANT_HISTORY_INPUT", "History observations must be an array.");
  const store = options.store || getCompatibleStore({ name: "trend-analysis", consistency: "strong" });
  const assertWorker = options.assertWorker || (() => assertInstantWorker(lease, { store }));
  const first = await assertWorker();
  if (first?.mode !== "instant" || first.jobId !== lease?.jobId || !Number.isFinite(Date.parse(first.createdAt || "")))
    throw fail("INSTANT_HISTORY_IDENTITY", "A current Instant worker and its original Job date are required.");
  const generation = Date.parse(first.createdAt);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const current = await assertWorker();
    if (current.jobId !== first.jobId || current.createdAt !== first.createdAt)
      throw fail("INSTANT_HISTORY_IDENTITY", "The history Job identity changed.");
    const previous = await store.getWithMetadata(history.MANIFEST_KEY, { type: "json" });
    const manifest = previous?.data;
    if (manifest && (!Array.isArray(manifest.shardKeys) || manifest.shardKeys.length !== history.SHARD_COUNT))
      throw fail("INSTANT_HISTORY_INTEGRITY", "Existing history shard metadata is incomplete; preserve it unchanged.");
    const records = new Map();
    for (const key of manifest?.shardKeys || []) {
      if (typeof key !== "string" || !key.startsWith("surge-history/shards/") || key.includes(".."))
        throw fail("INSTANT_HISTORY_INTEGRITY", "Existing history shard reference is invalid.");
      const shard = await store.get(key, { type: "json" });
      if (!shard || !Array.isArray(shard.items))
        throw fail("INSTANT_HISTORY_INTEGRITY", "An existing history shard is missing; do not replace history with an incomplete copy.");
      for (const record of shard.items) {
        if (!record?.normalizedKeyword || !Array.isArray(record.history) || records.has(record.normalizedKeyword))
          throw fail("INSTANT_HISTORY_INTEGRITY", "Existing history records are invalid or duplicated.");
        records.set(record.normalizedKeyword, record);
      }
    }
    if (manifest?.recordCount != null && Number(manifest.recordCount) !== records.size)
      throw fail("INSTANT_HISTORY_INTEGRITY", "Existing history count does not match its shards.");
    history.upsertInstantHistory(records, observations, first.jobId, first.createdAt);
    const buckets = Array.from({ length: history.SHARD_COUNT }, () => []);
    for (const record of records.values()) buckets[history.shardNumber(record.normalizedKeyword)].push(record);
    const prefix = `surge-history/shards/instant-v1/${encodeURIComponent(first.jobId)}/${lease.fence}/${crypto.randomUUID()}`;
    const shardKeys = buckets.map((_, index) => `${prefix}/${index}`);
    for (const [index, key] of shardKeys.entries()) {
      await assertWorker();
      const value = { items: buckets[index] };
      const result = await store.setJSON(key, value, { onlyIfNew: true });
      if (!result?.modified)
        throw fail("INSTANT_HISTORY_SHARD_CONFLICT", "Immutable history shard already exists; no history pointer was changed.");
      const stored = await store.get(key, { type: "json" });
      if (!stored || digest(stored) !== digest(value))
        throw fail("INSTANT_HISTORY_VERIFY_FAILED", "History shard could not be verified; existing history stays visible.");
    }
    await assertWorker();
    const next = { version: 1, calculationVersion: history.CALCULATION_VERSION,
      updatedAt: new Date(options.now ? options.now() : Date.now()).toISOString(),
      shardCount: history.SHARD_COUNT, recordCount: records.size, shardKeys,
      generation: Math.max(generation, Number(manifest?.generation || 0)),
      mergeSourceJobId: first.jobId, mergeSourceGeneration: generation, mergeWorkerFence: lease.fence };
    const committed = await store.setJSON(history.MANIFEST_KEY, next,
      previous?.etag ? { onlyIfMatch: previous.etag } : { onlyIfNew: true });
    if (committed?.modified) return next;
    // Keep immutable orphan shards; only a CAS-winning complete manifest is
    // visible. Re-read all current shards before merging after a collision.
  }
  throw fail("INSTANT_HISTORY_CONFLICT", "History changed concurrently; saved Job data remains available for retry.");
}

module.exports = { mergeInstantHistory, MAX_ATTEMPTS };
