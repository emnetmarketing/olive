// Durable Instant orchestration. The mathematical candidate operations and
// publication protocol are shared with the established implementation.
const crypto = require("node:crypto");
const artifacts = require("./instant-continuation");
const worker = require("./instant-worker");
const analysis = require("./trend-analysis-cache");
const series = require("./trend-series-cache");
const quota = require("./trend-api-quota");
const history = require("./surge-history-cache");
const policy = require("./instant-collection");
const { getCompatibleStore } = require("./blob-store-compat");
const { digest } = require("./period-publication");
const { publishInstant } = require("./instant-publication");
const { calculateMarketConfidence } = require("./market-confidence");
const scheduler = require("./trend-scheduler-execution-cache");
const dispatch = require("./instant-dispatch");
const executionBudget = require("./instant-execution-budget");
const PART_SIZE = 250;
const SAFE_MS = 4 * 60 * 1000;
const COLLECTION_MS = 3 * 60 * 1000;
const MAX_INVOCATIONS = 128;
const METRICS = ["calls", "retries", "keywords", "http200", "http429", "httpOther"];
const emptyMetrics = () => Object.fromEntries(["searchTrend", "shoppingInsight", "news"].map(type =>
  [type, { calls: 0, retries: 0, keywords: 0, http200: 0, http429: 0, httpOther: 0, exhausted: false }]));
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
const key = history.normalizeKeyword;
const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const memory = () => ({ rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed,
  maxRSS: process.resourceUsage().maxRSS * 1024 });
const error = (code, text) => Object.assign(new Error(text), { code });
const initialState = (job, input) => ({ version: 1, jobId: job.jobId, stage: "collection", cursor: 0,
  calculationCursor: 0, ratioCursor: 0, parts: input.parts, outputs: [], apiMetrics: emptyMetrics(), responsesSaved: 0,
  errors: [], budgetMode: null, inflight: null, fastPath: Boolean(job.fastPath) });

function funnelFor(candidates, eligible, selection, marketCount) {
  const n = predicate => candidates.filter(predicate).length;
  return {
    candidates: { totalCache: candidates.length, beauty: n(c => c.category === "beauty"), health: n(c => c.category === "health"),
      unknown: n(c => c.category === "unknown"), nonDomainExcluded: n(c => c.category === "unknown"),
      monthlyVolumePresent: n(c => c.monthlyTotalSearches != null && Number.isFinite(Number(c.monthlyTotalSearches))),
      monthlyVolumeMissing: n(c => c.monthlyTotalSearches == null || !Number.isFinite(Number(c.monthlyTotalSearches))),
      monthlyVolumeAvailable: n(c => c.monthlyVolumeStatus === "available"), monthlyVolumeUnavailable: n(c => c.monthlyVolumeStatus === "keywordtool-unavailable"),
      monthlyVolumeNotRequested: n(c => c.monthlyVolumeStatus === "not-requested"), monthlyVolumeRequestFailed: n(c => c.monthlyVolumeStatus === "request-failed"),
      monthlyAtOrAboveThreshold: eligible.length, before5000Limit: eligible.length + Number(selection.diagnostics.marketSelected || 0),
      analyzed: selection.selected.length + selection.ratioOnly.length, excludedBy5000Limit: selection.excluded.length,
      marketDiscoveryCache: marketCount, marketDiscoverySelected: selection.diagnostics.marketSelected || 0,
      marketDiscoveryNumeric: selection.diagnostics.marketNumeric || 0, ratioOnlySelected: selection.ratioOnly.length },
    searchTrend: { requested: selection.selected.length + selection.ratioOnly.length, validSeries: 0, emptySeries: 0, apiErrorCandidates: 0 },
    surge: Object.fromEntries(["positive", "from0To99", "from100To199", "from200To299", "from300To499", "from500To999", "atLeast1000", "atLeast100", "atLeast500", "atLeast5000", "atLeast10000", "atUserThreshold"].map(k => [k, 0])),
    matching: Object.fromEntries(["atLeast30", "atLeast40", "atLeast50", "atLeast60", "atLeast70", "atLeast80", "atLeast90", "atUserThreshold"].map(k => [k, 0])),
    resultClassification: { productMatch: 0, brandSignal: 0, domainRelatedSignal: 0, unrelatedOrInsufficient: 0 },
    relativeSurge: { trendEligible: 0, passedWithDomainEvidence: 0, relativeOnlyAdded: 0, productMatch: 0, brandSignal: 0, domainRelatedSignal: 0, insufficientDomainEvidence: 0 },
    lowIntensity: { numericEligible: 0, included: 0, strongProductMatch: 0, brandProductContext: 0, insufficientRelationEvidence: 0 }
  };
}

