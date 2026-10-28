// Publication/display selection only. Never changes candidate order, scores or surge calculations.
const MIN_INSTANT_COVERAGE_PCT = 10;
// At most 25 of 5,000 candidates may differ when preferring a genuinely newer
// source observation on the SAME data day. Selection only: no score changes.
const EQUIVALENT_COVERAGE_POINTS = 0.5;
const qualityBand = value => Math.max(0, Math.ceil(value / EQUIVALENT_COVERAGE_POINTS) - 1);
const date = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : null;
const number = value => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
function freshness(value) {
  const source = value?.sourceFreshness || {};
  const actualDataDate = date(value?.latestDataDate) || date(source.actualDataDate);
  const targetDataDate = date(source.targetDataDate) || date(value?.targetDataDate);
  const actualDataCoveragePct = number(source.actualDataCoveragePct)
    ?? (actualDataDate && actualDataDate === targetDataDate ? number(source.targetDataCoveragePct) : null);
  return { actualDataDate, targetDataDate, actualDataCoveragePct,
    targetDataCoveragePct: number(source.targetDataCoveragePct),
    validSeriesCount: number(source.validSeriesCount), coverage: number(value?.trendCoveragePct) ?? 0,
    sourceObservedAt: source.sourceObservedAt || source.lastSuccessfulCollectionAt || value?.trendCollectedAt || null };
}
function isMeaningfulInstant(value) {
  const info = freshness(value);
  return Boolean(value && value.mode !== "period" && info.actualDataDate && info.coverage >= MIN_INSTANT_COVERAGE_PCT
    && (info.validSeriesCount == null || info.validSeriesCount > 0));
}
function equivalentNewerObservation(candidate, previous) {
  const a = freshness(candidate), b = freshness(previous);
  const newer = Date.parse(a.sourceObservedAt || ""), older = Date.parse(b.sourceObservedAt || "");
  // Request/calculation time or fingerprints alone cannot certify freshness.
  // Legacy unknown observed-date rates retain the conservative comparison.
  return a.actualDataDate === b.actualDataDate && a.actualDataDate && Number.isFinite(newer) && Number.isFinite(older) && newer > older
    && Number(candidate?.freshFetchCount || 0) > 0
    && candidate?.orderedCandidateHash && previous?.orderedCandidateHash && candidate?.productVersionHash && previous?.productVersionHash
    && Number(candidate.analyzedCandidateCount) > 0 && Number(candidate.analyzedCandidateCount) === Number(previous.analyzedCandidateCount)
    && a.actualDataCoveragePct != null && b.actualDataCoveragePct != null
    && a.actualDataCoveragePct >= b.actualDataCoveragePct - EQUIVALENT_COVERAGE_POINTS
    && a.coverage >= b.coverage - EQUIVALENT_COVERAGE_POINTS
    && a.validSeriesCount != null && b.validSeriesCount != null && a.validSeriesCount >= b.validSeriesCount * 0.995
    // Fixed quality bands prevent successive near-ties from ratcheting
    // coverage down on every newer observation of the same data day.
    && qualityBand(a.coverage) === qualityBand(b.coverage)
    && qualityBand(a.actualDataCoveragePct) === qualityBand(b.actualDataCoveragePct)
    && qualityBand(a.validSeriesCount / candidate.analyzedCandidateCount * 100)
      === qualityBand(b.validSeriesCount / previous.analyzedCandidateCount * 100);
}
function compareInstantFreshness(left, right) {
  const a = freshness(left), b = freshness(right);
  const validity = Number(isMeaningfulInstant(left)) - Number(isMeaningfulInstant(right));
  if (validity) return validity;
  const observationDate = String(a.actualDataDate || "").localeCompare(String(b.actualDataDate || ""));
  if (observationDate) return observationDate;
  if (equivalentNewerObservation(left, right)) return 1;
  if (equivalentNewerObservation(right, left)) return -1;
  // A newer requested target is not a newer observation. Compare rates only
  // when they describe the same observed/target date and both are known.
  if (a.actualDataCoveragePct != null && b.actualDataCoveragePct != null && a.actualDataCoveragePct !== b.actualDataCoveragePct)
    return a.actualDataCoveragePct - b.actualDataCoveragePct;
  if (a.targetDataDate && a.targetDataDate === b.targetDataDate && a.targetDataCoveragePct != null && b.targetDataCoveragePct != null
    && a.targetDataCoveragePct !== b.targetDataCoveragePct) return a.targetDataCoveragePct - b.targetDataCoveragePct;
  if (a.coverage !== b.coverage) return a.coverage - b.coverage;
  if (a.validSeriesCount != null && b.validSeriesCount != null && a.validSeriesCount !== b.validSeriesCount)
    return a.validSeriesCount - b.validSeriesCount;
  const created = (Date.parse(left?.createdAt || "") || 0) - (Date.parse(right?.createdAt || "") || 0);
  if (created) return created;
  return (Date.parse(left?.completedAt || left?.generatedAt || "") || 0) - (Date.parse(right?.completedAt || right?.generatedAt || "") || 0);
}
function selectionReason(candidate, selected) {
  if (!selected?.jobId) return { code: "no-valid-result", text: "표시 가능한 유효 결과 없음" };
  if (!candidate?.jobId || candidate.jobId === selected.jobId)
    return { code: "selected-result", text: "현재 유효 게시 결과 사용", selectedJobId: selected.jobId };
  const a = freshness(candidate), b = freshness(selected);
  const base = { candidateJobId: candidate.jobId, selectedJobId: selected.jobId,
    candidateChanged: Boolean(candidate.orderedCandidateHash && selected.orderedCandidateHash && candidate.orderedCandidateHash !== selected.orderedCandidateHash),
    sourceObservedAt: a.sourceObservedAt, previousSourceObservedAt: b.sourceObservedAt };
  if (!isMeaningfulInstant(candidate)) return { ...base, code: "invalid-candidate", text: "새 결과의 유효성·최소 분석 범위 부족으로 기존 결과 유지" };
  if (a.actualDataDate < b.actualDataDate) return { ...base, code: "older-data", text: "새 작업의 실제 데이터 기준일이 더 오래되어 기존 결과 유지" };
  if (a.coverage < b.coverage * 0.5) return { ...base, code: "coverage-drop", text: "새 결과의 분석 범위 급락 보호로 기존 결과 유지" };
  if (equivalentNewerObservation(candidate, selected)) return { ...base, code: "newer-equivalent-observation", text: "같은 데이터 날짜의 동등한 분석 범위에서 더 최근 원천 관측 우선" };
  if (a.actualDataDate === b.actualDataDate && compareInstantFreshness(candidate, selected) < 0)
    return { ...base, code: "same-date-coverage", text: "실제 데이터 날짜가 같고 새 결과의 관측·캐시 범위 우위가 확인되지 않아 기존 결과 유지" };
  return { ...base, code: "selected-pointer-preserved", text: "현재 검증된 게시 포인터 유지 (조회만으로 결과를 교체하지 않음)" };
}
function selectCompletedInstant(values) {
  return values.filter(value => value?.mode === "instant" && value.state === "completed" && isMeaningfulInstant(value))
    .sort((a, b) => compareInstantFreshness(b, a))[0] || null;
}
function canPromoteInstant(candidate, previous) {
  if (candidate?.mode !== "instant" || !isMeaningfulInstant(candidate)) return false;
  if (!isMeaningfulInstant(previous)) return true;
  if (freshness(candidate).coverage < freshness(previous).coverage * 0.5) return false;
  return compareInstantFreshness(candidate, previous) >= 0;
}
module.exports = { MIN_INSTANT_COVERAGE_PCT, EQUIVALENT_COVERAGE_POINTS, freshness, isMeaningfulInstant, compareInstantFreshness,
  equivalentNewerObservation, selectionReason, selectCompletedInstant, canPromoteInstant };
