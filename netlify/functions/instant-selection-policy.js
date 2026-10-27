// Publication/display selection only. Never changes candidate order, scores or surge calculations.
const MIN_INSTANT_COVERAGE_PCT = 10;
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
    validSeriesCount: number(source.validSeriesCount), coverage: number(value?.trendCoveragePct) ?? 0 };
}
function isMeaningfulInstant(value) {
  const info = freshness(value);
  return Boolean(value && value.mode !== "period" && info.actualDataDate && info.coverage >= MIN_INSTANT_COVERAGE_PCT
    && (info.validSeriesCount == null || info.validSeriesCount > 0));
}
function compareInstantFreshness(left, right) {
  const a = freshness(left), b = freshness(right);
  const validity = Number(isMeaningfulInstant(left)) - Number(isMeaningfulInstant(right));
  if (validity) return validity;
  const observationDate = String(a.actualDataDate || "").localeCompare(String(b.actualDataDate || ""));
  if (observationDate) return observationDate;
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
module.exports = { MIN_INSTANT_COVERAGE_PCT, freshness, isMeaningfulInstant, compareInstantFreshness, selectCompletedInstant, canPromoteInstant };