async function prepare(job, lease, core) {
  // Freeze the large product payload in its own read/write scope. It is not
  // needed while loading source history, candidate shards, or Trend windows.
  const freezeProducts = async () => {
    const product = await require("./search-ad-cache").readCache();
    if (!product?.items?.length) throw error("INSTANT_INPUT_MISSING", "Frozen products are unavailable.");
    return { hash: digest(product), observedAt: product.refreshedAt || product.updatedAt || null,
      ref: await artifacts.writeArtifact(lease, "products", product) };
  };
  const products = await freezeProducts();
  const candidateCache = await require("./keyword-candidate-cache").readCandidateCache();
  const market = await require("./market-discovery-cache").readCache();
  const signals = await analysis.store().get("signals/current", { type: "json" });
  const surge = await history.readSurgeHistory({ sequential: true });
  if (!candidateCache?.candidates?.length) throw error("INSTANT_INPUT_MISSING", "Frozen candidates are unavailable.");
  const prior = new Map((signals?.items || []).map(x => [x.keyword, x]));
  for (const c of candidateCache.candidates) {
    const protectedSignal = history.historyProtectionSignal(surge.records.get(key(c.keyword)), job.surgeThreshold);
    if (protectedSignal) prior.set(c.keyword, protectedSignal);
  }
  const eligible = candidateCache.candidates.filter(c => ["beauty", "health"].includes(c.category) && Number(c.monthlyTotalSearches || 0) >= job.surgeThreshold);
  const selection = core.selectWithMarketDiscovery(eligible, market?.items || [], prior);
  if (!selection.selected.length) throw error("INSTANT_INPUT_MISSING", "No eligible numeric candidates.");
  const now = new Date(job.createdAt);
  const frozenJob = { ...job, targetDataDate: job.targetDataDate || shift(job.endDate, -1) };
  const all = [...selection.selected, ...selection.ratioOnly];
  const allKeys = new Set(all.map(c => key(c.keyword)));
  const cache = await readSeriesStrict(all, job, now);
  const early = await require("./today-early-signal-cache").readCache();
  const previous = await analysis.readLastSuccess("instant");
  const relevantEarly = (early?.history || []).filter(item => allKeys.has(item.normalizedKeyword));
  const tiers = require("./trend-collection-policy");
  const parts = [], queue = [], states = {};
  for (const [partIndex, candidates] of chunks(all, PART_SIZE).entries()) {
    const entries = candidates.map((candidate, offset) => {
      const cached = series.lookup(cache.entries, candidate.keyword, "search", candidate.category, job.queryStartDate, job.endDate, now);
      const freshness = policy.classify(cached.record, cached, frozenJob, now);
      const compatible = freshness.reusable;
      const data = compatible ? cached.record.rawRatioSeries.filter(p => p.period >= job.queryStartDate && p.period <= frozenJob.targetDataDate) : null;
      const shopping = series.lookup(cache.entries, candidate.keyword, "shopping", candidate.category, job.queryStartDate, job.endDate, now);
      candidate.candidateTier = tiers.isDueForCollection(candidate, prior.get(candidate.keyword), cached.record, now).tier;
      states[freshness.state] = (states[freshness.state] || 0) + 1;
      if (!job.fastPath && freshness.shouldFetch) queue.push({ partIndex, offset, keyword: candidate.keyword, category: candidate.category,
        priority: core.trendFetchPriority(candidate, prior) });
      return { candidate, numeric: partIndex * PART_SIZE + offset < selection.selected.length,
        data, shopping: shopping.state === "hit" ? shopping.series : [], sourceRecord: cached.record ? {
          fetchedAt: cached.record.fetchedAt, requestStartDate: cached.record.requestStartDate, requestEndDate: cached.record.requestEndDate } : null,
        freshness, trace: { keyword: candidate.keyword, normalizedKeyword: key(candidate.keyword), selectedForAnalysis: true,
          selectedForProtectedSlot: Boolean(candidate.marketDiscovery), selectionType: partIndex * PART_SIZE + offset < selection.selected.length ? "monthly-search" : "ratio-only",
          monthlySearchStatus: candidate.monthlyVolumeStatus, monthlyTotalSearches: candidate.monthlyTotalSearches, searchTrendRequested: true,
          searchTrendStatus: data === null ? "pending-cache" : "pending", marketDiscovery: Boolean(candidate.marketDiscovery),
          cacheHit: data !== null, trendFetchedAt: cached.record?.fetchedAt || null, dataFreshness: freshness.state,
          ...(data === null ? { trendWaitReason: compatible ? "fast_path_cache_wait" : "cache_window_unavailable", exclusionReason: "요청 기간 Trend 캐시 대기" } : {}) },
        prior: prior.get(candidate.keyword) || null, early: relevantEarly.filter(item => item.normalizedKeyword === key(candidate.keyword)) };
    });
    parts.push(await artifacts.writeArtifact(lease, `input-part-${partIndex}`, entries));
  }
  queue.sort((a, b) => b.priority - a.priority);
  const input = { version: 1, calculationVersion: history.CALCULATION_VERSION, jobId: job.jobId,
    startDate: job.startDate, endDate: job.endDate, queryStartDate: job.queryStartDate, requiredWindow: `${job.queryStartDate}:${job.endDate}`,
    targetDataDate: frozenJob.targetDataDate, surgeThreshold: job.surgeThreshold, matchThreshold: job.matchThreshold,
    productCacheObservedAt: products.observedAt,
    orderedCandidateHash: digest(all.map(c => c.keyword)), productHash: products.hash,
    numericCount: selection.selected.length, ratioCount: selection.ratioOnly.length, totalCount: all.length, parts,
    product: products.ref,
    previous: await artifacts.writeArtifact(lease, "previous-news", { mode: previous?.mode, state: previous?.state,
      jobId: previous?.jobId, latestDataDate: previous?.latestDataDate, completedAt: previous?.completedAt,
      results: (previous?.results || []).map(r => ({ keyword: r.keyword, news: r.news, newsEvidenceProvenance: r.newsEvidenceProvenance })) }),
    surge: await artifacts.writeArtifact(lease, "prior-surge-history", { manifest: surge.manifest, records: [...surge.records].filter(([k]) => allKeys.has(k)) }),
    queue, initialStates: states, funnel: funnelFor(candidateCache.candidates, eligible, selection, market?.items?.length || 0),
    cut: { included: core.summaryStats(selection.selected), excluded: core.summaryStats(selection.excluded), selectionGroups: selection.diagnostics,
      excludedTopMonthly100: selection.excluded.slice().sort((a, b) => Number(b.monthlyTotalSearches || 0) - Number(a.monthlyTotalSearches || 0)).slice(0, 100).map(core.candidateDiagnostic),
      excludedTopNewQueries100: selection.excluded.filter(c => c.sources.includes("searchad-query")).sort((a, b) => Number(b.impressions30d || 0) - Number(a.impressions30d || 0)).slice(0, 100).map(core.candidateDiagnostic) } };
  job = await artifacts.writeInputs(lease, input);
  return { job, input };
}

// Merge only touched keys with conditional writes. Never replace unrelated
// historical windows with a shard loaded in an earlier invocation.
async function saveSeries(lease, updates) {
  const store = getCompatibleStore({ name: "trend-series-cache", consistency: "strong" });
  const groups = new Map();
  for (const update of updates) { const shard = series.shardFor(series.normalizedKeyword(update.keyword));
    if (!groups.has(shard)) groups.set(shard, []); groups.get(shard).push(update); }
  for (const [shard, values] of groups) {
    const blobKey = `shards/v1/${shard}`;
    let success = false;
    for (let attempt = 0; attempt < 5 && !success; attempt++) {
      await worker.assertInstantWorker(lease);
      const entry = await store.getWithMetadata(blobKey, { type: "json" });
      const entries = new Map(Object.entries(entry?.data?.entries || {}));
      for (const update of values) {
        const cached = entries.get(series.normalizedKeyword(update.keyword));
        // A delayed, frozen Job must not replace a newer automatic window.
        // Keep its entire response in the existing exact-window collection.
        const historical = update.source === "search" && cached?.search?.requestEndDate > update.endDate;
        const old = update.source === "shopping" ? cached?.shopping?.[update.category]
          : historical ? cached?.searchWindows?.[series.windowKey(update.startDate, update.endDate)] : cached?.search;
        if (!old || Date.parse(old.fetchedAt || "") <= Date.parse(update.fetchedAt))
          series.upsert(entries, historical ? { ...update, cacheScope: "historical" } : update);
      }
      success = Boolean((await store.setJSON(blobKey, { version: series.CACHE_VERSION, shard, updatedAt: new Date().toISOString(), entries: Object.fromEntries(entries) },
        entry?.etag ? { onlyIfMatch: entry.etag } : { onlyIfNew: true }))?.modified);
    }
    if (!success) throw error("INSTANT_CACHE_CONFLICT", "Cache shard changed concurrently; saved responses remain in the Job receipt.");
  }
}

async function readSeriesStrict(candidates, job, now) {
  const store = getCompatibleStore({ name: "trend-series-cache", consistency: "strong" });
  const entries = new Map();
  const selected = new Map(candidates.map(c => [series.normalizedKeyword(c.keyword), c]));
  for (let index = 0; index < series.SHARD_COUNT; index++) {
    const shard = await store.get(`shards/v1/${index}`, { type: "json" });
    if (shard) for (const [normalized, entry] of Object.entries(shard.entries || {})) {
      const candidate = selected.get(normalized); if (!candidate) continue;
      // Select once from the complete shard, then retain only the applicable
      // records. Unrelated historical windows are not loaded into checkpoints.
      const single = new Map([[normalized, entry]]);
      const search = series.lookup(single, candidate.keyword, "search", candidate.category, job.queryStartDate, job.endDate, now).record;
      const shopping = series.lookup(single, candidate.keyword, "shopping", candidate.category, job.queryStartDate, job.endDate, now).record;
      entries.set(normalized, { keyword: candidate.keyword, search, shopping: shopping ? { [candidate.category]: shopping } : {} });
    }
  }
  return { entries, manifest: await store.get(series.MANIFEST_KEY, { type: "json" }) };
}

