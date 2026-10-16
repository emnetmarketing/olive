const crypto = require("node:crypto");
const blobs = require("@netlify/blobs");
const compat = require("./blob-store-compat");
const recovery = require("./period-recovery-state");
const publication = require("./period-publication");
const excel = require("./unified-excel");
const analysis = require("./trend-analysis-cache");
const instantPublication = require("./instant-publication");

// Operator-authorized synthetic verification only. No business store, input
// Job ID, candidate, source API, or publication pointer is accepted from HTTP.
const STORE_NAME = "trend-runtime-verification";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATION = "runtime-fixture-v1";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const failure = code => Object.assign(new Error(code), { code });
const response = (statusCode, data) => ({ statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(data) });
function scopedStore(store, prefix) {
  const key = value => {
    if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("..") || value.includes("\\")) throw failure("PROBE_SCOPE_VIOLATION");
    return `${prefix}${value}`;
  };
  return {
    get: (value, options) => store.get(key(value), options),
    getWithMetadata: (value, options) => store.getWithMetadata(key(value), options),
    setJSON: (value, data, options) => store.setJSON(key(value), data, options)
  };
}
function fixture(jobId) {
  const results = [
    { keyword: "runtime-fixture-A", resultType: "product_match", estimatedSurgeCount: 1234, peakRelativeLiftPct: 120,
      periodMarketConfidenceScore: 66, periodMarketConfidenceGrade: "medium", periodMarketConfidenceReasons: ["Synthetic fixture"],
      periodMarketEvidence: { youtube: { status: "no_data" }, searchAd: { status: "no_data" } } },
    { keyword: "runtime-fixture-B", resultType: "brand_or_category_signal", estimatedSurgeCount: 321, peakRelativeLiftPct: 80,
      periodMarketConfidenceScore: 42, periodMarketConfidenceGrade: "reference", periodMarketEvidence: { youtube: { status: "no_data" } } }
  ];
  const job = { jobId, mode: "period", startDate: "2001-01-02", endDate: "2001-01-03", queryStartDate: "2000-12-04",
    latestDataDate: "2001-01-03", calculatedAt: "2001-01-04T00:00:00.000Z", trendCoveragePct: 100,
    candidateCount: 2, analyzedCandidateCount: 2, trendAvailableCount: 2, partialAnalysis: false, resultCount: 2, results };
  return { job, snapshot: { jobId, mode: "period", startDate: job.startDate, endDate: job.endDate,
    queryStartDate: job.queryStartDate, latestDataDate: job.latestDataDate, trendCoveragePct: 100, partialAnalysis: false, items: results } };
}
function fixtureExcel(job) {
  return { generatedAt: "2001-01-04T00:00:00.000Z", early: { items: [] }, discoveries: [], instantJob: { results: [] },
    periodJob: job, periodRequest: { startDate: job.startDate, endDate: job.endDate, jobId: job.jobId } };
}
function createHandlers(deps = {}) {
  const now = deps.now || Date.now;
  const uuid = deps.uuid || crypto.randomUUID;
  const openRead = deps.openRead || (() => blobs.getStore(STORE_NAME));
  const openStrong = deps.openStrong || (() => compat.getCompatibleStore({ name: STORE_NAME, consistency: "strong" }));
  async function authorize(event) {
    if (event?.blobs) compat.connectLambda(event);
    const body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body) : {};
    const runId = body.runId || event.queryStringParameters?.runId;
    if (!UUID.test(runId || "")) throw failure("PROBE_AUTH_REQUIRED");
    const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    const token = String(headers.authorization || "").replace(/^Bearer /i, "");
    if (token.length < 32 || token.length > 256) throw failure("PROBE_AUTH_REQUIRED");
    const authorization = await openRead().get(`authorization/${runId}`, { type: "json" });
    const expiresAt = Date.parse(authorization?.expiresAt);
    if (!authorization || authorization.jobId !== `runtime-fixture-${runId}` || !/^[a-f0-9]{64}$/.test(authorization.tokenHash || "")
      || !Number.isFinite(expiresAt) || expiresAt <= now() || expiresAt > now() + 2 * 60 * 60 * 1000
      || !crypto.timingSafeEqual(Buffer.from(hash(token), "hex"), Buffer.from(authorization.tokenHash, "hex"))) throw failure("PROBE_AUTH_REQUIRED");
    const store = scopedStore(openStrong(), `runs/${runId}/`);
    return { runId, token, body, store, jobId: authorization.jobId, stateStore: scopedStore(store, "state/"),
      publicationStore: scopedStore(store, "publication/") };
  }
  async function dispatch(ctx, phase) {
    const requestedAt = new Date(now()).toISOString();
    await ctx.store.setJSON(`dispatch/${phase}`, { phase, requestedAt, status: "requested" }, { onlyIfNew: true });
    try {
      let status;
      if (deps.dispatch) status = await deps.dispatch({ runId: ctx.runId, phase, token: ctx.token });
      else {
        const base = new URL(process.env.URL || process.env.DEPLOY_PRIME_URL || "");
        if (base.protocol !== "https:" || !base.hostname.endsWith(".netlify.app")) throw failure("PROBE_DISPATCH_ORIGIN_INVALID");
        const result = await fetch(new URL("/.netlify/functions/runtime-storage-verification-background", base), {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}` },
          body: JSON.stringify({ runId: ctx.runId, phase }), signal: AbortSignal.timeout(10000), redirect: "error"
        });
        status = result.status;
      }
      if (status !== 202) throw failure("PROBE_DISPATCH_REJECTED");
      await ctx.store.setJSON(`dispatch/${phase}`, { phase, requestedAt, acceptedAt: new Date(now()).toISOString(), status: "accepted", httpStatus: status });
    } catch (error) {
      await ctx.store.setJSON("failure", { stage: "dispatch", phase, code: error.code || "PROBE_DISPATCH_FAILED", resumable: true, failedAt: new Date(now()).toISOString() });
      throw failure(error.code || "PROBE_DISPATCH_FAILED");
    }
  }
  const stateDeps = ctx => ({ store: ctx.stateStore, now, uuid });
  async function summary(ctx) {
    const [state, report, failed, first, second] = await Promise.all([
      recovery.read(ctx.jobId, stateDeps(ctx)).catch(error => error.code === "RECOVERY_NOT_FOUND" ? null : Promise.reject(error)),
      ctx.store.get("report", { type: "json" }), ctx.store.get("failure", { type: "json" }),
      ctx.store.get("invocations/1", { type: "json" }), ctx.store.get("invocations/2", { type: "json" })
    ]);
    return { runId: ctx.runId, fixtureJobId: ctx.jobId, status: state?.control.status || "not_started", stage: state?.state.stage || null,
      cursor: state?.state.calculationCursor ?? null, report, failure: failed, invocations: [first, second].filter(Boolean),
      businessApiCalls: 0, businessStoreWrites: 0 };
  }
  async function duplicateAndStale(ctx, lease) {
    const options = stateDeps(ctx);
    let duplicateBlocked = false;
    try { await recovery.claim(ctx.jobId, { invocationId: uuid(), generation: GENERATION }, options); }
    catch (error) { if (error.code !== "LEASE_BUSY") throw error; duplicateBlocked = true; }
    if (!duplicateBlocked) throw failure("PROBE_DUPLICATE_NOT_BLOCKED");
    // Separate synthetic lease timeline; never alter the real verification lease.
    const staleId = "stale-fixture"; let fakeNow = now();
    const staleOptions = { store: scopedStore(ctx.store, "stale-test/"), now: () => fakeNow, leaseMs: 1000, uuid };
    await recovery.initialize(staleId, { synthetic: true }, { generation: GENERATION, totalCount: 1, stage: "numeric" }, staleOptions);
    const old = await recovery.claim(staleId, { invocationId: uuid(), generation: GENERATION }, staleOptions);
    fakeNow += 1001;
    const next = await recovery.claim(staleId, { invocationId: uuid(), generation: GENERATION }, staleOptions);
    let staleBlocked = false;
    try { await recovery.checkpoint(staleId, old.lease, { calculationCursor: 1 }, staleOptions); }
    catch (error) { if (error.code !== "LEASE_FENCED") throw error; staleBlocked = true; }
    await recovery.release(staleId, next.lease, {}, staleOptions);
    await recovery.assertLease(ctx.jobId, GENERATION, lease, options);
    if (!staleBlocked) throw failure("PROBE_STALE_NOT_FENCED");
    return { duplicateBlocked, staleBlocked };
  }
  async function normalWorker(ctx, phase, invocationId) {
    const store = scopedStore(ctx.store, "normal-worker/");
    const options = { store, recoveryStore: scopedStore(ctx.store, "normal-worker-recovery-fence/"), now, owner: invocationId };
    const source = fixture(ctx.jobId);
    if (phase === 1) await store.setJSON(`jobs/${ctx.jobId}`, { ...source.job, results: undefined, state: "running",
      createdAt: new Date(now()).toISOString(), calculationCursor: 0 }, { onlyIfNew: true });
    const claim = await analysis.claimPeriodWorker(ctx.jobId, options);
    if (!claim.claimed) throw failure("PROBE_NORMAL_WORKER_NOT_CLAIMED");
    if (phase === 1) {
      const duplicate = await analysis.claimPeriodWorker(ctx.jobId, options);
      if (duplicate.claimed || duplicate.reason !== "worker-active") throw failure("PROBE_NORMAL_DUPLICATE_NOT_BLOCKED");
      const saved = await analysis.writePeriodInputs(claim.lease, { synthetic: true, rows: source.job.results }, options);
      if (publication.digest((await analysis.readPeriodInputs(saved, options)).rows) !== publication.digest(source.job.results)) throw failure("PROBE_NORMAL_INPUT_MISMATCH");
    } else {
      const checkpoint = await analysis.readPeriodCheckpoint(claim.job, options);
      const inputs = await analysis.readPeriodInputs(claim.job, options);
      if (checkpoint?.calculationCursor !== 1 || checkpoint.rows?.[0]?.keyword !== source.job.results[0].keyword
        || publication.digest(inputs?.rows) !== publication.digest(source.job.results)) throw failure("PROBE_NORMAL_RESUME_MISMATCH");
    }
    await analysis.writePeriodCheckpoint(claim.lease, { jobId: ctx.jobId, calculationCursor: phase, totalCount: 2,
      selectedStartDate: source.job.startDate, selectedEndDate: source.job.endDate, queryStartDate: source.job.queryStartDate,
      requiredWindow: `${source.job.queryStartDate}:${source.job.endDate}`, rows: source.job.results.slice(0, phase) }, options);
    await analysis.writeOwnedPeriodJob(claim.lease, { currentStage: phase === 1 ? "calculation-matching" : "publishing" }, options);
    return { lease: claim.lease, options };
  }
  async function verifyInstantPublication(ctx) {
    const analysisStore = scopedStore(ctx.store, "instant-analysis/");
    const snapshotStore = scopedStore(ctx.store, "instant-snapshots/");
    const options = { analysisStore, snapshotStore };
    const readJob = id => analysisStore.get(`jobs/${id}`, { type: "json" });
    const previous = { ...fixture("instant-fixture-previous").job, mode: "instant", state: "calculated",
      createdAt: "2001-01-04T00:00:00.000Z", calculatedAt: "2001-01-04T00:01:00.000Z", fastPath: false,
      freshFetchCount: 2, trendCollectedAt: "2001-01-04T00:00:30.000Z", triggerSource: "synthetic-scheduler" };
    const next = { ...previous, jobId: "instant-fixture-next", createdAt: "2001-01-05T00:00:00.000Z",
      calculatedAt: "2001-01-05T00:01:00.000Z", trendCollectedAt: "2001-01-05T00:00:30.000Z" };
    await analysisStore.setJSON(`jobs/${previous.jobId}`, previous, { onlyIfNew: true });
    await instantPublication.publishInstant(previous, options);
    await analysisStore.setJSON(`jobs/${next.jobId}`, next, { onlyIfNew: true });
    const visible = async () => Promise.all([
      [snapshotStore, "latest-valid-v1/instant"], [snapshotStore, "latest-collection-v1"],
      [analysisStore, "last-success/instant"], [analysisStore, "last-success/latest"]
    ].map(async ([store, key]) => instantPublication.visiblePointer(await store.get(key, { type: "json" }), readJob)));
    for (const stage of ["snapshot", "last-success"]) {
      let injected = false;
      const target = stage === "snapshot" ? snapshotStore : analysisStore;
      const failing = { ...target, setJSON: async (key, value, condition) => {
        if (!injected && key === (stage === "snapshot" ? `snapshots/${next.jobId}` : "last-success/instant")) {
          injected = true; throw failure("PROBE_INJECTED_INSTANT_FAILURE");
        }
        return target.setJSON(key, value, condition);
      } };
      try { await instantPublication.publishInstant(next, { ...options,
        ...(stage === "snapshot" ? { snapshotStore: failing } : { analysisStore: failing }) }); }
      catch (error) { if (error.code !== "PROBE_INJECTED_INSTANT_FAILURE") throw error; }
      if (!injected || (await readJob(next.jobId))?.state !== "publication_failed"
        || (await visible()).some(pointer => pointer?.jobId !== previous.jobId)) throw failure("PROBE_INSTANT_PREVIOUS_NOT_PROTECTED");
    }
    const published = await instantPublication.publishInstant(next, options);
    if (published.state !== "completed" || published.publicationState !== "published"
      || (await visible()).some(pointer => pointer?.jobId !== next.jobId)) throw failure("PROBE_INSTANT_PUBLICATION_NOT_COMMITTED");
    return { instantPublicationVerified: true, instantPreviousProtected: true,
      instantSnapshotFailureProtected: true, instantLastPointerFailureProtected: true };
  }
  async function runPhase(ctx, lambdaContext = {}) {
    const phase = Number(ctx.body.phase);
    if (![1, 2].includes(phase)) throw failure("PROBE_INVALID_PHASE");
    const before = await recovery.read(ctx.jobId, stateDeps(ctx));
    if (before.control.status === "completed" || phase === 1 && before.state.calculationCursor >= 1) return summary(ctx);
    if (phase === 2 && before.state.calculationCursor !== 1) throw failure("PROBE_CURSOR_MISMATCH");
    const platformRequestId = lambdaContext.awsRequestId || lambdaContext.requestId;
    const hasPlatformId = typeof platformRequestId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(platformRequestId);
    const invocationId = hasPlatformId ? platformRequestId : uuid();
    const owned = await recovery.claim(ctx.jobId, { invocationId, generation: GENERATION }, stateDeps(ctx));
    let lease = owned.lease; let normal = null;
    const enteredAt = new Date(now()).toISOString();
    const native = compat.readEnvironmentContext();
    await ctx.store.setJSON(`invocations/${phase}`, { phase, invocationId, enteredAt, resumedCursor: before.state.calculationCursor,
      platformRequestId: hasPlatformId ? platformRequestId : null, requestIdSource: hasPlatformId ? "runtime" : "generated-fallback",
      nativeStrongEndpointPresent: Boolean(native.uncachedEdgeURL), siteContextPresent: Boolean(native.siteID),
      sdkVersion: require("@netlify/blobs/package.json").version }, { onlyIfNew: true });
    try {
      normal = await normalWorker(ctx, phase, invocationId);
      if (phase === 1) {
        const checks = await duplicateAndStale(ctx, lease);
        const saved = await recovery.checkpoint(ctx.jobId, lease, { calculationCursor: 1, processedCount: 1,
          rows: [fixture(ctx.jobId).job.results[0]], checks }, stateDeps(ctx));
        lease = saved.lease;
        await recovery.release(ctx.jobId, lease, {}, stateDeps(ctx));
        lease = null;
        await analysis.releasePeriodWorker(normal.lease, {}, normal.options); normal = null;
        await dispatch(ctx, 2);
      } else {
        const source = fixture(ctx.jobId);
        if (before.state.rows?.[0]?.keyword !== source.job.results[0].keyword) throw failure("PROBE_CHECKPOINT_CORRUPT");
        const saved = await recovery.checkpoint(ctx.jobId, lease, { stage: "publishing", calculationCursor: 2, processedCount: 2,
          rows: source.job.results }, stateDeps(ctx));
        lease = saved.lease;
        const input = { ...source, generation: 1, leaseToken: lease.token };
        const guard = async () => { await recovery.assertLease(ctx.jobId, GENERATION, lease, stateDeps(ctx));
          await analysis.assertPeriodWorker(normal.lease, normal.options); };
        let injected = false;
        const failingStore = { ...ctx.publicationStore, setJSON: async (key, value, options) => {
          if (!injected && key.includes("/snapshot-")) { injected = true; throw failure("PROBE_INJECTED_SNAPSHOT_FAILURE"); }
          return ctx.publicationStore.setJSON(key, value, options);
        } };
        try { await publication.publishPeriod(input, { store: failingStore, assertLease: guard }); }
        catch (error) { if (error.code !== "PROBE_INJECTED_SNAPSHOT_FAILURE") throw error; }
        if (!injected || await publication.readLatest({ store: ctx.publicationStore })) throw failure("PROBE_FAILED_PUBLICATION_VISIBLE");
        const published = await publication.publishPeriod(input, { store: ctx.publicationStore, assertLease: guard });
        const latest = await publication.readLatest({ store: ctx.publicationStore });
        const exact = await publication.readPublishedJob(ctx.jobId, { store: ctx.publicationStore });
        if (latest?.job.jobId !== ctx.jobId || exact?.job.jobId !== ctx.jobId
          || publication.digest(exact.job.results) !== publication.digest(source.job.results)) throw failure("PROBE_READER_MISMATCH");
        const workbook = await excel.buildWorkbook(fixtureExcel(exact.job));
        const sheet = workbook.getWorksheet("07_선택기간분석");
        const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
        if (!sheet || !workbook.getWorksheet("00_요약") || buffer.length === 0
          || sheet.getCell(8, 2).value !== exact.job.results.length
          || exact.job.results.some((row, index) => sheet.getCell(index + 12, 3).value !== row.keyword)) throw failure("PROBE_EXPORT_MISMATCH");
        const instantChecks = await verifyInstantPublication(ctx);
        await guard();
        const report = { ...before.state.checks, publicationFailureProtected: true, publicationRetrySucceeded: true,
          ...instantChecks,
          normalWorkerClaimVerified: true, normalWorkerFrozenInputsVerified: true, normalWorkerCheckpointResumeVerified: true,
          exactReaderJobId: exact.job.jobId, latestReaderJobId: latest.job.jobId, resultCount: exact.job.results.length,
          resultDigest: publication.digest(exact.job.results), snapshotDigest: published.commit.snapshotHash,
          excelPeriodJobId: exact.job.jobId, excelResultCount: exact.job.results.length, excelGeneratedBytes: buffer.length,
          excelSheets: workbook.worksheets.map(value => value.name), completedAt: new Date(now()).toISOString() };
        await ctx.store.setJSON("report", report, { onlyIfNew: true });
        await analysis.releasePeriodWorker(normal.lease, { state: "completed", currentStage: "completed" }, normal.options); normal = null;
        await recovery.checkpoint(ctx.jobId, lease, { stage: "completed", publicationVerified: true, report }, stateDeps(ctx));
        lease = null;
      }
      await ctx.store.setJSON(`invocations/${phase}-exit`, { invocationId, exitedAt: new Date(now()).toISOString(), outcome: "completed" }, { onlyIfNew: true });
      return summary(ctx);
    } catch (error) {
      if (normal) await analysis.releasePeriodWorker(normal.lease, { state: "publication_failed" }, normal.options).catch(() => null);
      if (lease) await recovery.markFailure(ctx.jobId, lease, error, stateDeps(ctx)).catch(() => null);
      await ctx.store.setJSON("failure", { stage: phase === 1 ? "checkpoint" : "publication", phase,
        code: error.code || "PROBE_EXECUTION_FAILED", resumable: true, failedAt: new Date(now()).toISOString() });
      throw error;
    }
  }
  async function handle(event, background = false, lambdaContext = {}) {
    try {
      if (!["GET", "POST"].includes(event.httpMethod)) return response(405, { code: "METHOD_NOT_ALLOWED" });
      const ctx = await authorize(event);
      if (background) {
        if (event.httpMethod !== "POST") return response(405, { code: "METHOD_NOT_ALLOWED" });
        return response(200, await runPhase(ctx, lambdaContext));
      }
      if (event.httpMethod === "GET") {
        if (event.queryStringParameters?.export === "1") {
          const published = await publication.readPublishedJob(ctx.jobId, { store: ctx.publicationStore });
          if (!published) return response(409, { code: "PROBE_NOT_PUBLISHED" });
          const buffer = await excel.toBuffer(fixtureExcel(published.job));
          return { statusCode: 200, headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Cache-Control": "no-store" }, isBase64Encoded: true, body: buffer.toString("base64") };
        }
        return response(200, await summary(ctx));
      }
      const started = await ctx.store.setJSON("start", { startedAt: new Date(now()).toISOString(), fixtureJobId: ctx.jobId }, { onlyIfNew: true });
      if (started?.modified === false) return response(200, { ...await summary(ctx), existing: true });
      await recovery.initialize(ctx.jobId, { synthetic: true, rows: fixture(ctx.jobId).job.results },
        { generation: GENERATION, stage: "numeric", totalCount: 2, ratioTotalCount: 0, evidenceTotalCount: 0, candidateCount: 2, processedCount: 0 }, stateDeps(ctx));
      await dispatch(ctx, 1);
      return response(202, { runId: ctx.runId, fixtureJobId: ctx.jobId, status: "dispatched", businessApiCalls: 0, businessStoreWrites: 0 });
    } catch (error) {
      const code = /^[A-Z0-9_]{1,100}$/.test(error.code || "") ? error.code : "PROBE_EXECUTION_FAILED";
      return response(code === "PROBE_AUTH_REQUIRED" ? 403 : code === "LEASE_BUSY" ? 409 : 503, { code });
    }
  }
  return { handler: (event, context) => handle(event, false, context), backgroundHandler: (event, context) => handle(event, true, context) };
}
const handlers = createHandlers();
exports.handler = handlers.handler;
exports.backgroundHandler = handlers.backgroundHandler;
exports._test = { createHandlers, scopedStore, fixture, fixtureExcel, STORE_NAME };
