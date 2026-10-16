const test = require("node:test");
const assert = require("node:assert/strict");
const publication = require("../netlify/functions/period-publication");

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
function memoryStore() {
  const records = new Map(); let revision = 0;
  return {
    records, writes: [], before: null, after: null,
    async get(key) { await this.before?.("get", key); return clone(records.get(key)?.data || null); },
    async getWithMetadata(key) { await this.before?.("metadata", key); return clone(records.get(key) || null); },
    async setJSON(key, value, condition = {}) {
      await this.before?.("set", key, value);
      const previous = records.get(key);
      if (condition.onlyIfNew && previous || condition.onlyIfMatch && condition.onlyIfMatch !== previous?.etag) return { modified: false };
      records.set(key, { data: clone(value), etag: String(++revision) });
      this.writes.push(key);
      await this.after?.("set", key, value);
      return { modified: true };
    }
  };
}
function input(jobId = "period-1", generation = 100) {
  const results = [{ keyword: "fixture-a", resultType: "product_match", estimatedSurgeCount: 1234,
    peakRelativeLiftPct: 220, periodMarketConfidenceScore: 66, periodMarketConfidenceGrade: "medium",
    periodMarketEvidence: { youtube: { status: "no_data" } } }];
  const job = { jobId, mode: "period", state: "running", startDate: "2026-10-01", endDate: "2026-10-16",
    queryStartDate: "2026-09-16", calculatedAt: "2026-10-16T07:00:00.000Z", resultCount: 1,
    trendAvailableCount: 5000, analyzedCandidateCount: 5000, trendCoveragePct: 100,
    latestDataDate: "2026-10-15", results };
  const snapshot = { jobId, mode: "period", startDate: job.startDate, endDate: job.endDate,
    queryStartDate: job.queryStartDate, latestDataDate: job.latestDataDate, trendCoveragePct: 100,
    items: results.map(({ keyword, resultType, estimatedSurgeCount }) => ({ keyword, resultType, estimatedSurgeCount })) };
  return { job, snapshot, generation, leaseToken: "lease-1" };
}
const options = (store, extra = {}) => ({ store, assertLease: async () => true,
  now: () => new Date("2026-10-16T07:01:00.000Z"), ...extra });

test("period publication commits one matching result body and snapshot before reporting completed", async () => {
  const store = memoryStore(); const source = input();
  const result = await publication.publishPeriod(source, options(store));
  assert.equal(result.job.state, "completed");
  assert.equal(result.job.publicationState, "published");
  assert.deepEqual(result.job.results, source.job.results);
  assert.deepEqual(result.snapshot, source.snapshot);
  const read = await publication.readLatest({ store });
  assert.equal(read.job.jobId, source.job.jobId);
  assert.equal(read.snapshot.jobId, read.job.jobId);
  assert.equal(store.records.get(result.commit.bodyKey).data.state, "calculated");
  assert.equal(store.writes.indexOf(publication.LATEST_KEY), 2);
});

test("same generation and payload is idempotent and preserves publication timestamp", async () => {
  const store = memoryStore(); const source = input();
  const first = await publication.publishPeriod(source, options(store));
  const writes = store.writes.length;
  const second = await publication.publishPeriod(source, options(store, { now: () => new Date("2026-10-17T01:00:00Z") }));
  assert.equal(second.alreadyPublished, true);
  assert.equal(second.commit.publishedAt, first.commit.publishedAt);
  assert.equal(store.writes.length, writes);
});

test("mismatched period metadata or row order cannot publish", async () => {
  for (const mutate of [
    (value) => { value.snapshot.endDate = "2026-10-15"; },
    (value) => { value.snapshot.items[0].keyword = "different-keyword"; },
    (value) => { value.job.resultCount = 2; },
    (value) => { value.snapshot.mode = "instant"; }
  ]) {
    const store = memoryStore(); const source = input(); mutate(source);
    await assert.rejects(publication.publishPeriod(source, options(store)), { code: "INVALID_PERIOD_PUBLICATION" });
    assert.equal(store.writes.length, 0);
  }
});

test("publication requires an explicit worker lease verifier", async () => {
  const store = memoryStore();
  await assert.rejects(publication.publishPeriod(input(), { store }), { code: "PERIOD_LEASE_REQUIRED" });
  assert.equal(store.writes.length, 0);
});