// Secondary current views obey the same generation order as the main snapshot.
// A resumed old Job still owns its immutable results, but cannot roll these
// shared views back after a newer analysis has published them.
async function writeCurrentProjection(lease, job, blobKey, value) {
  const store = getCompatibleStore({ name: "trend-analysis", consistency: "strong" });
  const generation = Date.parse(job.createdAt);
  for (let attempt = 0; attempt < 5; attempt++) {
    await worker.assertInstantWorker(lease);
    const entry = await store.getWithMetadata(blobKey, { type: "json" });
    const previous = entry?.data;
    const previousJob = previous?.jobId && previous.jobId !== job.jobId
      ? await store.get(`jobs/${previous.jobId}`, { type: "json" }) : null;
    const previousGeneration = Number(previous?.generation || 0)
      || Date.parse(previousJob?.createdAt || previous?.updatedAt || previous?.completedAt || "") || 0;
    if (previous?.jobId !== job.jobId && previousGeneration > generation) return { skippedNewer: true };
    await worker.assertInstantWorker(lease);
    if ((await store.setJSON(blobKey, { ...value, jobId: job.jobId, generation },
      entry?.etag ? { onlyIfMatch: entry.etag } : { onlyIfNew: true }))?.modified) return { stored: true };
  }
  throw error("INSTANT_PROJECTION_CONFLICT", "Current analysis view changed concurrently; saved calculation is preserved.");
}

async function run(original, context = {}, delivery = {}) {
  const background = require("./trend-analysis-background");
  const core = background._test, calculation = background.calculation;
  const invocationId = context.awsRequestId || context.requestId || crypto.randomUUID();
  const claimed = await worker.claimInstantWorker(original.jobId, { owner: invocationId, continuationTicket: delivery.continuationTicket });
  if (!claimed.claimed) { console.log(JSON.stringify({ event: "instant-worker-skipped", jobId: original.jobId, invocationId, reason: claimed.reason })); return; }
  let job = claimed.job; const lease = claimed.lease; const started = Date.now();
  const log = (event, detail = {}) => console.log(JSON.stringify({ event, jobId: job.jobId, invocationId, generation: lease.fence,
    continuation: Number(job.continuationCount || 0), stage: job.currentStage, at: new Date().toISOString(), elapsedMs: Date.now() - started, ...memory(), ...detail }));
  const patch = async value => { job = await worker.writeOwnedInstantJob(lease, value); };
  let input, state;
  const save = async () => { job = await artifacts.writeState(lease, state); log("instant-checkpoint-saved", { phase: state.stage,
    cursor: state.cursor, calculationCursor: state.calculationCursor || 0, ratioCursor: state.ratioCursor || 0,
    checkpointBytes: Buffer.byteLength(JSON.stringify(state)) }); };
  const next = async () => {
    if (Number(job.continuationCount || 0) >= MAX_INVOCATIONS) throw error("INSTANT_CONTINUATION_LIMIT", "Bounded continuation limit reached; checkpoint is preserved.");
    await save();
    const completedRun = { invocationId, generation: lease.fence, phase: state.stage, cursor: state.cursor,
      startedAt: new Date(started).toISOString(), endedAt: new Date().toISOString(), elapsedMs: Date.now() - started, ...memory() };
    await artifacts.writeArtifact(lease, `invocation-${lease.fence}`, completedRun);
    const ticket = crypto.randomUUID(), requestedAt = new Date().toISOString();
    job = await worker.releaseInstantWorker(lease, { continuationCount: Number(job.continuationCount || 0) + 1,
      continuationRequestedAt: requestedAt, resumable: true, lastInvocation: completedRun,
      continuationDispatch: { ticket, state: "pending", requestedAt, readyAt: requestedAt,
        checkpointRevision: job.instantStateRevision, number: Number(job.continuationCount || 0) + 1 } });
    log("instant-continuation-pending", { phase: state.stage, cursor: state.cursor, ticket });
  };
  log("instant-invocation-entered");
  try {
    // Register before doing work, not after checkpoint/release. An invocation
    // killed between those writes remains discoverable by an independent tick.
    await dispatch.registerJob(job.jobId);
    if (["publishing", "publication_failed"].includes(job.state) && Array.isArray(job.results)) {
      job = await publishInstant(job, { lease }); log("instant-publication-completed", { rows: job.results.length, hash: digest(job.results) });
      if (job.schedulerExecutionId) await scheduler.updateById(job.schedulerExecutionId, { state: "completed", stage: "completed", jobId: job.jobId,
        completedAt: job.completedAt, latestDataDate: job.latestDataDate, trendCoveragePct: job.trendCoveragePct, searchTrendApiCallCount: job.searchTrendApiCallCount });
      return;
    }
    input = await artifacts.readInputs(job);
    if (!input) {
      ({ job, input } = await prepare(job, lease, core));
      state = initialState(job, input);
      await patch({ targetDataDate: input.targetDataDate, orderedCandidateHash: input.orderedCandidateHash, productVersionHash: input.productHash,
        calculationVersion: input.calculationVersion, currentStage: "search-trend", totalCandidates: input.totalCount, totalCount: input.totalCount,
        selectedStartDate: input.startDate, selectedEndDate: input.endDate, requiredWindow: input.requiredWindow, progress: 5 });
      await next(); return;
    }
    if (input.calculationVersion !== history.CALCULATION_VERSION || input.startDate !== job.startDate || input.endDate !== job.endDate
      || input.queryStartDate !== job.queryStartDate || input.surgeThreshold !== job.surgeThreshold || input.matchThreshold !== job.matchThreshold)
      throw error("INSTANT_INPUT_INCOMPATIBLE", "Frozen input version/window/settings do not match.");
    state = await artifacts.readState(job);
    if (!state) {
      const durableUsage = await quota.readUsage();
      if (Number(job.instantStateRevision || 0) || Number(job.searchTrendApiCallCount || 0)
        || Object.values(durableUsage.jobs?.[job.jobId]?.metricsByType || {}).some(m => Number(m.calls || 0)))
        throw error("INSTANT_STATE_MISSING", "A checkpoint is required after any collection/calculation; do not guess the cursor.");
      // Inputs were committed immediately before the first state CAS. No source
      // dispatch is possible before that state, so only this initial boundary
      // can be recovered from the already frozen (not current) inputs.
      state = initialState(job, input);
      await patch({ targetDataDate: input.targetDataDate, orderedCandidateHash: input.orderedCandidateHash,
        productVersionHash: input.productHash, calculationVersion: input.calculationVersion });
      await next(); return;
    }
    const durableMetrics = (await quota.readUsage()).jobs?.[job.jobId]?.metricsByType || {};
    for (const type of Object.keys(state.apiMetrics)) for (const metric of METRICS)
      state.apiMetrics[type][metric] = Math.max(Number(state.apiMetrics[type][metric] || 0), Number(durableMetrics[type]?.[metric] || 0));
    log("instant-checkpoint-loaded", { phase: state.stage, cursor: state.cursor });
    if (state.stage === "collection") {
      await collect({ job, lease, input, state, core, started, save, patch, log });
      await next(); return;
    }
    if (state.stage === "numeric" || state.stage === "ratio") {
      await executionBudget.runCalculationChunks({ job, lease, input, state, calculation, started, save, patch, log },
        { calculate });
      await next(); return;
    }
    if (state.stage === "enrichment") {
      await enrich({ job, lease, input, state, core, started, save, patch, log });
      await next(); return;
    }
    if (state.stage === "evidence") {
      const result = await artifacts.readArtifact(state.result);
      for (; state.cursor < result.rows.length; state.cursor++) {
        Object.assign(result.rows[state.cursor], calculateMarketConfidence(result.rows[state.cursor], job.surgeThreshold));
        if (Date.now() - started >= SAFE_MS) { state.cursor++; break; }
      }
      state.result = await artifacts.writeArtifact(lease, "evidence-results", result);
      state.evidenceCursor = state.cursor;
      if (state.cursor >= result.rows.length) { state.stage = "finalize"; state.cursor = 0; }
      await patch({ currentStage: "instant-evidence", progress: 94, processedCount: state.cursor, totalCount: result.rows.length });
      await next(); return;
    }
    if (state.stage === "finalize") {
      await finalize({ job, lease, input, state, core, patch, log });
      // Publication is always a fresh invocation with a saved final body.
      if (state.finalBodySaved) { state.stage = "publishing"; state.cursor = 0; }
      await next(); return;
    }
    throw error("INSTANT_STAGE_INVALID", "Unknown Instant checkpoint stage.");
  } catch (failure) {
    log("instant-invocation-error", { code: failure.code || "INSTANT_PIPELINE_FAILED", message: String(failure.message).slice(0, 400) });
    // Never overwrite a new worker after release/ambiguous HTTP delivery.
    const owned = await worker.assertInstantWorker(lease).catch(() => null);
    if (owned) {
      const publication = Array.isArray(owned.results) && ["publishing", "publication_failed"].includes(owned.state);
      if (publication && Number(owned.publicationAttempt || 0) < 2) {
        await patch({ state: "publishing", publicationAttempt: Number(owned.publicationAttempt || 0) + 1,
          publicationErrorCode: failure.code || "INSTANT_PUBLICATION_FAILED" });
        state = await artifacts.readState(job);
        if (state) { await next(); return; }
      }
      await worker.releaseInstantWorker(lease, { state: publication ? "publication_failed" : "interrupted", resumable: Boolean(owned.instantStateKey || publication),
        errors: [failure.message], failedAt: new Date().toISOString(), errorCode: failure.code || "INSTANT_PIPELINE_FAILED",
        message: publication ? "계산 결과 보존 · 게시 재시도 필요" : "작업 중단 · 저장된 checkpoint 보존" });
    }
  } finally { await worker.releaseInstantWorker(lease).catch(() => null); log("instant-invocation-exited"); }
}

