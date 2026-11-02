"use strict";

// Report only observed source dates. Neither the baseline lookback nor
// zero-filled calculation points are observations inside the requested period.
function observedPeriodCoverage(seriesByKeyword, startDate, endDate, totalCount) {
  let first = null, last = null, empty = 0, baselineOnly = 0, usable = 0, endObserved = 0;
  for (const series of seriesByKeyword.values()) {
    if (!Array.isArray(series) || !series.length) { empty++; continue; }
    let inPeriod = false, atEnd = false;
    for (const { period } of series) {
      if (!period || period < startDate || period > endDate) continue;
      inPeriod = true;
      if (period === endDate) atEnd = true;
      if (!first || period < first) first = period;
      if (!last || period > last) last = period;
    }
    if (atEnd) endObserved++;
    if (inPeriod) usable++; else baselineOnly++;
  }
  return { actualDataStartDate: first, actualDataEndDate: last, validSeriesCandidateCount: seriesByKeyword.size - empty,
    analyzablePeriodCandidateCount: usable, emptySeriesCandidateCount: empty, baselineOnlyCandidateCount: baselineOnly,
    missingPeriodCacheCount: totalCount - seriesByKeyword.size, endDateObservedCandidateCount: endObserved };
}
module.exports = { observedPeriodCoverage };