test("lost lease before commit preserves the previously published period", async () => {
  const store = memoryStore(); await publication.publishPeriod(input("previous", 99), options(store));
  await assert.rejects(publication.publishPeriod(input(), options(store, {
    assertLease: async ({ phase }) => phase !== "commit-latest"
  })), { code: "PERIOD_LEASE_LOST" });
  assert.equal((await publication.readLatest({ store })).job.jobId, "previous");
  assert.equal(await publication.readPublishedJob("period-1", { store }), null);
});

for (const phase of ["body-write", "body-read", "snapshot-write", "snapshot-read", "latest-read", "latest-write"]) {
  test(`failure at ${phase} preserves the previous valid canonical result`, async () => {
    const store = memoryStore(); await publication.publishPeriod(input("previous", 99), options(store));
    let fired = false;
    store.before = async (op, key) => {
      const target = key.includes("/period-1/");
      const matches = phase === "body-write" && op === "set" && target && key.includes("/body-")
        || phase === "body-read" && op === "get" && target && key.includes("/body-")
        || phase === "snapshot-write" && op === "set" && target && key.includes("/snapshot-")
        || phase === "snapshot-read" && op === "get" && target && key.includes("/snapshot-")
        || phase === "latest-read" && op === "metadata" && key === publication.LATEST_KEY
        || phase === "latest-write" && op === "set" && key === publication.LATEST_KEY;
      if (!fired && matches) { fired = true; throw new Error(`injected ${phase}`); }
    };
    await assert.rejects(publication.publishPeriod(input(), options(store)), /injected/);
    store.before = null;
    assert.equal(fired, true);
    assert.equal((await publication.readLatest({ store })).job.jobId, "previous");
    assert.equal(await publication.readPublishedJob("period-1", { store }), null);
  });
}

test("a corrupt prepared body is rejected before latest promotion", async () => {
  const store = memoryStore(); await publication.publishPeriod(input("previous", 99), options(store));
  store.after = async (_, key) => {
    if (key.includes("/period-1/") && key.includes("/body-")) store.records.get(key).data.results[0].estimatedSurgeCount = -1;
  };
  await assert.rejects(publication.publishPeriod(input(), options(store)), { code: "PERIOD_PREPARE_VERIFY_FAILED" });
  assert.equal((await publication.readLatest({ store })).job.jobId, "previous");
});

test("receipt failure after canonical commit remains readable and is retryable without recalculation", async () => {
  const store = memoryStore(); const source = input();
  store.before = async (op, key) => { if (op === "set" && key === publication.receiptKey(source.job.jobId)) throw new Error("receipt outage"); };
  await assert.rejects(publication.publishPeriod(source, options(store)), /receipt outage/);
  const published = await publication.readPublishedJob(source.job.jobId, { store });
  assert.deepEqual(published.job.results, source.job.results);
  assert.equal((await publication.readLatest({ store })).job.jobId, source.job.jobId);
  store.before = null;
  const recovered = await publication.publishPeriod(source, options(store));
  assert.equal(recovered.alreadyPublished, true);
  assert.deepEqual(recovered.job.results, source.job.results);
});

test("a response failure after successful commit does not expose mixed data", async () => {
  const store = memoryStore(); const source = input(); let once = true;
  store.after = async (_, key) => { if (once && key === publication.LATEST_KEY) { once = false; throw new Error("response lost"); } };
  await assert.rejects(publication.publishPeriod(source, options(store)), /response lost/);
  const result = await publication.readLatest({ store });
  assert.equal(result.job.jobId, result.snapshot.jobId);
  assert.deepEqual(result.job.results, source.job.results);
  assert.equal((await publication.publishPeriod(source, options(store))).alreadyPublished, true);
});

test("newer same-Job canonical commit is read even if its old receipt remains after a failure", async () => {
  const store = memoryStore(); await publication.publishPeriod(input(), options(store));
  const newer = input("period-1", 101);
  newer.job.results[0].estimatedSurgeCount = 1500; newer.snapshot.items[0].estimatedSurgeCount = 1500;
  store.before = async (op, key) => { if (op === "set" && key === publication.receiptKey("period-1")) throw new Error("receipt unavailable"); };
  await assert.rejects(publication.publishPeriod(newer, options(store)), /receipt unavailable/);
  assert.equal((await publication.readPublishedJob("period-1", { store })).job.results[0].estimatedSurgeCount, 1500);
});