async function collect({ job, lease, input, state, core, started, save, patch, log }) {
  const usage = await quota.readUsage();
  const currentJobMetrics = usage.jobs?.[job.jobId]?.metricsByType || {};
  for (const type of Object.keys(state.apiMetrics)) for (const metric of METRICS)
    state.apiMetrics[type][metric] = Math.max(state.apiMetrics[type][metric] || 0, currentJobMetrics[type]?.[metric] || 0);
  const base = structuredClone(state.apiMetrics);
  const metrics = state.apiMetrics.searchTrend;
  // Frozen decision, not recalculated after each invocation spends part of the
  // same day's allocation. Reservation still rechecks the live safe budget.
  if (!state.budgetMode) {
    let available = 0;
    for (const ref of state.parts) for (const entry of await artifacts.readArtifact(ref)) if (entry.data !== null) available++;
    state.budgetMode = available / input.totalCount < .9 && !job.fastPath ? "bootstrap" : "normal";
  }
  const invocationId = lease.owner;
  let metricQueue = Promise.resolve();
  const record = () => {
    const promise = metricQueue.then(async () => {
      await worker.assertInstantWorker(lease);
      const cumulative = Object.fromEntries(METRICS.map(m => [m, Math.max(0, metrics[m] - base.searchTrend[m])]));
      cumulative.exhausted = metrics.exhausted;
      await quota.recordUsageBatch({ searchTrend: cumulative }, { jobId: job.jobId, invocationId,
        source: "automatic", cumulative: true, jobBaseline: base, enforceBudget: { bootstrap: state.budgetMode === "bootstrap", historical: false } });
      await patch({ apiMetrics: structuredClone(state.apiMetrics), searchTrendApiCallCount: metrics.calls,
        searchTrendHttp200Count: metrics.http200, searchTrendHttp429Count: metrics.http429, searchTrendHttpOtherCount: metrics.httpOther });
    });
    metricQueue = promise.catch(() => null); return promise;
  };
  const updateParts = async (items, responses) => {
    const touched = new Map();
    for (const [index, item] of items.entries()) {
      if (!touched.has(item.partIndex)) touched.set(item.partIndex, await artifacts.readArtifact(state.parts[item.partIndex]));
      const entry = touched.get(item.partIndex)[item.offset], result = responses[index];
      if (result?.success) {
        // The provider may now offer dates after this old Job's frozen target.
        // Preserve the full response in cache/receipt; calculation stops at the
        // original target date, without splicing normalized response windows.
        entry.data = result.series.filter(p => p.period >= job.queryStartDate && p.period <= input.targetDataDate);
        entry.sourceRecord = { fetchedAt: result.fetchedAt, requestStartDate: job.queryStartDate, requestEndDate: job.endDate };
        entry.freshness = { state: result.series.some(p => p.period === input.targetDataDate) ? "target-confirmed" : result.series.length ? "confirmed-no-target" : "empty-response",
          shouldFetch: false, targetDataDate: input.targetDataDate };
        Object.assign(entry.trace, { searchTrendStatus: "pending", cacheHit: false, trendFetchedAt: result.fetchedAt, dataFreshness: "fresh-fetch", trendWaitReason: null, exclusionReason: null });
      } else {
        entry.freshness = { ...entry.freshness, state: result?.budget ? "budget-limited" : "query-error", shouldFetch: false };
        entry.trace.collectionError = result?.code || "REQUEST_OUTCOME_UNKNOWN";
      }
    }
    for (const [partIndex, entries] of touched) state.parts[partIndex] = await artifacts.writeArtifact(lease, `collected-part-${partIndex}`, entries);
  };
  // A response receipt precedes shared cache writes. If the worker dies between
  // them, replay storage only. An ambiguous dispatch is never silently repeated.
  if (state.inflight) {
    const receipt = state.inflight.receipt ? await artifacts.readArtifact(state.inflight.receipt) : null;
    if (receipt) {
      await saveSeries(lease, receipt.updates); await updateParts(state.inflight.items, receipt.responses);
      state.responsesSaved += receipt.updates.length;
      state.trendCollectedAt = receipt.updates.map(u => u.fetchedAt).concat(state.trendCollectedAt || []).sort().at(-1) || null;
    } else {
      const store = getCompatibleStore({ name: "trend-series-cache", consistency: "strong" });
      const readShards = new Map(); const responses = [];
      for (const item of state.inflight.items) {
        const shard = series.shardFor(series.normalizedKeyword(item.keyword));
        if (!readShards.has(shard)) readShards.set(shard, await store.get(`shards/v1/${shard}`, { type: "json" }));
        const cached = readShards.get(shard)?.entries?.[series.normalizedKeyword(item.keyword)];
        const record = [cached?.search, cached?.searchWindows?.[series.windowKey(job.queryStartDate, job.endDate)]]
          .filter(r => r?.requestStartDate === job.queryStartDate && r?.requestEndDate === job.endDate)
          .sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))[0];
        const observed = record?.requestStartDate === job.queryStartDate && record?.requestEndDate === job.endDate
          && Date.parse(record.fetchedAt) >= Date.parse(state.inflight.startedAt);
        responses.push(observed ? { success: true, series: record.rawRatioSeries, fetchedAt: record.fetchedAt } : { code: "REQUEST_OUTCOME_UNKNOWN" });
      }
      await updateParts(state.inflight.items, responses);
      state.responsesSaved += responses.filter(r => r.success).length;
      state.trendCollectedAt = responses.filter(r => r.success).map(r => r.fetchedAt).concat(state.trendCollectedAt || []).sort().at(-1) || null;
    }
    metrics.keywords = Math.max(metrics.keywords, state.responsesSaved); await record();
    state.inflight = null; await save();
  }
  while (state.cursor < input.queue.length && !job.fastPath) {
    if (Date.now() - started >= COLLECTION_MS) break;
    const status = quota.statusFor(await quota.readUsage(), "searchTrend", 0, new Date(), { bootstrap: state.budgetMode === "bootstrap" });
    if (status.exhausted || !status.remaining) { state.budgetLimited = true; state.providerLimited = status.exhausted; break; }
    const items = input.queue.slice(state.cursor, state.cursor + Math.min(25, status.remaining * 5));
    const requestBatches = chunks(items, 5);
    state.inflight = { startedAt: new Date().toISOString(), items };
    state.cursor += items.length; await save(); // conservative at-most-once intent
    const settled = await Promise.allSettled(requestBatches.map(batch => core.api("/search-trend/v1/search", {
      method: "POST", body: { startDate: job.queryStartDate, endDate: job.endDate, timeUnit: "date",
        keywordGroups: batch.map(c => ({ groupName: c.keyword, keywords: [c.keyword] })) },
      metrics, onMetrics: record, collectionPolicy: job })));
    const fetchedAt = new Date().toISOString(), updates = [], responses = [];
    for (const [index, response] of settled.entries()) {
      if (response.status === "rejected" && /^(INSTANT_|QUOTA_PERSIST|QUOTA_WRITE)/.test(response.reason?.code || "")) throw response.reason;
      const returned = response.status === "fulfilled" ? new Map((response.value.results || []).map(r => [key(r.title), r.data || []])) : null;
      for (const item of requestBatches[index]) {
        if (!returned || !returned.has(key(item.keyword))) {
          responses.push({ code: response.reason?.code || "MISSING_RESPONSE_GROUP", budget: response.reason?.code === "QUOTA_BUDGET_EXHAUSTED" }); continue;
        }
        const data = returned.get(key(item.keyword));
        responses.push({ success: true, series: data, fetchedAt });
        updates.push({ keyword: item.keyword, source: "search", startDate: job.queryStartDate, endDate: job.endDate, series: data, fetchedAt, cacheScope: "latest" });
      }
    }
    state.inflight.receipt = await artifacts.writeArtifact(lease, `source-receipt-${state.cursor}`, { updates, responses });
    await save();
    await saveSeries(lease, updates); await updateParts(items, responses);
    metrics.keywords = Math.max(metrics.keywords, state.responsesSaved + updates.length); await record();
    state.responsesSaved += updates.length; state.trendCollectedAt = updates.length ? fetchedAt : state.trendCollectedAt;
    state.inflight = null; await save();
    await patch({ currentStage: "search-trend", processedCount: state.cursor, totalCount: input.queue.length,
      progress: 5 + Math.round(state.cursor / Math.max(1, input.queue.length) * 35),
      message: `목표일 Trend 확인 · ${state.cursor.toLocaleString("ko-KR")} / ${input.queue.length.toLocaleString("ko-KR")} · 응답 저장 ${state.responsesSaved}` });
    log("instant-collection-batch-saved", { cursor: state.cursor, saved: updates.length, calls: metrics.calls });
    if (metrics.exhausted) { state.providerLimited = true; break; }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  if (state.cursor >= input.queue.length || job.fastPath || state.budgetLimited || state.providerLimited) {
    state.unqueried = Math.max(0, input.queue.length - state.cursor);
    state.collectionCursor = state.cursor; state.stage = "numeric"; state.cursor = 0;
    await patch({ currentStage: "calculation-checkpoint", message: "수집 응답 저장 완료 · 계산 구간 시작", progress: 74 });
  }
}

