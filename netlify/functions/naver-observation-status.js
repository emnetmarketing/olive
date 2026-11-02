// Read-only presentation of independently evidenced facts. No selection or calculation policy.
const { normalizedKeyword: normalize } = require('./trend-series-cache');
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
  && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value ? value : null;
const instant = job => Boolean(job?.jobId && job.mode === 'instant');
function safeErrorCode(value) {
  const text = String(value || ''), http = /^(HTTP_[1-5]\d{2})(?=$|[\s:])/.exec(text);
  if (http) return http[1];
  return new Set(['QUOTA_BUDGET_EXHAUSTED', 'EMERGENCY_DISPATCH_STOPPED', 'REQUEST_OUTCOME_UNKNOWN',
    'MISSING_RESPONSE_GROUP', 'FETCH_ERROR', 'ECONNRESET', 'ETIMEDOUT', 'INSTANT_DISPATCH_FAILED'])
    .has(text) ? text : null;
}
function requiredWindow(job) {
  const stored = typeof job?.requiredWindow === 'string' ? job.requiredWindow.split(':') : [];
  const startDate = date(job?.queryStartDate || job?.requiredWindow?.startDate || stored[0]);
  const endDate = date(job?.endDate || job?.requiredWindow?.endDate || stored[1]);
  return startDate && endDate && startDate <= endDate ? { startDate, endDate } : null;
}
function sameIdentity(value, job) {
  if (!instant(job) || !value || value.jobId !== job.jobId || value.mode && value.mode !== 'instant') return false;
  const window = requiredWindow(job);
  return ['startDate', 'endDate', 'queryStartDate'].every(key => !value[key] || value[key] === job[key])
    && (!value.selectedStartDate || value.selectedStartDate === job.startDate)
    && (!value.selectedEndDate || value.selectedEndDate === job.endDate)
    && (!value.requiredWindow || value.requiredWindow === `${window?.startDate}:${window?.endDate}`)
    && (!value.targetDataDate || value.targetDataDate === job.targetDataDate);
}
function compatibleDiagnostic(diagnostic, job) {
  return sameIdentity(diagnostic, job) && diagnostic.mode === 'instant'
    && diagnostic.startDate === job.startDate && diagnostic.endDate === job.endDate;
}
function cacheData(entry, window, target) {
  const missing = { state: 'missing', label: '데이터 미확보', actualStartDate: null, actualDataDate: null,
    fetchedAt: null, targetObserved: false, windowCompatible: null };
  if (!entry) return missing;
  const records = Array.isArray(entry.rawRatioSeries) ? [entry] : [entry.search, ...Object.values(entry.searchWindows || {})].filter(Boolean);
  const covers = record => Boolean(window && date(record?.requestStartDate) && date(record?.requestEndDate)
    && record.requestStartDate <= window.startDate && record.requestEndDate >= window.endDate);
  const ordered = records.slice().sort((a, b) => (Date.parse(b.fetchedAt || '') || 0) - (Date.parse(a.fetchedAt || '') || 0));
  const record = ordered.find(covers) || ordered[0];
  if (!record) return missing;
  const valid = record.version === 1 && record.normalizationVersion === 'keyword-v1' && record.timeUnit === 'date'
    && Array.isArray(record.rawRatioSeries) && record.rawRatioSeries.every(point => date(point?.period)
      && point.ratio !== null && point.ratio !== '' && Number.isFinite(Number(point.ratio)));
  const periods = valid ? record.rawRatioSeries.map(point => point.period).sort() : [];
  const targetObserved = Boolean(target && periods.includes(target));
  const windowCompatible = window ? covers(record) : null;
  const state = !valid ? 'invalid' : window && !windowCompatible ? 'window-unavailable'
    : !periods.length ? 'empty' : targetObserved ? 'target-observed' : 'cached-before-target';
  const labels = { invalid: '저장 자료 유효성 확인 불가', 'window-unavailable': '분석 기간 데이터 부족 · 저장 자료 있음',
    empty: '조회 완료 · 데이터 없음', 'target-observed': '검색 추이 데이터 있음 · 목표일 관측 있음',
    'cached-before-target': '검색 추이 데이터 있음 · 목표일 미확인' };
  if (state === 'window-unavailable' && valid && !periods.length) labels[state] = '분석 기간 데이터 부족 · 기존 조회는 빈 응답';
  return { state, label: labels[state], actualStartDate: periods[0] || null, actualDataDate: periods.at(-1) || null,
    fetchedAt: Number.isFinite(Date.parse(record.fetchedAt || '')) ? record.fetchedAt : null,
    targetObserved, windowCompatible, emptyResponse: valid && !periods.length,
    requestStartDate: date(record.requestStartDate), requestEndDate: date(record.requestEndDate),
    source: entry.search === record ? 'automatic-cache' : entry.rawRatioSeries ? 'saved-record' : 'historical-window-cache' };
}
function collectionStatus(options) {
  const { key, job, input, checkpoint, diagnosticItem: trace, diagnosticCompatible, now } = options;
  const unknown = { state: 'unknown', label: '실제 수집 예약·실행 기록 확인 불가' };
  if (!instant(job)) return unknown;
  const stateKnown = sameIdentity(checkpoint, job), inputKnown = sameIdentity(input, job);
  const index = Number.isInteger(options.queueIndex) ? options.queueIndex
    : inputKnown && Array.isArray(input.queue) ? input.queue.findIndex(item => normalize(item.keyword) === key) : -1;
  const known = Boolean(inputKnown && (options.queueKnown || Array.isArray(input.queue)));
  // A terminal Job wins over a retained checkpoint/ticket. Historical processing is not a live reservation.
  if (diagnosticCompatible && trace?.collectionError) {
    const code = safeErrorCode(trace.collectionError);
    if (code === 'QUOTA_BUDGET_EXHAUSTED') return { state: 'budget-held', label: '해당 Job 내부 수집 예산 제한 · 일/월 구분 기록 없음', errorCode: code };
    return { state: 'error', label: `해당 Job 조회 오류: ${code || '원인 코드 확인 불가'}`, errorCode: code };
  }
  if (diagnosticCompatible && ['daily_budget_exhausted', 'internal_budget_wait'].includes(trace?.trendWaitReason)) {
    const stamp = trace.trendFetchedAt || trace.updatedAt || job.completedAt;
    const day = value => /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value || '') && Number.isFinite(Date.parse(value))
      ? new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 10) : null;
    const today = Number.isFinite(now) ? new Date(now + 9 * 3600000).toISOString().slice(0, 10) : null;
    return { state: 'budget-held', label: trace.trendWaitReason === 'daily_budget_exhausted' && day(stamp) === today
      ? '오늘 수집 예산 소진' : '해당 Job 내부 예산 보류 · 현재 잔여 예산은 별도 확인', errorCode: trace.trendWaitReason };
  }
  if (job.state === 'completed' || job.state === 'deferred') {
    if (diagnosticCompatible && ['valid', 'empty'].includes(trace?.searchTrendStatus)) return { state: 'processed',
      label: trace.cacheHit ? '저장 캐시로 처리됨 · 신규 호출을 뜻하지 않음' : '해당 Job 데이터 처리 기록 있음' };
    return { state: 'not-queued', label: '기준 Job 수집 종료 · 다른 작업의 예약 여부는 확인 불가' };
  }
  if (['failed', 'interrupted', 'continuation_failed', 'publication_failed'].includes(job.state) || job.stale)
    return { state: 'interrupted', label: '작업 중단 기록 · 현재 수집 대기로 간주하지 않음', errorCode: safeErrorCode(job.errorCode) };
  const dispatch = job.continuationDispatch, lease = job.instantWorker;
  const live = Boolean(lease?.token && Number(lease.expiresAt) > now);
  const running = ['running', 'publishing'].includes(job.state);
  const inFlight = stateKnown && checkpoint.inflight?.items?.some(item => normalize(item.keyword) === key);
  const entered = Boolean(dispatch?.ticket && dispatch.state === 'entered' && dispatch.workerFence === lease?.fence && dispatch.invocationId === lease?.owner);
  if (inFlight && running && live && entered) return { state: 'running', label: '수집 중', startedAt: checkpoint.inflight.startedAt || null };
  if (inFlight) return { state: 'unknown', label: '저장된 수집 시도 있음 · 현재 실행·응답 완료 여부 확인 불가' };
  const cursor = stateKnown ? Number(checkpoint.stage === 'collection' ? checkpoint.cursor : checkpoint.collectionCursor) : null;
  if (index >= 0 && Number.isSafeInteger(cursor) && index < cursor)
    return { state: 'processed', label: '저장된 수집 시도 처리 기록 있음 · 데이터 상태 별도 확인' };
  if (index >= 0 && running && stateKnown && checkpoint.stage === 'collection') {
    const scheduled = options.registered === true && dispatch?.ticket
      && ['pending', 'dispatching', 'accepted', 'entered'].includes(dispatch.state) && !dispatch.attemptsExhausted;
    if (checkpoint.targetDatePreflight?.status === 'waiting') return { state: 'waiting-target-date',
      label: scheduled ? '표본에서 목표일 미확인 · 예약된 재확인 대기' : '표본에서 목표일 미확인 · 재확인 예약은 확인 불가',
      nextCheckAt: checkpoint.targetDatePreflight.nextCheckAt || null };
    if (live && entered || scheduled) return { state: 'queued', label: '수집 대기 · 실제 Job 예약 기록 있음', readyAt: dispatch?.readyAt || null };
    return { state: 'unknown', label: '수집 계획에 포함됨 · 실제 실행 예약은 확인 불가' };
  }
  return known && index < 0 ? { state: 'not-queued', label: '해당 Job 추가 수집 대기열에 없음' } : unknown;
}
function assessmentStatus({ job, targetDataDate, diagnostic, diagnosticItem, result }) {
  const unknown = { state: 'unknown', label: '해당 날짜 급등 판정 기록 확인 불가', assessedDataDate: null };
  if (!instant(job) || job.state !== 'completed' || job.publicationState && job.publicationState !== 'published'
    || !targetDataDate || job.targetDataDate !== targetDataDate) return unknown;
  const trace = compatibleDiagnostic(diagnostic, job) && diagnostic.completedAt && diagnosticItem?.latestDataDate === targetDataDate ? diagnosticItem : null;
  const finalRow = result?.latestDataDate === targetDataDate ? result : null, evidence = trace || finalRow;
  if (!evidence) return unknown;
  if (evidence.absoluteSurgePassed === true || evidence.relativeSurgePassed === true) return { state: 'surge-confirmed',
    label: '해당 날짜 NAVER 상승 확인 · 급등 수치 조건 충족', assessedDataDate: targetDataDate,
    finalIncluded: typeof trace?.finalIncluded === 'boolean' ? trace.finalIncluded : Boolean(finalRow), exclusionReason: trace?.exclusionReason || null };
  if (evidence.lowIntensityTrendPassed === true) return { state: 'leading-signal',
    label: '해당 날짜 NAVER 선행 상승 조건 충족 · 급등 확정과 별도', assessedDataDate: targetDataDate,
    finalIncluded: typeof trace?.finalIncluded === 'boolean' ? trace.finalIncluded : Boolean(finalRow), exclusionReason: trace?.exclusionReason || null };
  if (trace && trace.ratioOnly !== true && trace.absoluteSurgePassed === false && trace.relativeSurgePassed === false
    && trace.lowIntensityTrendPassed === false && trace.exclusionReason === '급등 수치 조건 미달')
    return { state: 'criteria-not-met', label: '해당 날짜 조회·분석 완료 · 급등 기준 미충족', assessedDataDate: targetDataDate };
  // ratio-only latest date is not the date of its peak; final inclusion alone is not a dated surge verdict.
  return unknown;
}
function resolveNaverObservationStatus(options = {}) {
  const key = normalize(options.key || options.keyword), job = instant(options.job) ? options.job : null;
  const targetDataDate = date(options.targetDataDate || job?.targetDataDate), window = requiredWindow(job);
  const diagnosticCompatible = compatibleDiagnostic(options.diagnostic, job);
  const raw = diagnosticCompatible ? options.diagnosticItem || options.diagnostic?.items?.find(row => normalize(row.normalizedKeyword || row.keyword) === key) : null;
  const diagnosticItem = normalize(raw?.normalizedKeyword || raw?.keyword) === key ? raw : null;
  const result = normalize(options.result?.keyword) === key ? options.result : null;
  const membership = sameIdentity(options.selectionEvidence, job) ? options.selectionEvidence : null;
  const selected = membership?.selected === true || diagnosticItem?.selectedForAnalysis === true || Boolean(result && job?.state === 'completed');
  const selection = selected ? { state: 'selected', basis: membership?.basis || 'same-job-diagnostic', rank: membership?.rank || null }
    : membership?.complete === true ? { state: 'not-selected', basis: membership.basis } : { state: 'unknown', basis: 'insufficient-saved-evidence' };
  const now = options.now == null ? Date.now() : new Date(options.now).getTime();
  return { version: 1, jobId: job?.jobId || null, jobTargetDataDate: date(job?.targetDataDate), targetDataDate,
    requiredWindow: window ? `${window.startDate}:${window.endDate}` : null, selection,
    data: options.cacheReadFailed ? { state: 'unknown', label: '저장 데이터 조회 실패 · 보유 여부 확인 불가',
      actualStartDate: null, actualDataDate: null, fetchedAt: null, targetObserved: null, windowCompatible: null } : cacheData(options.entry, window, targetDataDate),
    collection: { ...collectionStatus({ ...options, key, job, diagnosticItem, diagnosticCompatible, checkpoint: options.checkpoint, now }), jobId: job?.jobId || null },
    assessment: assessmentStatus({ ...options, job, targetDataDate, diagnosticItem, result }) };
}
module.exports = { resolveNaverObservationStatus, requiredWindow, compatibleDiagnostic, sameIdentity, normalize, date };
