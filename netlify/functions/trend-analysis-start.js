const { connect, acquireJob, writeJob, readJob, readCurrentJob } = require("./trend-analysis-cache");
const { connect: connectQuota, reserveUncertainHistoricalUsage } = require("./trend-api-quota");
const { connect: connectSnapshot, readLatest: readLatestSnapshot } = require("./signal-snapshot-cache");
const { readCandidateCache } = require("./keyword-candidate-cache");
const { readCache: readProductCache } = require("./search-ad-cache");
const { readOperatingSettings } = require("./operating-settings-cache");
const { getCompatibleStore } = require("./blob-store-compat");
const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) });

function isoDate(date) { return date.toISOString().slice(0, 10); }
function seoulDate() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function inclusiveDays(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`); const end = new Date(`${endDate}T00:00:00Z`);
  return Math.round((end - start) / 86400000) + 1;
}
function analysisQueryStart(mode, start, end) {
  const queryStart = new Date(end); queryStart.setUTCDate(end.getUTCDate() - 30);
  if (mode === "period") {
    const baselineStart = new Date(start); baselineStart.setUTCDate(start.getUTCDate() - 7);
    if (baselineStart < queryStart) queryStart.setTime(baselineStart.getTime());
  }
  return queryStart;
}
function jobMetadata(job) {
  return { jobId: job?.jobId || null, mode: job?.mode || null, fastPath: Boolean(job?.fastPath),
    historicalCollection: Boolean(job?.historicalCollection), startDate: job?.startDate || null,
    endDate: job?.endDate || null, queryStartDate: job?.queryStartDate || null, state: job?.state || null,
    ...(job?.collectionScope ? { collectionScope: job.collectionScope } : {}) };
}
function matchesRequestedJob(job, request) {
  return Boolean(job && job.mode === request.mode && Boolean(job.fastPath) === Boolean(request.fastPath)
    && Boolean(job.historicalCollection) === Boolean(request.historicalCollection)
    && job.startDate === request.startDate && job.endDate === request.endDate
    && job.queryStartDate === request.queryStartDate && (job.collectionScope || null) === (request.collectionScope || null));
}

async function recordInstantDispatchFailure(createdJob, failure, options = {}) {
  const blobStore = options.store || getCompatibleStore({ name: "trend-analysis", consistency: "strong" });
  for (let attempt = 0; attempt < 5; attempt++) {
    const entry = await blobStore.getWithMetadata(`jobs/${createdJob.jobId}`, { type: "json" });
    const current = entry?.data;
    if (!current || current.mode !== "instant" || current.createdAt !== createdJob.createdAt)
      return { modified: false, job: current || null, reason: "identity-changed" };
    const advanced = current.state !== "running" || Boolean(current.instantWorker || current.instantInputsKey || current.instantStateKey)
      || Number(current.invocationCount || 0) > 0 || Array.isArray(current.results)
      || current.updatedAt !== createdJob.updatedAt || Number(current.progress || 0) > Number(createdJob.progress || 0)
      || Number(current.processedCount || 0) > Number(createdJob.processedCount || 0);
    if (advanced) return { modified: false, job: current, reason: "worker-progressed" };
    const at = new Date(options.now ? options.now() : Date.now()).toISOString();
    const patch = options.ambiguous ? { dispatchState: "unknown", dispatchErrorAt: at,
      dispatchErrorCode: failure.code || failure.name || "DISPATCH_RESPONSE_UNKNOWN",
      message: "Background 접수 응답 확인 중 · 같은 작업의 진행 상태를 확인합니다." }
      : { state: "failed", dispatchState: "rejected", message: "분석 시작 실패", errors: [failure.message], failedAt: at };
    const next = { ...current, ...patch, updatedAt: at };
    if ((await blobStore.setJSON(`jobs/${createdJob.jobId}`, next, { onlyIfMatch: entry.etag }))?.modified)
      return { modified: true, job: next, reason: options.ambiguous ? "response-unknown" : "dispatch-rejected" };
  }
  throw Object.assign(new Error("Instant dispatch state changed concurrently; existing progress was preserved."), { code: "INSTANT_DISPATCH_STATE_CONFLICT" });
}

async function handle(event, { fastPath = true } = {}) {
  connect(event); connectSnapshot(event); connectQuota(event);
  if (event.httpMethod !== "POST") return json(405, { error: "POST 요청만 허용됩니다." });
  let createdJob, dispatchAttempted = false;
  try {
    const input = JSON.parse(event.body || "{}");
    const mode = input.mode === "instant" ? "instant" : "period";
    if (input.collectionScope !== undefined && (input.collectionScope !== "search-trend-only" || mode !== "instant" || fastPath))
      return json(400, { error: "Search Trend 전용 수집은 즉시 분석 Slow Path에서만 사용할 수 있습니다.", errorCode: "INVALID_COLLECTION_SCOPE" });
    const collectionScope = input.collectionScope;
    const { surgeThreshold, matchThreshold } = await readOperatingSettings();
    let startDate = String(input.startDate || "");
    let endDate = String(input.endDate || "");
    if (mode === "instant") {
      const end = new Date(`${seoulDate()}T00:00:00Z`);
      if (input.targetDataDate !== undefined) {
        if (fastPath || collectionScope !== "search-trend-only" || !/^\d{4}-\d{2}-\d{2}$/.test(input.targetDataDate))
          return json(400, { error: "고정 목표일은 Search Trend 전용 복구 수집에서만 지정할 수 있습니다." });
        const target = new Date(`${input.targetDataDate}T00:00:00Z`);
        if (!Number.isFinite(target.getTime()) || isoDate(target) !== input.targetDataDate || target >= end || end - target > 31 * 86400000)
          return json(400, { error: "유효한 과거 목표일(최근 31일)을 지정해주세요." });
        end.setTime(target.getTime() + 86400000);
      }
      const start = new Date(end); start.setDate(end.getDate() - 29);
      startDate = isoDate(start); endDate = isoDate(end);
    }
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    const days = inclusiveDays(startDate, endDate);
    if (!Number.isFinite(days) || days < 1 || days > 31) return json(400, { error: "분석 기간은 1~31일이어야 합니다." });
    const queryStart = analysisQueryStart(mode, start, end);
    if (fastPath) {
      const snapshot = await readLatestSnapshot(mode).catch(() => null);
      if (snapshot?.jobId && snapshot.mode === mode && snapshot.startDate === startDate && snapshot.endDate === endDate
        && Number(snapshot.surgeThreshold) === Number(surgeThreshold) && Number(snapshot.matchThreshold) === Number(matchThreshold)) {
        const snapshotJob = await readJob(snapshot.jobId).catch(() => null);
        if (snapshotJob?.state === "completed") return json(200, { jobId: snapshotJob.jobId, existing: false, fastPath: true,
          cachedSnapshot: true, message: "동일 조건의 최신 signal snapshot을 즉시 사용합니다." });
      }
    }
    const [candidateCache, productCache] = await Promise.all([readCandidateCache(), readProductCache()]);
    if (!candidateCache?.candidates?.length) return json(409, { error: "검색어 후보 데이터가 없습니다. 먼저 '검색어 후보 새로고침'을 실행해주세요." });
    if (!productCache?.items?.length) return json(409, { error: "Search Ad 전체 상품 데이터가 없습니다. 먼저 'Search Ad 상품 새로고침'을 실행해주세요." });
    const triggerSource = String(input.triggerSource || (fastPath ? "user-fast-path" : "admin-manual"));
    const schedulerExecutionId = input.schedulerExecutionId ? String(input.schedulerExecutionId) : null;
    const historicalCollection = mode === "period" && !fastPath;
    const staleJob = historicalCollection ? await readCurrentJob({ includeStale: true }).catch(() => null) : null;
    if (staleJob?.stale && staleJob.historicalCollection && !staleJob.workerLease && !staleJob.uncertainUsageReserved
      && ["calculation-matching", "calculation-checkpoint", "interrupted"].includes(staleJob.currentStage)) {
      const riskCalls = Math.min(1000, Math.max(0, Number(staleJob.historicalRequiredCalls || 1000)));
      if (riskCalls) {
        await reserveUncertainHistoricalUsage(riskCalls);
        await writeJob(staleJob.jobId, { ...staleJob, uncertainUsageReserved: true,
          uncertainUsageReserveCalls: riskCalls, uncertainUsageReservedAt: new Date().toISOString() });
      }
    }
    const requestedJob = { mode, startDate, endDate, queryStartDate: isoDate(queryStart), fastPath, historicalCollection,
      ...(collectionScope ? { collectionScope } : {}) };
    let collectionObservationStartedAt;
    if (input.reuseCollectionJobId !== undefined) {
      if (mode !== "instant" || fastPath || collectionScope !== "search-trend-only")
        return json(400, { error: "응답 재사용은 Search Trend 전용 복구 수집에서만 가능합니다." });
      const previous = await readJob(String(input.reuseCollectionJobId));
      if (!previous || previous.mode !== "instant" || previous.queryStartDate !== requestedJob.queryStartDate || previous.endDate !== endDate
        || !Number.isFinite(Date.parse(previous.createdAt)) || !Number(previous.searchTrendHttp200Count || previous.apiMetrics?.searchTrend?.http200))
        return json(409, { error: "이전 수집의 동일 window·성공 응답을 확인할 수 없습니다." });
      collectionObservationStartedAt = previous.createdAt;
    }
    const acquired = await acquireJob({ ...requestedJob, surgeThreshold, matchThreshold,
      ...(mode === "instant" ? { targetDataDate: isoDate(new Date(end.getTime() - 86400000)),
        calculationVersion: require("./surge-history-cache").CALCULATION_VERSION } : {}),
      ...(collectionObservationStartedAt ? { collectionObservationStartedAt, reusedCollectionJobId: String(input.reuseCollectionJobId) } : {}),
      triggerSource, schedulerExecutionId,
      currentStage: "preparing", processedCount: 0, totalCount: 0 });
    const job = acquired.job;
    createdJob = job;
    if (acquired.existing) {
      const metadata = jobMetadata(job);
      if ((historicalCollection || collectionScope) && !matchesRequestedJob(job, requestedJob)) return json(409, { error: "요청과 다른 분석 Job이 아직 실행 상태로 보입니다.",
        errorCode: "INCOMPATIBLE_ACTIVE_JOB", retryable: true, existing: true, ...metadata });
      return json(200, { existing: true, ...metadata,
        message: "동일한 Background 작업이 실행 중입니다. 기존 진행 상태에 연결합니다." });
    }
    if (mode === "instant") {
      await require("./instant-dispatch").enqueueInitial(job.jobId);
      return json(202, { existing: false, ...jobMetadata(job), dispatchState: "pending",
        message: "분석 작업을 예약했습니다. 서버가 자동으로 수집·계산·게시를 이어갑니다." });
    }
    const baseUrl = String(process.env.URL || "").replace(/\/$/, "");
    dispatchAttempted = true;
    const response = await fetch(`${baseUrl}/.netlify/functions/trend-analysis-background`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: job.jobId, job })
    });
    if (!response.ok && response.status !== 202) throw Object.assign(new Error(`분석 Background Function 시작 실패: HTTP ${response.status}`),
      { code: "BACKGROUND_DISPATCH_REJECTED", status: response.status });
    return json(202, { existing: false, ...jobMetadata(job),
      message: fastPath ? "저장된 최신 데이터로 분석을 시작했습니다." : "최신 데이터 Background 수집을 시작했습니다." });
  } catch (error) {
    if (createdJob?.mode === "instant") {
      const ambiguous = dispatchAttempted && error.code !== "BACKGROUND_DISPATCH_REJECTED";
      const saved = await recordInstantDispatchFailure(createdJob, error, { ambiguous }).catch(() => null);
      if (ambiguous || saved?.reason === "worker-progressed") return json(202, { existing: false,
        ...jobMetadata(saved?.job || createdJob), dispatchState: ambiguous ? "unknown" : "worker-progressed",
        message: "서버 접수 응답을 확인 중입니다. 추가 실행 없이 같은 작업의 진행 상태를 확인합니다." });
    } else if (createdJob) await writeJob(createdJob.jobId, { ...createdJob, state: "failed", message: "분석 시작 실패", errors: [error.message], updatedAt: new Date().toISOString() }).catch(() => {});
    return json(500, { error: error.message || "분석 시작 실패" });
  }
}
exports.handler = (event) => handle(event, { fastPath: true });
exports.handle = handle;
exports._test = { inclusiveDays, analysisQueryStart, isoDate, jobMetadata, matchesRequestedJob, recordInstantDispatchFailure };