async function calculate({ job, lease, input, state, calculation, started, save, patch, log, shared = {} }) {
  const phase = state.stage, limit = phase === "numeric" ? input.numericCount : input.ratioCount;
  const absoluteCursor = (phase === "numeric" ? 0 : input.numericCount) + state.cursor;
  const partIndex = Math.floor(absoluteCursor / PART_SIZE);
  if (state.cursor >= limit) { state.stage = phase === "numeric" ? "ratio" : "enrichment"; state.cursor = 0; return; }
  // One immutable product/index per invocation, not per checkpoint. Previous
  // output arrays remain Blob references and are not accumulated in this cache.
  if (!shared.productCache) {
    shared.productCache = await artifacts.readArtifact(input.product);
    shared.productIndex = calculation.buildProductIndex(shared.productCache.items);
  }
  const productCache = shared.productCache, entries = await artifacts.readArtifact(state.parts[partIndex]);
  const selected = entries.slice(absoluteCursor % PART_SIZE).filter(e => e.numeric === (phase === "numeric"));
  const rows = [], calculated = [], matchedDiagnostics = [], boundaryRelated = [];
  const funnel = structuredClone(input.funnel);
  const traces = new Map(entries.map(e => [key(e.candidate.keyword), { ...e.trace }]));
  const ctx = { job, productCache, productIndex: shared.productIndex,
    trendMap: new Map(entries.filter(e => e.data !== null).map(e => [e.candidate.keyword, e.data])),
    shoppingMap: new Map(entries.map(e => [e.candidate.keyword, e.shopping])), analysisTrace: traces, funnel,
    loadedEarlyCache: { history: entries.flatMap(e => e.early) }, priorSignals: new Map(entries.map(e => [e.candidate.keyword, e.prior])),
    rows, calculated, matchedDiagnostics, boundaryRelated };
  const startCursor = state.cursor; const processed = [];
  for (const entry of selected) {
    if (Date.now() - started >= SAFE_MS && processed.length) break;
    if (phase === "numeric") calculation.calculateNumericCandidate(entry.candidate, ctx);
    else calculation.calculateRatioCandidate(entry.candidate, ctx);
    processed.push(key(entry.candidate.keyword)); state.cursor++;
  }
  // Only this invocation's output is written. Previous calculation arrays are
  // not reloaded/cloned during numeric or ratio processing.
  const result = { phase, startCursor, endCursor: state.cursor, rows,
    calculated: calculated.map(c => ({ candidate: { keyword: c.candidate.keyword, monthlyTotalSearches: c.candidate.monthlyTotalSearches },
      metrics: { ...c.metrics, series: undefined }, diagnosticRow: c.diagnosticRow })),
    matchedDiagnostics, boundaryRelated, funnel,
    traces: processed.map(k => traces.get(k)) };
  const ref = await artifacts.writeArtifact(lease, `${phase}-${startCursor}-${state.cursor}`, result);
  state.outputs.push(ref);
  if (phase === "numeric") state.calculationCursor = state.cursor; else state.ratioCursor = state.cursor;
  const cursor = state.cursor;
  if (state.cursor >= limit) { state.stage = phase === "numeric" ? "ratio" : "enrichment"; state.cursor = 0; }
  await save();
  await patch({ currentStage: phase === "numeric" ? "calculation-matching" : "calculation-ratio", processedCount: cursor, totalCount: limit,
    calculationCursor: state.calculationCursor, ratioCursor: state.ratioCursor,
    progress: 75 + Math.round((state.calculationCursor + state.ratioCursor) / input.totalCount * 14),
    message: `급등 계산 및 상품 매칭 · ${state.calculationCursor + state.ratioCursor} / ${input.totalCount} · 중간 결과 저장` });
  log("instant-calculation-chunk-completed", { phase, startCursor, endCursor: cursor, rows: rows.length, outputBytes: Buffer.byteLength(JSON.stringify(result)) });
}

