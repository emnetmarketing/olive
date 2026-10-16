const crypto = require("node:crypto");
const { getStore } = require("@netlify/blobs");
const { connectLambda, getCompatibleStore } = require("./blob-store-compat");

// Readers use this commit, never a mixture of independently updated legacy
// pointers. Prepared data is immutable and is not a completed analysis.
const STORE_NAME = "trend-period-publications";
const LATEST_KEY = "latest-v1";
const VERSION = 1;
const MAX_COMMIT_ATTEMPTS = 5;
function connect(event) { if (event?.blobs) connectLambda(event); }
// Published payloads are immutable and hash-verified. Public GETs may observe an
// older complete commit while edge caches propagate; they must never require a
// strong-only transport that legacy Lambda contexts do not provide. Mutations
// use a separate strong store and fail closed if that transport is unavailable.
function store({ writable = false } = {}) {
  return writable ? getCompatibleStore({ name: STORE_NAME, consistency: "strong" }) : getStore(STORE_NAME);
}
function error(code, message) { return Object.assign(new Error(message), { code }); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function digest(value) { return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function receiptKey(jobId) { return `published-jobs/${encodeURIComponent(jobId)}`; }
function strippedCommit(commit) {
  // Keep at most one opposite-kind reference, never a recursively growing
  // chain of prior latest records.
  const { otherKind, previousValid, ...value } = commit;
  return value;
}
function isValidPeriodSnapshot(snapshot) {
  return Number(snapshot?.trendCoveragePct || 0) > 0 && Boolean(snapshot?.latestDataDate);
}
function assertCommit(commit) {
  if (!commit || commit.version !== VERSION || commit.mode !== "period" || commit.state !== "published"
    || !commit.jobId || !Number.isSafeInteger(commit.generation) || !commit.bodyKey || !commit.snapshotKey
    || !commit.bodyHash || !commit.snapshotHash || !commit.publishedAt) {
    throw error("INVALID_PERIOD_COMMIT", "Invalid period publication commit.");
  }
}
async function readCommitted(commit, blobStore) {
  assertCommit(commit);
  const [body, snapshot] = await Promise.all([
    blobStore.get(commit.bodyKey, { type: "json" }),
    blobStore.get(commit.snapshotKey, { type: "json" })
  ]);
  if (!body || !snapshot || digest(body) !== commit.bodyHash || digest(snapshot) !== commit.snapshotHash
    || body.jobId !== commit.jobId || snapshot.jobId !== commit.jobId || body.mode !== "period" || snapshot.mode !== "period") {
    throw error("PERIOD_PUBLICATION_INTEGRITY", "Published period body/snapshot did not pass read verification.");
  }
  return { commit, job: { ...body, state: "completed", currentStage: "completed", progress: 100,
    publicationState: "published", publicationGeneration: commit.generation, publishedAt: commit.publishedAt,
    completedAt: body.calculatedAt || body.completedAt || commit.publishedAt }, snapshot };
}
async function readLatest(options = {}) {
  const blobStore = options.store || store();
  const commit = await blobStore.get(LATEST_KEY, { type: "json" });
  return commit ? readCommitted(commit, blobStore) : null;
}
async function readLatestKind(options = {}) {
  const blobStore = options.store || store();
  const latest = await readLatest({ store: blobStore });
  if (!latest) return null;
  if (Boolean(latest.job.partialAnalysis) === Boolean(options.partial)) return latest;
  if (!latest.commit.otherKind) return null;
  const other = await readCommitted(latest.commit.otherKind, blobStore);
  if (Boolean(other.job.partialAnalysis) !== Boolean(options.partial))
    throw error("PERIOD_PUBLICATION_INTEGRITY", "Period full/partial reference has the wrong result kind.");
  return other;
}
async function readLatestValid(options = {}) {
  const blobStore = options.store || store();
  const latest = await readLatest({ store: blobStore });
  if (!latest || isValidPeriodSnapshot(latest.snapshot)) return latest;
  if (!latest.commit.previousValid) return null;
  const previous = await readCommitted(latest.commit.previousValid, blobStore);
  if (!isValidPeriodSnapshot(previous.snapshot))
    throw error("PERIOD_PUBLICATION_INTEGRITY", "Period valid-snapshot reference is invalid.");
  return previous;
}
async function readPublishedJob(jobId, options = {}) {
  const blobStore = options.store || store();
  const [receipt, latest] = await Promise.all([
    blobStore.get(receiptKey(jobId), { type: "json" }),
    blobStore.get(LATEST_KEY, { type: "json" })
  ]);
  // A crash after the single latest commit but before the per-job receipt must
  // still expose the correctly published result without writing during a GET.
  const candidates = [receipt, latest, latest?.otherKind, latest?.previousValid].filter(commit => commit?.jobId === jobId)
    .sort((a, b) => b.generation - a.generation);
  return candidates.length ? readCommitted(candidates[0], blobStore) : null;
}

async function publishPeriod(input, options = {}) {
  const { job, snapshot, generation, leaseToken } = input || {};
  const metadataFields = ["latestDataDate", "trendCoveragePct", "surgeThreshold", "matchThreshold"];
  const rowFields = ["estimatedSurgeCount", "peakDailyLift", "peakRelativeLiftPct", "marketConfidenceScore", "periodMarketConfidenceScore"];
  const conflictingMetadata = metadataFields.some(key => job?.[key] !== undefined && snapshot?.[key] !== undefined
    && job[key] !== snapshot[key]) || Boolean(job?.partialAnalysis) !== Boolean(snapshot?.partialAnalysis);
  if (job?.mode !== "period" || snapshot?.mode !== "period" || !job.jobId || snapshot.jobId !== job.jobId
    || !Array.isArray(job.results) || !Array.isArray(snapshot.items)
    || !Number.isSafeInteger(generation) || generation < 0
    || snapshot.startDate !== job.startDate || snapshot.endDate !== job.endDate
    || snapshot.queryStartDate !== job.queryStartDate || snapshot.items.length !== job.results.length
    || job.resultCount != null && Number(job.resultCount) !== job.results.length || conflictingMetadata
    || snapshot.items.some((item, index) => item.keyword !== job.results[index].keyword || item.resultType !== job.results[index].resultType
      || rowFields.some(key => item[key] !== undefined && job.results[index][key] !== undefined && item[key] !== job.results[index][key]))) {
    throw error("INVALID_PERIOD_PUBLICATION", "Period publication requires matching, complete result and snapshot payloads.");
  }
  if (typeof options.assertLease !== "function") throw error("PERIOD_LEASE_REQUIRED", "A current worker lease must guard period publication.");
  const blobStore = options.store || store({ writable: true });
  const guard = async (phase) => {
    if (await options.assertLease({ jobId: job.jobId, generation, leaseToken, phase }) === false)
      throw error("PERIOD_LEASE_LOST", "Period publication worker no longer owns its lease.");
  };
  const body = copy({ ...job, state: "calculated", currentStage: "publishing", progress: 99, publicationState: "prepared" });
  const preparedSnapshot = copy(snapshot);
  const bodyHash = digest(body); const snapshotHash = digest(preparedSnapshot);
  const prefix = `prepared/${encodeURIComponent(job.jobId)}/${generation}`;
  const bodyKey = `${prefix}/body-${bodyHash}`;
  const snapshotKey = `${prefix}/snapshot-${snapshotHash}`;
  const manifest = { version: VERSION, jobId: job.jobId, mode: "period", generation, state: "published", partialAnalysis: Boolean(job.partialAnalysis),
    bodyKey, snapshotKey, bodyHash, snapshotHash,
    startDate: job.startDate, endDate: job.endDate, queryStartDate: job.queryStartDate };
  const existingReceipt = await blobStore.get(receiptKey(job.jobId), { type: "json", consistency: "strong" });
  if (existingReceipt?.generation === generation) {
    if (existingReceipt.bodyHash !== bodyHash || existingReceipt.snapshotHash !== snapshotHash)
      throw error("PERIOD_GENERATION_CONFLICT", "Period Job generation has conflicting content.");
    const published = await readCommitted(existingReceipt, blobStore);
    const latest = await blobStore.get(LATEST_KEY, { type: "json", consistency: "strong" });
    await guard("publication-complete");
    return { ...published, alreadyPublished: true,
      publishedAsLatest: latest?.jobId === job.jobId && latest?.generation === generation };
  }
  async function putVerified(key, value, expectedHash, phase) {
    await guard(phase);
    await blobStore.setJSON(key, value, { onlyIfNew: true });
    const saved = await blobStore.get(key, { type: "json", consistency: "strong" });
    if (!saved || digest(saved) !== expectedHash) throw error("PERIOD_PREPARE_VERIFY_FAILED", `Period ${phase} could not be read back intact.`);
  }
  await putVerified(bodyKey, body, bodyHash, "prepare-body");
  await putVerified(snapshotKey, preparedSnapshot, snapshotHash, "prepare-snapshot");
  const publishedAt = (options.now ? options.now() : new Date()).toISOString();
  let committed = null; let publishedAsLatest = false; let alreadyPublished = false;
  for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
    const current = await blobStore.getWithMetadata(LATEST_KEY, { type: "json", consistency: "strong" });
    const previous = current?.data || null;
    if (previous) {
      assertCommit(previous);
      if (previous.generation === generation) {
        if (previous.jobId !== job.jobId || previous.bodyHash !== bodyHash || previous.snapshotHash !== snapshotHash)
          throw error("PERIOD_GENERATION_CONFLICT", "A publication generation cannot commit different results.");
        committed = previous; publishedAsLatest = true; alreadyPublished = true; break;
      }
      if (previous.generation > generation) {
        // A historical result can be published to its own Job without replacing
        // a newer canonical result. No legacy/global/instant pointer is written.
        committed = { ...manifest, publishedAt }; break;
      }
    }
    await guard("commit-latest");
    let otherKind = null; let previousValid = null;
    if (previous) {
      const previousResult = await readCommitted(previous, blobStore);
      otherKind = Boolean(previousResult.job.partialAnalysis) !== Boolean(job.partialAnalysis)
        ? strippedCommit(previous) : previous.otherKind ? strippedCommit(previous.otherKind) : null;
      if (!isValidPeriodSnapshot(preparedSnapshot)) previousValid = isValidPeriodSnapshot(previousResult.snapshot)
        ? strippedCommit(previous) : previous.previousValid ? strippedCommit(previous.previousValid) : null;
    }
    const next = { ...manifest, publishedAt, ...(otherKind ? { otherKind } : {}), ...(previousValid ? { previousValid } : {}) };
    const condition = current?.etag ? { onlyIfMatch: current.etag } : { onlyIfNew: true };
    // Reading a previous large result may outlive this worker's lease. Recheck
    // immediately before the conditional publication, not only before reads.
    await guard("commit-latest-write");
    const result = await blobStore.setJSON(LATEST_KEY, next, condition);
    if (result?.modified) { committed = next; publishedAsLatest = true; break; }
  }
  if (!committed) throw error("PERIOD_COMMIT_CONFLICT", "Period publication changed concurrently; retry the saved publication payload.");
  // Re-read the canonical record and its content before reporting completion.
  if (publishedAsLatest) {
    const confirmed = await blobStore.get(LATEST_KEY, { type: "json", consistency: "strong" });
    if (!confirmed || confirmed.generation < generation)
      throw error("PERIOD_COMMIT_VERIFY_FAILED", "Period latest commit was not visible after publication.");
    if (confirmed.generation === generation && digest(confirmed) !== digest(committed))
      throw error("PERIOD_GENERATION_CONFLICT", "Period latest commit changed within the same generation.");
    if (confirmed.generation > generation) publishedAsLatest = false;
  }
  const published = await readCommitted(committed, blobStore);
  // Receipts let exact-Job dashboard/Excel reads survive later publications.
  // A receipt failure does not invalidate the already committed latest result.
  const key = receiptKey(job.jobId);
  let receiptSaved = false;
  for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
    const current = await blobStore.getWithMetadata(key, { type: "json", consistency: "strong" });
    const previous = current?.data || null;
    if (previous?.generation > generation) { receiptSaved = true; break; }
    if (previous?.generation === generation) {
      if (previous.bodyHash !== bodyHash || previous.snapshotHash !== snapshotHash)
        throw error("PERIOD_GENERATION_CONFLICT", "Period Job generation has conflicting content.");
      receiptSaved = true; break;
    }
    await guard("commit-receipt");
    const result = await blobStore.setJSON(key, committed, current?.etag ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
    if (result?.modified) { receiptSaved = true; break; }
  }
  if (!receiptSaved) throw error("PERIOD_RECEIPT_CONFLICT", "Period publication receipt changed concurrently.");
  const verifiedReceipt = await blobStore.get(key, { type: "json", consistency: "strong" });
  if (!verifiedReceipt || verifiedReceipt.generation < generation)
    throw error("PERIOD_RECEIPT_VERIFY_FAILED", "Period publication receipt was not visible after storage.");
  if (verifiedReceipt.generation === generation) await readCommitted(verifiedReceipt, blobStore);
  await guard("publication-complete");
  return { ...published, publishedAsLatest, alreadyPublished };
}

module.exports = { connect, store, publishPeriod, readLatest, readLatestKind, readLatestValid, readPublishedJob, receiptKey, digest,
  STORE_NAME, LATEST_KEY, VERSION, MAX_COMMIT_ATTEMPTS };
