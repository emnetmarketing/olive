const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeInstantHistory } = require("../netlify/functions/instant-history");
const history = require("../netlify/functions/surge-history-cache");

const copy = value => value === undefined ? undefined : structuredClone(value);
const job = { jobId: "old-frozen-job", mode: "instant", state: "running", createdAt: "2026-10-16T11:00:00.000Z" };
const lease = { jobId: job.jobId, fence: 10, token: "fixture-owner" };
const observation = (keyword, date, count = 420) => ({ keyword, latestDataDate: date, estimatedSurgeCount: count,
  estimatedBaseline: 100, estimatedLatest: 520, monthlySearches: 3000 });

function fixture() {
  const data = new Map(), writes = []; let revision = 0, hook = null;
  const seed = (key, value) => data.set(key, { data: copy(value), etag: `"${++revision}"` });
  const store = {
    async get(key) { return copy(data.get(key)?.data); },
    async getWithMetadata(key) { return copy(data.get(key)); },
    async setJSON(key, value, options = {}) {
      if (hook) await hook(key, value, options);
      const current = data.get(key);
      if (options.onlyIfNew && current || options.onlyIfMatch && current?.etag !== options.onlyIfMatch) return { modified: false };
      seed(key, value); writes.push({ key, options, value: copy(value) }); return { modified: true };
    },
  };
  const install = (records, id = "legacy", generation) => {
    const buckets = Array.from({ length: history.SHARD_COUNT }, () => []);
    for (const record of records.values()) buckets[history.shardNumber(record.normalizedKeyword)].push(record);
    const shardKeys = buckets.map((items, index) => { const key = `surge-history/shards/${id}/${index}`; seed(key, { items }); return key; });
    const manifest = { version: 1, calculationVersion: 1, shardCount: 16, recordCount: records.size, shardKeys,
      ...(generation ? { generation } : {}) };
    seed(history.MANIFEST_KEY, manifest); return manifest;
  };
  const read = async () => {
    const manifest = await store.get(history.MANIFEST_KEY); const records = new Map();
    for (const key of manifest?.shardKeys || []) for (const record of (await store.get(key)).items) records.set(record.normalizedKeyword, record);
    return records;
  };
  return { data, writes, store, seed, install, read, setHook: value => { hook = value; },
    options: { store, assertWorker: async () => copy(job), now: () => Date.parse("2026-10-27T03:00:00.000Z") } };
}

test("old Instant completion merges history without replacing newer same-date observations or unrelated keywords", async () => {
  const f = fixture(), initial = new Map();
  history.upsertInstantHistory(initial, [observation("shared", "2026-10-15", 900), observation("latest-only", "2026-10-26", 1200)],
    "newer-job", "2026-10-27T01:00:00.000Z");
  const newerGeneration = Date.parse("2026-10-27T01:00:00.000Z");
  f.install(initial, "newer", newerGeneration);
  const observations = [observation("shared", "2026-10-15", 1), observation("old-only", "2026-10-15", 333.7)];
  const manifest = await mergeInstantHistory(lease, observations, f.options);
  const actual = await f.read(), expected = copy(initial);
  history.upsertInstantHistory(expected, observations, job.jobId, job.createdAt);
  assert.deepEqual(actual, expected);
  assert.equal(actual.get("shared").history[0].estimatedSurgeCount, 900);
  assert.equal(actual.get("oldonly").history[0].estimatedSurgeCount, 334);
  assert.equal(manifest.generation, newerGeneration);
  assert.equal(manifest.mergeSourceJobId, job.jobId);
  assert.ok(manifest.shardKeys.every(key => key.startsWith(`surge-history/shards/instant-v1/${job.jobId}/10/`)));
  assert.ok(f.writes.filter(write => write.key !== history.MANIFEST_KEY).every(write => write.options.onlyIfNew === true));
  assert.ok(f.writes.find(write => write.key === history.MANIFEST_KEY).options.onlyIfMatch);
});