async function combine(input, state) {
  const result = { rows: [], calculated: [], matchedDiagnostics: [], boundaryRelated: [], traces: [], funnel: structuredClone(input.funnel) };
  for (const ref of state.outputs) {
    const part = await artifacts.readArtifact(ref);
    for (const array of ["rows", "calculated", "matchedDiagnostics", "boundaryRelated", "traces"]) result[array].push(...part[array]);
    for (const [branch, counts] of Object.entries(part.funnel)) {
      if (branch === "candidates") continue;
      for (const [k, value] of Object.entries(counts)) if (!(branch === "searchTrend" && k === "requested")) result.funnel[branch][k] += value;
    }
  }
  const freshness = { targetDataDate: input.targetDataDate, totalCount: input.totalCount, cacheAvailableCount: 0, validSeriesCount: 0,
    emptySeriesCount: 0, targetDataCandidateCount: 0, confirmedNoTargetCount: 0, refreshPendingCount: 0, queryErrorCount: 0,
    actualStartDate: null, actualDataDate: null, states: {}, note: "캐시 확보율과 목표일 관측 비율은 다릅니다. 희소·빈 응답은 미관측이며 수집 실패와 동일하지 않습니다." };
  let reused = 0, fresh = 0, shoppingHits = 0;
  for (const ref of state.parts) for (const entry of await artifacts.readArtifact(ref)) {
    freshness.states[entry.freshness.state] = (freshness.states[entry.freshness.state] || 0) + 1;
    if (["query-error", "error"].includes(entry.freshness.state)) freshness.queryErrorCount++;
    if (entry.freshness.shouldFetch) freshness.refreshPendingCount++;
    if (entry.freshness.state === "confirmed-no-target") freshness.confirmedNoTargetCount++;
    if (entry.shopping.length) shoppingHits++;
    if (entry.data === null) continue;
    freshness.cacheAvailableCount++;
    if (entry.trace.cacheHit) reused++; else fresh++;
    if (!entry.data.length) { freshness.emptySeriesCount++; continue; }
    freshness.validSeriesCount++;
    if (entry.data.some(p => p.period === input.targetDataDate)) freshness.targetDataCandidateCount++;
    for (const point of entry.data) {
      if (!freshness.actualStartDate || point.period < freshness.actualStartDate) freshness.actualStartDate = point.period;
      if (!freshness.actualDataDate || point.period > freshness.actualDataDate) freshness.actualDataDate = point.period;
    }
  }
  freshness.targetDataCoveragePct = Math.round(freshness.targetDataCandidateCount / input.totalCount * 10000) / 100;
  freshness.olderNonemptyCount = freshness.validSeriesCount - freshness.targetDataCandidateCount;
  freshness.unavailableCount = input.totalCount - freshness.cacheAvailableCount;
  freshness.completeForTarget = freshness.targetDataCandidateCount === input.totalCount;
  result.sourceFreshness = freshness;
  result.funnel.searchTrend.apiErrorCandidates = freshness.queryErrorCount;
  result.cache = { hits: reused, freshFetchCandidates: fresh, misses: freshness.unavailableCount, windowUnavailable: freshness.unavailableCount,
    pendingCandidates: freshness.unavailableCount, requestedMisses: input.queue.length, scheduledFetchCandidates: state.collectionCursor,
    expectedApiCalls: Math.ceil(input.queue.length / 5), targetDateRefreshPending: freshness.refreshPendingCount,
    apiCalls: state.apiMetrics.searchTrend.calls, retries: state.apiMetrics.searchTrend.retries };
  result.funnel.trendCache = { searchTrend: result.cache, shoppingInsight: { hits: shoppingHits, freshFetchCandidates: 0, apiCalls: 0, retries: 0 },
    executionPath: state.fastPath ? "fast" : "slow", budgetMode: state.budgetMode };
  return result;
}

