// /stats does not declare a reporting date range. Stored observations are not
// daily search-volume measurements, and a missing prior observation is not 0.
function numeric(value) {
  return value !== null && value !== undefined && value !== "" && typeof value !== "boolean" && Number.isFinite(Number(value)) ? Number(value) : null;
}
function first(object, names) {
  for (const name of names) if (Object.prototype.hasOwnProperty.call(object || {}, name)) return object[name];
  return null;
}
function timestamp(value) { return value && Number.isFinite(Date.parse(value)) ? value : null; }
function previousCandidateObservation(previous, observedAt) {
  const previousAt = timestamp(previous?.searchAdObservedAt || previous?.lastSeenAt);
  const observed = timestamp(observedAt);
  const actualQuery = previous?.sources?.includes("searchad-query") === true;
  const valid = actualQuery && previousAt && observed && Date.parse(previousAt) < Date.parse(observed);
  const impressions = valid ? numeric(previous.impressions30d) : null;
  const clicks = valid ? numeric(previous.clicks30d) : null;
  return { previousImpressions30d: impressions, previousClicks30d: clicks,
    previousSearchAdObservedAt: valid ? previousAt : null,
    previousSearchAdObservationAvailable: Boolean(valid && (impressions !== null || clicks !== null)) };
}
function normalizeSearchAdObservation(input = {}, context = {}) {
  const observedAt = timestamp(input.observedAt || input.searchAdObservedAt || input.lastSeenAt || context.observedAt);
  const previousObservedAt = timestamp(input.previousObservedAt || input.previousSearchAdObservedAt || context.previousObservedAt);
  const current = numeric(first(input, ["current", "recentImpressions", "impressions30d"]));
  const currentClicks = numeric(first(input, ["currentClicks", "recentClicks", "clicks30d"]));
  const firstSeenAt = timestamp(input.firstSeenAt || context.firstSeenAt);
  const isNewlyObserved = input.isNewlyObserved === true || input.isNewSearchQuery === true || context.isNewlyObserved === true
    || Boolean(!previousObservedAt && firstSeenAt && observedAt && firstSeenAt === observedAt);
  const declared = input.previousObservationAvailable ?? input.previousSearchAdObservationAvailable;
  const comparable = declared !== false && !isNewlyObserved && observedAt && previousObservedAt
    && Date.parse(previousObservedAt) < Date.parse(observedAt);
  const previous = comparable ? numeric(first(input, ["previous", "previousImpressions", "previousImpressions30d"])) : null;
  const previousClicks = comparable ? numeric(first(input, ["previousClicks", "previousClicks30d"])) : null;
  const delta = current !== null && previous !== null ? current - previous : null;
  const clickDelta = currentClicks !== null && previousClicks !== null ? currentClicks - previousClicks : null;
  return { method: input.method || "latest_refresh_vs_previous_refresh", observedAt,
    previousObservedAt: comparable ? previousObservedAt : null, firstSeenAt, isNewlyObserved,
    observationWindow: input.observationWindow || "unspecified_api_default",
    observationSource: input.observationSource || "stored-search-ad-observation",
    comparisonStatus: delta !== null || clickDelta !== null ? "comparable" : "unavailable",
    comparisonReason: delta !== null || clickDelta !== null ? null : "previous_observation_unavailable",
    previousObservationAvailable: Boolean(comparable && (previous !== null || previousClicks !== null)),
    current, previous, delta, deltaRate: delta !== null && previous > 0 ? Math.round(delta / previous * 10000) / 100 : null,
    currentClicks, previousClicks, clickDelta };
}
function sanitizeSearchAdEvidence(input) {
  if (!input) return null;
  const value = normalizeSearchAdObservation(input);
  return { ...input, ...value, recentImpressions: value.current, recentClicks: value.currentClicks,
    previousImpressions: value.previous, previousClicks: value.previousClicks };
}
function projectStoredResultConfidence(row = {}) {
  const observation = normalizeSearchAdObservation(row.searchAdObservation || row.earlyMarketEvidence?.comparisons?.searchAd || {});
  let unverifiedIncrease = false;
  const reasons = (row.marketConfidenceReasons || []).map(reason => {
    if (reason === "Search Ad 신규 유입") return "Search Ad 신규 발견 · 저장 광고 관측 참고 · 집계기간 미확인";
    if (reason === "Search Ad 클릭 유입 확인") return "Search Ad 저장 클릭 관측 참고 · 집계기간 미확인";
    const verifiedIncrease = observation.comparisonStatus === "comparable"
      && (/노출/.test(reason) ? observation.delta > 0 : /클릭/.test(reason) ? observation.clickDelta > 0 : observation.delta > 0 || observation.clickDelta > 0);
    if (!verifiedIncrease && /Search\s*Ad.*(?:증가|(?:노출|클릭)\s*\+\s*[\d.,]+)/i.test(String(reason))) {
      unverifiedIncrease = true;
      return "Search Ad 저장 광고 관측 · 이전 비교 근거 확인 불가 · 집계기간 미확인";
    }
    return reason;
  });
  return { reasons, observation, unverifiedIncrease,
    scoreWarning: unverifiedIncrease ? "기존 저장 점수 · Search Ad 증가 비교 미검증(점수 재계산 안 됨)" : null };
}
function projectStoredPeriodResult(row = {}) {
  const source = row.periodMarketEvidence?.searchAd;
  const display = projectStoredResultConfidence({ marketConfidenceReasons: row.periodMarketConfidenceReasons || row.marketConfidenceReasons || [],
    searchAdObservation: source || {} });
  // Legacy observedDates describe signal publication dates, not source reads.
  const unverifiedComparison = source && display.observation.comparisonStatus !== "comparable"
    && [source.previous, source.previousClicks, source.delta, source.clickDelta].some(value => value != null);
  return { ...display, searchAd: source ? { ...source, ...display.observation } : null,
    scoreWarning: display.scoreWarning || (unverifiedComparison ? "기존 저장 점수 · Search Ad 기간 비교 미검증(점수 재계산 안 됨)" : null) };
}
module.exports = { numeric, previousCandidateObservation, normalizeSearchAdObservation, sanitizeSearchAdEvidence, projectStoredResultConfidence, projectStoredPeriodResult };
