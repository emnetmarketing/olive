(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ResultGrowthPresentation = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const amountFormat = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 6 });
  const rateFormat = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });
  const number = value => value == null || value === "" || typeof value === "boolean" || !Number.isFinite(Number(value)) ? null : Number(value);
  const formatBaseline = value => value == null ? "확인 불가" : value !== 0 && Math.abs(value) < 0.000001
    ? value.toExponential(4) : amountFormat.format(value);

  // Display only: use the saved unrounded baseline and rate. Never derive a rate
  // from rounded estimatedBaseline/today/yesterday or change pass/fail or order.
  function growthView(row = {}) {
    const ratioOnly = row.resultType === "ratio_only_market_signal" || row.qualityProjection?.sourceResultType === "ratio_only_market_signal";
    const baseline = number(ratioOnly ? row.ratioBaseline : row.peakBaseline);
    const rate = number(ratioOnly ? row.relativeRatioLift : row.peakRelativeLiftPct);
    const roundedBaseline = number(row.estimatedBaseline);
    const roundedToZero = baseline > 0 && roundedBaseline === 0;
    const status = baseline === 0 ? "zero-baseline" : rate == null ? "unavailable" : roundedToZero ? "rounded-baseline" : "available";
    const value = baseline === 0 ? null : rate;
    const statusLabel = status === "zero-baseline" ? "비교 불가 · 기준값 0"
      : status === "unavailable" ? "비교 불가 · 원본 기준값/상승률 확인 불가"
        : status === "rounded-baseline" ? "원본 기준값 사용 · 정수 표시 시 0으로 반올림"
          : baseline == null ? "저장된 상승률 · 원본 기준값 미저장" : "원본 기준값 사용";
    return { value, baseline, baselineLabel: formatBaseline(baseline), status, statusLabel, roundedToZero,
      rateLabel: value == null ? statusLabel : `${value > 0 ? "+" : ""}${rateFormat.format(value)}%` };
  }
  return { growthView, formatBaseline };
});