async function enrich({ job, lease, input, state, core, started, save, patch, log }) {
  let result;
  if (!state.result) {
    result = await combine(input, state);
    state.result = await artifacts.writeArtifact(lease, "combined-calculation", result);
    state.enrichmentPhase = "shopping"; state.cursor = 0; await save();
  } else result = await artifacts.readArtifact(state.result);
  const scoped = core.isSearchTrendOnly(job);
  const providersAllowed = !job.fastPath && !scoped;
  const previous = scoped ? await artifacts.readArtifact(input.previous) : null;
  const base = structuredClone(state.apiMetrics);
  const record = async type => {
    await worker.assertInstantWorker(lease);
    const cumulative = Object.fromEntries(METRICS.map(m => [m, Math.max(0, state.apiMetrics[type][m] - base[type][m])]));
    cumulative.exhausted = state.apiMetrics[type].exhausted;
    await quota.recordUsageBatch({ [type]: cumulative }, { jobId: job.jobId, invocationId: lease.owner, source: "automatic", cumulative: true,
      jobBaseline: base, enforceBudget: type === "news" ? null : { historical: false, bootstrap: false } });
    await patch({ apiMetrics: structuredClone(state.apiMetrics) });
  };
  // The response location is fixed and committed before dispatch. A content-
  // addressed artifact alone is insufficient here: a crash after its write but
  // before the state CAS would lose the only reference to that response.
  const receiptStore = getCompatibleStore({ name: "trend-analysis", consistency: "strong" });
  const receiptKey = intent => `jobs/${encodeURIComponent(job.jobId)}/instant-v1/enrichment-receipts/${intent.requestId}`;
  const begin = async (phase, indices, category) => {
    const identity = { jobId: job.jobId, phase, indices, keywords: indices.map(index => result.rows[index].keyword),
      queryStartDate: job.queryStartDate, endDate: job.endDate, category: category || null };
    state.enrichmentInflight = { ...identity, requestId: digest(identity), startedAt: new Date().toISOString(),
      baseKeywordCount: Number(state.apiMetrics[phase === "shopping" ? "shoppingInsight" : "news"].keywords || 0) };
    await save();
    return state.enrichmentInflight;
  };
  const readReceipt = async intent => {
    const receipt = await receiptStore.get(receiptKey(intent), { type: "json" });
    if (!receipt) return null;
    const { hash, ...body } = receipt;
    if (body.version !== 1 || body.jobId !== job.jobId || body.requestId !== intent.requestId
      || body.phase !== intent.phase || digest(body) !== hash)
      throw error("INSTANT_ENRICHMENT_RECEIPT_INVALID", "Saved enrichment receipt does not match its dispatch intent.");
    return body;
  };
  const storeReceipt = async (intent, response) => {
    await worker.assertInstantWorker(lease);
    const body = { version: 1, jobId: job.jobId, requestId: intent.requestId, phase: intent.phase,
      receivedAt: new Date().toISOString(), ...response };
    await receiptStore.setJSON(receiptKey(intent), { ...body, hash: digest(body) }, { onlyIfNew: true });
    const stored = await readReceipt(intent);
    if (!stored) throw error("INSTANT_ENRICHMENT_RECEIPT_MISSING", "Enrichment response could not be verified after storage.");
    return stored;
  };
  const applyReceipt = async (intent, receipt) => {
    for (const [position, index] of intent.indices.entries()) if (result.rows[index]?.keyword !== intent.keywords[position])
      throw error("INSTANT_ENRICHMENT_ROW_MISMATCH", "Saved enrichment belongs to a different frozen result row.");
    if (receipt?.success && intent.phase === "shopping") {
      const returned = new Map((receipt.payload.results || []).map(row => [key(row.title), row.data || []]));
      const updates = [];
      for (const index of intent.indices) {
        const row = result.rows[index], values = returned.get(key(row.keyword)); if (!values) continue;
        row.shoppingTrend = values; const ratios = values.map(point => Number(point.ratio || 0));
        row.shoppingRise = ratios.length > 1 ? ratios.at(-1) - core.median(ratios.slice(-8, -1)) : 0;
        updates.push({ keyword: row.keyword, source: "shopping", category: intent.category,
          startDate: intent.queryStartDate, endDate: intent.endDate, series: values, fetchedAt: receipt.receivedAt });
      }
      await saveSeries(lease, updates);
      state.apiMetrics.shoppingInsight.keywords = Math.max(Number(state.apiMetrics.shoppingInsight.keywords || 0), intent.baseKeywordCount + updates.length);
      await record("shoppingInsight");
    } else if (receipt?.success && intent.phase === "news") {
      const row = result.rows[intent.indices[0]], payload = receipt.payload;
      row.news = { keyword: row.keyword, total: Number(payload.total || 0), items: (payload.items || []).slice(0, 3) };
    } else {
      state.enrichmentErrors ||= [];
      if (!state.enrichmentErrors.some(item => item.requestId === intent.requestId)) state.enrichmentErrors.push({
        requestId: intent.requestId, phase: intent.phase, keywords: intent.keywords,
        code: receipt?.errorCode || "REQUEST_OUTCOME_UNKNOWN", at: receipt?.receivedAt || intent.startedAt });
    }
    state.result = await artifacts.writeArtifact(lease, `${intent.phase}-results`, result);
    state.enrichmentInflight = null;
    await save();
    log("instant-enrichment-receipt-applied", { phase: intent.phase, requestId: intent.requestId,
      receiptStored: Boolean(receipt), success: Boolean(receipt?.success), keywords: intent.indices.length });
  };
  // A dispatch without a saved response has an ambiguous outcome. Preserve the
  // existing result, record that fact, and never dispatch it a second time.
  if (state.enrichmentInflight) {
    const intent = state.enrichmentInflight;
    await applyReceipt(intent, await readReceipt(intent));
  }
  if (state.enrichmentPhase === "shopping") {
    if (providersAllowed) {
      while (state.cursor < result.rows.length && Date.now() - started < COLLECTION_MS) {
        const indices = [];
        const category = result.rows[state.cursor]?.category;
        while (state.cursor < result.rows.length && indices.length < 5 && result.rows[state.cursor]?.category === category) {
          const index = state.cursor++;
          if (!result.rows[index].shoppingTrend?.length) indices.push(index);
        }
        if (!indices.length) continue;
        const status = quota.statusFor(await quota.readUsage(), "shoppingInsight");
        if (!status.remaining || status.exhausted) { state.cursor = result.rows.length; break; }
        // Save dispatch cursor before I/O. Ambiguous enrichment is optional and
        // must not spend quota twice after a process death.
        state.enrichmentCursor = Math.max(state.enrichmentCursor || 0, state.cursor);
        const intent = await begin("shopping", indices, category);
        let response;
        try {
          const payload = await core.api("/shopping/v1/category/keywords", { method: "POST", body: {
            startDate: job.queryStartDate, endDate: job.endDate, timeUnit: "date", category: category === "health" ? "50000023" : "50000002",
            keyword: indices.map(i => ({ name: result.rows[i].keyword, param: [result.rows[i].keyword] })) }, metrics: state.apiMetrics.shoppingInsight,
            onMetrics: () => record("shoppingInsight"), collectionPolicy: job });
          response = { success: true, payload };
        } catch (failure) {
          if (/^(INSTANT_|QUOTA_WRITE|QUOTA_PERSIST)/.test(failure.code || "")) throw failure;
          response = { success: false, errorCode: failure.code || "PROVIDER_REQUEST_FAILED" };
        }
        await applyReceipt(intent, await storeReceipt(intent, response));
      }
      if (state.cursor < result.rows.length) return;
    }
    result.rows.sort((a, b) => Number(b.estimatedSurgeCount || 0) - Number(a.estimatedSurgeCount || 0)
      || Number(b.relativeRatioLift || 0) - Number(a.relativeRatioLift || 0) || b.shoppingRise - a.shoppingRise || b.trendSlope - a.trendSlope);
    result.reusedNewsCount = scoped ? core.reuseCachedNews(result.rows, previous) : 0;
    state.result = await artifacts.writeArtifact(lease, "sorted-results", result);
    state.enrichmentPhase = "news"; state.cursor = result.rows.length; state.newsCursor = 0; await save();
    return;
  }
  if (providersAllowed) while (state.newsCursor < Math.min(20, result.rows.length) && Date.now() - started < COLLECTION_MS) {
    const index = state.newsCursor++, row = result.rows[index]; state.cursor = result.rows.length + state.newsCursor;
    const intent = await begin("news", [index]);
    let response;
    try {
      const payload = await core.api("/search/v1/news", { params: { query: row.keyword, display: 3, start: 1, sort: "date" },
        metrics: state.apiMetrics.news, onMetrics: () => record("news"), collectionPolicy: job });
      response = { success: true, payload };
    } catch (failure) {
      if (/^(INSTANT_|QUOTA_WRITE|QUOTA_PERSIST)/.test(failure.code || "")) throw failure;
      response = { success: false, errorCode: failure.code || "PROVIDER_REQUEST_FAILED" };
    }
    await applyReceipt(intent, await storeReceipt(intent, response));
  }
  if (!providersAllowed || state.newsCursor >= Math.min(20, result.rows.length)) {
    state.stage = "evidence"; state.cursor = 0;
    await patch({ currentStage: "instant-evidence", progress: 92, message: "급등 계산 완료 · 신뢰도 및 근거 처리" });
  }
  log("instant-enrichment-progress", { phase: state.enrichmentPhase, cursor: state.cursor });
}