test("manifest CAS collision retries from latest complete history and preserves a concurrent writer", async () => {
  const f = fixture(), first = new Map();
  history.upsertInstantHistory(first, [observation("initial", "2026-10-14")], "first", "2026-10-15T00:00:00Z");
  f.install(first); let collided = false;
  f.setHook(async key => {
    if (key !== history.MANIFEST_KEY || collided) return;
    collided = true;
    const current = new Map(first);
    history.upsertInstantHistory(current, [observation("concurrent", "2026-10-26", 901)], "concurrent-job", "2026-10-27T02:00:00Z");
    f.install(current, "concurrent", Date.parse("2026-10-27T02:00:00Z"));
  });
  await mergeInstantHistory(lease, [observation("resumed", "2026-10-15")], f.options);
  const saved = await f.read();
  assert.equal(collided, true); assert.equal(saved.size, 3);
  assert.equal(saved.get("concurrent").history[0].estimatedSurgeCount, 901);
  assert.equal(f.writes.filter(write => write.key === history.MANIFEST_KEY).length, 1);
  assert.equal(f.writes.filter(write => write.key !== history.MANIFEST_KEY).length, 32);
});

test("repeated same Job merge does not duplicate observations and never overwrites immutable shards", async () => {
  const f = fixture(), input = [observation("same", "2026-10-15")];
  const first = await mergeInstantHistory(lease, input, f.options);
  const second = await mergeInstantHistory(lease, input, f.options);
  assert.equal((await f.read()).get("same").history.length, 1);
  assert.ok(first.shardKeys.every(key => !second.shardKeys.includes(key)));
  assert.ok(first.shardKeys.every(key => f.data.has(key)), "previous immutable shards are retained");
});

test("lost worker cannot advance the manifest even if its immutable shards were saved", async () => {
  const f = fixture(); const previous = f.install(new Map()); let checks = 0;
  const options = { ...f.options, assertWorker: async () => {
    if (++checks === 19) throw Object.assign(new Error("worker fence changed"), { code: "INSTANT_WORKER_LOST" });
    return copy(job);
  } };
  await assert.rejects(mergeInstantHistory(lease, [observation("old", "2026-10-15")], options), /worker fence changed/);
  assert.deepEqual(await f.store.get(history.MANIFEST_KEY), previous);
  assert.equal(f.writes.filter(write => write.key === history.MANIFEST_KEY).length, 0);
  assert.equal(f.writes.length, 16);
});

test("failed shard storage retains the previous complete history manifest", async () => {
  const f = fixture(); const previous = f.install(new Map());
  f.setHook(async key => { if (key.includes("/instant-v1/")) throw new Error("fixture storage unavailable"); });
  await assert.rejects(mergeInstantHistory(lease, [observation("new", "2026-10-15")], f.options), /fixture storage unavailable/);
  assert.deepEqual(await f.store.get(history.MANIFEST_KEY), previous); assert.equal(f.writes.length, 0);
});

test("missing existing history shard fails closed instead of publishing a truncated copy", async () => {
  const f = fixture(); const previous = f.install(new Map()); f.data.delete(previous.shardKeys[3]);
  await assert.rejects(mergeInstantHistory(lease, [], f.options), { code: "INSTANT_HISTORY_INTEGRITY" });
  assert.deepEqual(await f.store.get(history.MANIFEST_KEY), previous); assert.equal(f.writes.length, 0);
});

test("invalid Job identity or malformed history never writes a new shared manifest", async () => {
  const f = fixture();
  await assert.rejects(mergeInstantHistory(lease, [], { ...f.options, assertWorker: async () => ({ ...job, mode: "period" }) }),
    { code: "INSTANT_HISTORY_IDENTITY" });
  f.seed(history.MANIFEST_KEY, { shardKeys: ["wrong"], recordCount: 0 });
  await assert.rejects(mergeInstantHistory(lease, [], f.options), { code: "INSTANT_HISTORY_INTEGRITY" });
  assert.equal(f.writes.length, 0);
});

test("repeated CAS conflicts stop after a bounded retry without forcing a manifest overwrite", async () => {
  const f = fixture(); f.install(new Map()); let competingWrites = 0;
  f.setHook(async key => {
    if (key === history.MANIFEST_KEY) { competingWrites++; f.install(new Map(), `conflict-${competingWrites}`); }
  });
  await assert.rejects(mergeInstantHistory(lease, [observation("retry", "2026-10-15")], f.options), { code: "INSTANT_HISTORY_CONFLICT" });
  assert.equal(competingWrites, 5);
  assert.equal(f.writes.filter(write => write.key === history.MANIFEST_KEY).length, 0);
  assert.equal((await f.read()).size, 0);
});