test("a failed post-commit read is repaired by idempotent publication without changing the saved rows", async () => {
  const store = memoryStore(); let committed = false; let injected = false;
  store.after = async (_, key) => { if (key === publication.LATEST_KEY) committed = true; };
  store.before = async (op, key) => {
    if (committed && !injected && op === "get" && key === publication.LATEST_KEY) {
      injected = true; throw new Error("commit verification temporarily unavailable");
    }
  };
  await assert.rejects(publication.publishPeriod(input(), options(store)), /commit verification/);
  assert.equal((await publication.publishPeriod(input(), options(store))).alreadyPublished, true);
  assert.equal((await publication.readLatest({ store })).job.results[0].estimatedSurgeCount, 1234);
});

test("older generation can publish its own Job but cannot replace newer latest", async () => {
  const store = memoryStore(); await publication.publishPeriod(input("newer", 200), options(store));
  const older = await publication.publishPeriod(input("older", 100), options(store));
  assert.equal(older.publishedAsLatest, false);
  assert.equal((await publication.readLatest({ store })).job.jobId, "newer");
  assert.equal((await publication.readPublishedJob("older", { store })).job.jobId, "older");
});

test("equal generation with a different Job fails rather than overwriting", async () => {
  const store = memoryStore(); await publication.publishPeriod(input("first", 100), options(store));
  await assert.rejects(publication.publishPeriod(input("second", 100), options(store)), { code: "PERIOD_GENERATION_CONFLICT" });
  assert.equal((await publication.readLatest({ store })).job.jobId, "first");
});

test("equal generation cannot silently change an already published result", async () => {
  const store = memoryStore(); await publication.publishPeriod(input(), options(store));
  const changed = input(); changed.job.results[0].estimatedSurgeCount += 1;
  await assert.rejects(publication.publishPeriod(changed, options(store)), { code: "PERIOD_GENERATION_CONFLICT" });
  assert.equal((await publication.readLatest({ store })).job.results[0].estimatedSurgeCount, 1234);
});

test("CAS collision retries and does not overwrite a concurrent newer publication", async () => {
  const store = memoryStore(); await publication.publishPeriod(input("initial", 50), options(store));
  let raced = false;
  store.before = async (op, key, value) => {
    if (!raced && op === "set" && key === publication.LATEST_KEY && value.jobId === "older") {
      raced = true;
      await publication.publishPeriod(input("concurrent-newer", 200), options(store));
    }
  };
  const result = await publication.publishPeriod(input("older", 100), options(store));
  assert.equal(raced, true);
  assert.equal(result.publishedAsLatest, false);
  assert.equal((await publication.readLatest({ store })).job.jobId, "concurrent-newer");
});

test("exact Job receipt preserves dashboard and Excel source after another period is published", async () => {
  const store = memoryStore(); await publication.publishPeriod(input("first", 100), options(store));
  const second = input("second", 200); second.job.results[0].keyword = "other"; second.snapshot.items[0].keyword = "other";
  await publication.publishPeriod(second, options(store));
  const first = await publication.readPublishedJob("first", { store });
  assert.equal(first.job.results[0].keyword, "fixture-a");
  assert.equal((await publication.readLatest({ store })).job.results[0].keyword, "other");
});

test("publication never touches instant, legacy latest, cache, quota or Early Signal keys", async () => {
  const store = memoryStore();
  await publication.publishPeriod(input(), options(store));
  assert.ok(store.writes.every((key) => key === publication.LATEST_KEY || key.startsWith("prepared/") || key.startsWith("published-jobs/")));
  assert.equal(publication.STORE_NAME, "trend-period-publications");
  assert.equal(store.writes.some((key) => /instant|last-success|last-partial|latest-valid|quota|early-signal|searchWindows/.test(key)), false);
});

test("read verification refuses corrupted committed content without any writes", async () => {
  const store = memoryStore(); const result = await publication.publishPeriod(input(), options(store));
  store.records.get(result.commit.snapshotKey).data.items[0].keyword = "corrupt";
  const writes = store.writes.length;
  await assert.rejects(publication.readLatest({ store }), { code: "PERIOD_PUBLICATION_INTEGRITY" });
  await assert.rejects(publication.readPublishedJob("period-1", { store }), { code: "PERIOD_PUBLICATION_INTEGRITY" });
  assert.equal(store.writes.length, writes);
});

test("publication and recovery preserve period evidence and confidence exactly", async () => {
  const store = memoryStore(); const source = input();
  const before = clone(source.job.results);
  await publication.publishPeriod(source, options(store));
  assert.deepEqual((await publication.readLatest({ store })).job.results, before);
  assert.deepEqual(source.job.results, before);
  assert.equal(source.job.state, "running");
});