async function finalize({ job, lease, input, state, core, patch, log }) {
  const result = await artifacts.readArtifact(state.result);
  const { rows, calculated, matchedDiagnostics, boundaryRelated, traces, funnel, sourceFreshness } = result;
  if (!state.finalizeCursor) {
  const previousHistory = await artifacts.readArtifact(input.surge);
  const frozenHistory = { ...previousHistory, records: new Map(previousHistory.records) };
  const observations = calculated.map(entry => ({ keyword: entry.candidate.keyword, latestDataDate: entry.metrics.latestPeriod,
    estimatedSurgeCount: entry.metrics.surgeCount, estimatedBaseline: entry.metrics.baseline, estimatedLatest: entry.metrics.latest,
    monthlySearches: entry.candidate.monthlyTotalSearches }));
  history.upsertInstantHistory(frozenHistory.records, observations, job.jobId, job.createdAt);
  for (const row of rows) {
    row.surgeHistoryState = history.deriveSurgeState(frozenHistory.records.get(key(row.keyword)), job.surgeThreshold, row.latestDataDate);
    row.surgeCalculationVersion = history.CALCULATION_VERSION;
  }
  frozenHistory.records.clear(); previousHistory.records.length = 0;
  await worker.assertInstantWorker(lease);
  result.historyManifest = await require("./instant-history").mergeInstantHistory(lease, observations);
  state.result = await artifacts.writeArtifact(lease, "history-results", result);
  state.cursor = 1; state.finalizeCursor = 1;
  log("instant-history-finalized", { rows: rows.length });
  return;
  }
  const historyManifest = result.historyManifest;
  const surgeTop30 = calculated.slice().sort((a, b) => b.metrics.surgeCount - a.metrics.surgeCount).slice(0, 30).map(e => e.diagnosticRow);
  const matchTop30 = matchedDiagnostics.slice().sort((a, b) => b.matchScore - a.matchScore || b.estimatedSurgeCount - a.estimatedSurgeCount).slice(0, 30);
  const samples = [], add = (type, entry) => { if (entry && !samples.some(s => s.keyword === entry.candidate.keyword)) samples.push({ type, ...entry.diagnosticRow }); };
  add("highestSurge", calculated.slice().sort((a, b) => b.metrics.surgeCount - a.metrics.surgeCount)[0]);
  add("nearThreshold", calculated.slice().sort((a, b) => Math.abs(a.metrics.surgeCount - job.surgeThreshold) - Math.abs(b.metrics.surgeCount - job.surgeThreshold))[0]);
  add("largestMonthlyVolume", calculated.slice().sort((a, b) => Number(b.candidate.monthlyTotalSearches || 0) - Number(a.candidate.monthlyTotalSearches || 0))[0]);
  add("largestLatestLift", calculated.slice().sort((a, b) => b.metrics.endLift - a.metrics.endLift)[0]);
  add("sparsestTrend", calculated.filter(c => c.diagnosticRow.nonZeroRatioDays > 0).sort((a, b) => a.diagnosticRow.nonZeroRatioDays - b.diagnosticRow.nonZeroRatioDays)[0]);
  const byKey = new Map(rows.map(r => [key(r.keyword), r]));
  for (const trace of traces) {
    const row = byKey.get(trace.normalizedKeyword); trace.finalIncluded = Boolean(row); trace.resultType = row?.resultType || null;
    trace.exclusionReason = row ? null : trace.searchTrendStatus === "pending-cache" ? trace.exclusionReason || "Trend 캐시 구축 대기"
      : trace.searchTrendStatus === "empty" ? "Search Trend 시계열 없음"
        : trace.ratioOnly && Number(trace.relativeRatioLift || 0) < 50 ? "ratio-only 상대 변화 기준 미달"
          : !trace.ratioOnly && !trace.absoluteSurgePassed && !trace.relativeSurgePassed && !trace.lowIntensityTrendPassed ? "급등 수치 조건 미달" : "상품·브랜드·도메인 관련 근거 부족";
  }
  const latestDataDate = sourceFreshness.actualDataDate;
  const pending = input.totalCount - sourceFreshness.cacheAvailableCount;
  const completedAt = new Date().toISOString();
  await writeCurrentProjection(lease, job, analysis.DIAGNOSTIC_INDEX_KEY, { version: 1, jobId: job.jobId, mode: "instant", startDate: job.startDate, endDate: job.endDate,
    latestDataDate, completedAt, items: traces });
  if (!pending) await writeCurrentProjection(lease, job, "signals/current", { updatedAt: completedAt, mode: "instant", items: calculated.map(e => ({
    keyword: e.candidate.keyword, estimatedSurgeCount: Math.round(e.metrics.surgeCount), endLift: Math.round(e.metrics.endLift),
    peakLift: Math.round(e.metrics.peakLift), latestDataDate: e.metrics.latestPeriod })) });
  const metrics = state.apiMetrics;
  funnel.trendCache.shoppingInsight = { ...funnel.trendCache.shoppingInsight, apiCalls: metrics.shoppingInsight.calls,
    retries: metrics.shoppingInsight.retries, freshFetchCandidates: metrics.shoppingInsight.keywords };
  const final = { state: "publishing", currentStage: "publishing", publicationState: "pending", calculatedAt: completedAt,
    completedAt, progress: 99, message: "계산 완료 · 결과 게시 중", results: rows, resultCount: rows.length, errors: [],
    sourceFreshness, latestDataDate, analyzedCandidateCount: input.totalCount,
    productCacheObservedAt: input.productCacheObservedAt || null,
    processedCount: input.totalCount, totalCount: input.totalCount,
    searchAdCount: (await artifacts.readArtifact(input.product)).items.length,
    partialAnalysis: pending > 0, trendAvailableCount: sourceFreshness.cacheAvailableCount, pendingTrendCacheCount: pending,
    trendCoveragePct: Math.round(sourceFreshness.cacheAvailableCount / input.totalCount * 10000) / 100,
    cacheHitCount: result.cache.hits, freshFetchCount: result.cache.freshFetchCandidates, cacheMissCount: result.cache.misses,
    cacheWindowUnavailableCount: result.cache.windowUnavailable, trendCollectedAt: state.trendCollectedAt || null,
    budgetMode: state.budgetMode, apiMetrics: metrics, reusedNewsCount: result.reusedNewsCount || 0,
    durationMs: Date.now() - Date.parse(job.createdAt), resultsHash: digest(rows),
    searchTrendApiCallCount: metrics.searchTrend.calls, searchTrendHttp200Count: metrics.searchTrend.http200,
    searchTrendHttp429Count: metrics.searchTrend.http429, searchTrendHttpOtherCount: metrics.searchTrend.httpOther,
    shoppingInsightApiCallCount: metrics.shoppingInsight.calls, shoppingInsightHttp200Count: metrics.shoppingInsight.http200,
    shoppingInsightHttp429Count: metrics.shoppingInsight.http429, shoppingInsightHttpOtherCount: metrics.shoppingInsight.httpOther,
    newsApiCallCount: metrics.news.calls, newsHttp200Count: metrics.news.http200, newsHttp429Count: metrics.news.http429, newsHttpOtherCount: metrics.news.httpOther,
    naverApiRetryCount: metrics.searchTrend.retries + metrics.shoppingInsight.retries,
    productMatchResultCount: rows.filter(r => r.resultType === "product_match").length,
    brandCategorySignalCount: rows.filter(r => r.resultType === "brand_or_category_signal").length,
    domainRelatedSignalCount: rows.filter(r => r.resultType === "domain_related_signal").length,
    lowIntensityEarlySignalCount: rows.filter(r => r.resultType === "low_intensity_early_signal").length,
    ratioOnlyMarketSignalCount: rows.filter(r => r.resultType === "ratio_only_market_signal").length,
    diagnostic: { funnel, candidateCut: input.cut, surgeTop30, matchTop30, boundary200To299: { total: funnel.surge.from200To299,
      relatedCount: boundaryRelated.length, items: boundaryRelated.slice().sort((a, b) => b.estimatedSurgeCount - a.estimatedSurgeCount).slice(0, 100) },
      calculationSamples: samples, surgeHistory: { stored: true, calculationVersion: history.CALCULATION_VERSION,
        shardCount: historyManifest?.shardCount || 0, recordCount: historyManifest?.recordCount || 0 } } };
  if (!core.isSearchTrendOnly(job)) {
    const earlySignals = require("./today-early-signal-cache"), discovery = require("./market-discovery-history-cache");
    const early = await earlySignals.readCache(), currentHistory = await discovery.readHistory();
    const confirmed = early ? earlySignals.confirmSignals(early, traces, rows, latestDataDate) : null;
    await worker.assertInstantWorker(lease);
    if (confirmed) await earlySignals.writeCache(confirmed);
    if (currentHistory) await discovery.writeHistory(discovery.mergeEarlySignalHistory(discovery.mergeSignalHistory(currentHistory, rows, completedAt), confirmed?.history || [], completedAt));
  }
  await patch(final);
  state.finalBodySaved = true; state.finalizeCursor = 2; state.cursor = 2;
  log("instant-final-result-saved", { rows: rows.length, hash: final.resultsHash, actualDataDate: latestDataDate });
}

module.exports = { run, prepare, funnelFor, saveSeries, writeCurrentProjection, combine, collect, calculate, enrich, finalize, PART_SIZE, SAFE_MS, COLLECTION_MS, MAX_INVOCATIONS };
