// No provider clients: this module operates only on pinned recovery inputs.
const { calculation } = require('./trend-analysis-background');
const { buildPeriodMarketEvidence, calculatePeriodMarketConfidence } = require('./period-market-evidence');
const { normalizeKeyword } = require('./surge-history-cache');
const { digest } = require('./period-publication');
const crypto = require('node:crypto');
const SAFE_EXECUTION_MS = 180000;
const MAX_ITEMS = 250;
const clone = value => JSON.parse(JSON.stringify(value));
function seriesOf(value) { return Array.isArray(value) ? value : value?.series; }
function validate(input) {
  const { job, checkpoint: cp, numericCandidates, ratioCandidates } = input;
  if (job?.mode !== 'period' || cp?.jobId !== job.jobId || cp.selectedStartDate !== job.startDate
    || cp.selectedEndDate !== job.endDate || cp.queryStartDate !== job.queryStartDate
    || cp.requiredWindow !== `${job.queryStartDate}:${job.endDate}`
    || cp.eligibleKeywords.length !== numericCandidates.length
    || cp.eligibleKeywords.some((key, i) => key !== numericCandidates[i].keyword)
    || cp.calculationCursor < 0 || cp.calculationCursor > numericCandidates.length)
    throw new Error('RECOVERY_CHECKPOINT_INCOMPATIBLE');
  const candidates = [...numericCandidates, ...ratioCandidates];
  if (input.codeVersion) {
    const originalRatio = cp.analysisTrace.filter(t => t.selectionType === 'ratio-only').map(t => t.keyword);
    if (cp.version !== input.codeVersion.checkpointVersion || cp.processedCount !== cp.calculationCursor
      || originalRatio.length !== ratioCandidates.length || originalRatio.some((key,i) => key !== ratioCandidates[i].keyword))
      throw new Error('RECOVERY_ORIGINAL_SCOPE_CHANGED');
  }
  if (new Set(candidates.map(c => normalizeKeyword(c.keyword))).size !== candidates.length)
    throw new Error('RECOVERY_DUPLICATE_INPUT');
  for (const candidate of candidates) {
    const cached = input.trendEntries[candidate.keyword];
    if (!Array.isArray(seriesOf(cached)))
      throw new Error(`RECOVERY_CACHE_MISSING: ${candidate.keyword}`);
    if (cached?.record) {
      if (cached.record.source !== 'search' || !cached.record.requestStartDate || !cached.record.requestEndDate
        || cached.record.requestStartDate > job.queryStartDate || cached.record.requestEndDate < job.endDate)
        throw new Error('RECOVERY_CACHE_WINDOW_CHANGED');
      if (cached.recordDigest !== crypto.createHash('sha256').update(JSON.stringify(cached.record)).digest('hex'))
        throw new Error('RECOVERY_CACHE_RECORD_CHANGED');
      const selected = cached.record.rawRatioSeries.filter(point => point.period >= job.queryStartDate && point.period <= job.endDate);
      if (digest(selected) !== digest(cached.series)) throw new Error('RECOVERY_CACHE_SERIES_CHANGED');
    }
  }
  return true;
}
function initialState(input) {
  validate(input);
  const cp = clone(input.checkpoint);
  return { ...cp, stage: 'numeric', calculationCursor: cp.calculationCursor, ratioCursor: 0, evidenceCursor: 0,
    processedCount: cp.calculationCursor, totalCount: input.numericCandidates.length, ratioTotalCount: input.ratioCandidates.length,
    candidateCount: input.numericCandidates.length + input.ratioCandidates.length,
    continuationCount: 0, pinnedInputHash: digest(input), generation: input.generation,
    originalCheckpointAt: cp.updatedAt };
}
function dataCoverage(input) {
  const candidates = [...input.numericCandidates, ...input.ratioCandidates];
  const series = candidates.map(c => seriesOf(input.trendEntries[c.keyword]));
  const dates = series.flat().map(p => p.period).filter(Boolean).sort();
  const selectedDates = dates.filter(d => d >= input.job.startDate && d <= input.job.endDate);
  return { cacheAvailableCount: candidates.length, validSeriesCandidateCount: series.filter(s => s.length).length,
    emptySeriesCandidateCount: series.filter(s => !s.length).length,
    actualDataStartDate: selectedDates[0] || null, actualDataEndDate: selectedDates.at(-1) || null,
    cachedDataStartDate: dates[0] || null, cachedDataEndDate: dates.at(-1) || null };
}
function finalize(input, state, now) {
  const rows = state.rows;
  rows.sort((a,b) => Number(b.estimatedSurgeCount || 0) - Number(a.estimatedSurgeCount || 0)
    || Number(b.relativeRatioLift || 0) - Number(a.relativeRatioLift || 0)
    || b.shoppingRise - a.shoppingRise || b.trendSlope - a.trendSlope);
  if (new Set(rows.map(r => normalizeKeyword(r.keyword))).size !== rows.length) throw new Error('RECOVERY_DUPLICATE_RESULT');
  const coverage = dataCoverage(input);
  const total = state.candidateCount;
  const included = new Map(rows.map(row => [normalizeKeyword(row.keyword), row]));
  for (const trace of state.analysisTrace) {
    const row = included.get(trace.normalizedKeyword);
    trace.finalIncluded = Boolean(row); trace.resultType = row?.resultType || null;
    trace.exclusionReason = row ? null : trace.searchTrendStatus === 'empty' ? 'Search Trend 시계열 없음'
      : trace.ratioOnly && Number(trace.relativeRatioLift || 0) < 50 ? 'ratio-only 상대 변화 기준 미달'
        : !trace.ratioOnly && !trace.absoluteSurgePassed && !trace.relativeSurgePassed && !trace.lowIntensityTrendPassed ? '급등 수치 조건 미달'
          : '상품·브랜드·도메인 관련 근거 부족';
  }
  const result = { ...clone(input.job), state:'calculated', publicationState:'prepared', currentStage:'publishing',
    calculatedAt: now, completedAt: null, updatedAt: now, calculationCursor: input.numericCandidates.length,
    ratioCursor: input.ratioCandidates.length, processedCount: total, totalCount: total,
    recoveryGeneration: input.generation, recoveryInputHash: state.pinnedInputHash, cacheOnlyRecovery: true,
    ...coverage, latestDataDate: coverage.cachedDataEndDate, analyzedCandidateCount: total,
    trendAvailableCount: total, trendCoveragePct: 100, pendingTrendCacheCount: 0, partialAnalysis: false,
    cacheHitCount: total, cacheMissCount: 0, freshFetchCount: 0, recoveryExternalApiCallCount: 0,
    searchAdCount: input.productCache.items.length, resultCount: rows.length, results: rows,
    errors: [], resumable: false, lastError: null, failedAt:null, interruptedAt:null,
    recoveryOrigin: {state:input.job.state,failedAt:input.job.failedAt || null,checkpointAt:input.checkpoint.updatedAt},
    message: '기간 계산 완료 · 결과 게시 중',
    diagnostic: { ...input.job.diagnostic, funnel: state.funnel, surgeHistory:{ stored:false, reason:'period-mode' } } };
  for (const [key,type] of Object.entries({productMatchResultCount:'product_match',brandCategorySignalCount:'brand_or_category_signal',
    domainRelatedSignalCount:'domain_related_signal',lowIntensityEarlySignalCount:'low_intensity_early_signal',ratioOnlyMarketSignalCount:'ratio_only_market_signal'}))
    result[key] = rows.filter(row => row.resultType === type).length;
  state.finalJob = result;
  state.snapshot = {version:1,jobId:result.jobId,mode:'period',startDate:result.startDate,endDate:result.endDate,
    queryStartDate:result.queryStartDate,generatedAt:now,latestDataDate:result.latestDataDate,
    trendCoveragePct:100,partialAnalysis:false,surgeThreshold:result.surgeThreshold,matchThreshold:result.matchThreshold,
    executionPath:'cache-only-recovery',...coverage,items:rows};
  state.stage = 'publishing';
}
function advance(input, saved, options = {}) {
  validate(input);
  const state = clone(saved);
  if (state.pinnedInputHash !== digest(input)) throw new Error('RECOVERY_INPUT_CHANGED');
  const now = options.now || Date.now;
  const started = now();
  const limit = Math.min(MAX_ITEMS, options.maxItems || MAX_ITEMS);
  let processed = 0;
  const trace = new Map(state.analysisTrace.map(t => [t.normalizedKeyword,t]));
  if (state.stage === 'numeric' || state.stage === 'ratio') {
    const context = {job:input.job,trendMap:new Map(Object.entries(input.trendEntries).map(([k,v])=>[k,seriesOf(v)])),
      shoppingMap:new Map(Object.entries(input.shoppingEntries || {}).map(([k,v])=>[k,seriesOf(v)])),
      analysisTrace:trace,funnel:state.funnel,calculated:state.calculated,productCache:input.productCache,
      productIndex:calculation.buildProductIndex(input.productCache.items),loadedEarlyCache:input.earlyCache,
      rows:state.rows,matchedDiagnostics:state.matchedDiagnostics,boundaryRelated:state.boundaryRelated,
      priorSignals:new Map(Object.entries(input.priorSignals || {}))};
    const numeric = state.stage === 'numeric';
    const candidates = numeric ? input.numericCandidates : input.ratioCandidates;
    const field = numeric ? 'calculationCursor' : 'ratioCursor';
    const calculate = options.calculate || (numeric ? calculation.calculateNumericCandidate : calculation.calculateRatioCandidate);
    while (state[field] < candidates.length && processed < limit && now() - started < SAFE_EXECUTION_MS) {
      calculate(candidates[state[field]],context); state[field] += 1; processed += 1;
    }
    state.analysisTrace = [...trace.values()];
    state.processedCount = state.calculationCursor + state.ratioCursor;
    if (state[field] === candidates.length) {
      state.stage = numeric ? 'ratio' : 'evidence';
      if (!numeric) state.evidenceTotalCount = state.rows.length;
    }
  } else if (state.stage === 'evidence') {
    while (state.evidenceCursor < state.rows.length && processed < limit && now()-started < SAFE_EXECUTION_MS) {
      const row = state.rows[state.evidenceCursor];
      row.periodMarketEvidence = buildPeriodMarketEvidence(row.keyword,input.job.startDate,input.job.endDate,input.earlyCache?.history || []);
      Object.assign(row,calculatePeriodMarketConfidence(row,row.periodMarketEvidence,input.job.surgeThreshold));
      row.marketConfidenceScore = row.periodMarketConfidenceScore;
      row.marketConfidenceGrade = row.periodMarketConfidenceGrade;
      row.marketConfidenceReasons = row.periodMarketConfidenceReasons;
      row.marketConfidenceComponents = row.periodMarketConfidenceComponents;
      state.evidenceCursor += 1; processed += 1;
    }
    if (state.evidenceCursor === state.rows.length) state.stage = 'finalize';
  } else if (state.stage === 'finalize') finalize(input,state,new Date(now()).toISOString());
  state.updatedAt = new Date(now()).toISOString();
  state.continuationCount += 1;
  return state;
}
module.exports = {validate,initialState,advance,dataCoverage,SAFE_EXECUTION_MS,MAX_ITEMS};