test("single latest manifest retains bounded full and partial result references", async () => {
  const store = memoryStore();
  const first = input("full-a", 100);
  const partial = input("partial-b", 200); partial.job.partialAnalysis = true; partial.snapshot.partialAnalysis = true;
  await publication.publishPeriod(first, options(store));
  await publication.publishPeriod(partial, options(store));
  assert.equal((await publication.readLatest({ store })).job.jobId, "partial-b");
  assert.equal((await publication.readLatestKind({ store, partial: false })).job.jobId, "full-a");
  assert.equal((await publication.readLatestKind({ store, partial: true })).job.jobId, "partial-b");
  await publication.publishPeriod(input("full-c", 300), options(store));
  await publication.publishPeriod(input("full-d", 400), options(store));
  const latest = await publication.readLatest({ store });
  assert.equal(latest.commit.otherKind.jobId, "partial-b");
  assert.equal(latest.commit.otherKind.otherKind, undefined);
  assert.equal((await publication.readLatestKind({ store, partial: false })).job.jobId, "full-d");
  assert.equal((await publication.readLatestKind({ store, partial: true })).job.jobId, "partial-b");
  assert.deepEqual((await publication.readPublishedJob("full-a", { store })).job.results, first.job.results);
});

test("opposite-kind reference protects an exact Job even after its receipt write failed", async () => {
  const store = memoryStore();
  store.before = async (op, key) => { if (op === "set" && key === publication.receiptKey("full-a")) throw Error("receipt failure"); };
  await assert.rejects(publication.publishPeriod(input("full-a", 100), options(store)), /receipt failure/);
  store.before = null;
  const partial = input("partial-b", 200); partial.job.partialAnalysis = true; partial.snapshot.partialAnalysis = true;
  await publication.publishPeriod(partial, options(store));
  assert.equal((await publication.readPublishedJob("full-a", { store })).job.jobId, "full-a");
  assert.equal((await publication.readLatestKind({ store, partial: false })).job.jobId, "full-a");
});

test("corrupt opposite-kind data is rejected and cannot appear as a completed last-full result", async () => {
  const store = memoryStore();
  const first = await publication.publishPeriod(input("full-a", 100), options(store));
  const partial = input("partial-b", 200); partial.job.partialAnalysis = true; partial.snapshot.partialAnalysis = true;
  await publication.publishPeriod(partial, options(store));
  store.records.get(first.commit.bodyKey).data.results[0].keyword = "corrupt";
  await assert.rejects(publication.readLatestKind({ store, partial: false }), { code: "PERIOD_PUBLICATION_INTEGRITY" });
  assert.equal((await publication.readLatestKind({ store, partial: true })).job.jobId, "partial-b");
});

test("zero-coverage publications preserve the previous valid snapshot with bounded references", async () => {
  const store = memoryStore();
  await publication.publishPeriod(input("full-valid", 100), options(store));
  const partial = input("partial-valid", 200); partial.job.partialAnalysis = true; partial.snapshot.partialAnalysis = true;
  partial.job.trendCoveragePct = partial.snapshot.trendCoveragePct = 60;
  await publication.publishPeriod(partial, options(store));
  for (const generation of [300, 400]) {
    const empty = input(`zero-${generation}`, generation);
    empty.job.partialAnalysis = empty.snapshot.partialAnalysis = true;
    empty.job.trendCoveragePct = empty.snapshot.trendCoveragePct = 0;
    empty.job.latestDataDate = empty.snapshot.latestDataDate = null;
    await publication.publishPeriod(empty, options(store));
  }
  const latest = await publication.readLatest({ store });
  assert.equal(latest.job.jobId, "zero-400");
  assert.equal((await publication.readLatestValid({ store })).job.jobId, "partial-valid");
  assert.equal((await publication.readLatestKind({ store, partial: false })).job.jobId, "full-valid");
  assert.equal(latest.commit.otherKind.otherKind, undefined);
  assert.equal(latest.commit.otherKind.previousValid, undefined);
  assert.equal(latest.commit.previousValid.otherKind, undefined);
  assert.equal(latest.commit.previousValid.previousValid, undefined);
});

test("an initial zero-coverage result is readable as analysis but never as a valid snapshot", async () => {
  const store = memoryStore(); const empty = input();
  empty.job.trendCoveragePct = empty.snapshot.trendCoveragePct = 0;
  await publication.publishPeriod(empty, options(store));
  assert.equal((await publication.readLatest({ store })).job.jobId, empty.job.jobId);
  assert.equal(await publication.readLatestValid({ store }), null);
});
