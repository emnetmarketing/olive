"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { observedPeriodCoverage } = require("../netlify/functions/period-observation-coverage");
test("Period reports selected source observations separately from baseline, empty, missing and unobserved end day", () => {
  const values = new Map([["in-range", [{ period: "2026-10-03" }, { period: "2026-11-01", ratio: 0 }]],
    ["baseline-only", [{ period: "2026-10-31" }]], ["valid-empty", []]]);
  assert.deepEqual(observedPeriodCoverage(values, "2026-11-01", "2026-11-02", 5), {
    actualDataStartDate: "2026-11-01", actualDataEndDate: "2026-11-01", validSeriesCandidateCount: 2,
    analyzablePeriodCandidateCount: 1, emptySeriesCandidateCount: 1, baselineOnlyCandidateCount: 1,
    missingPeriodCacheCount: 2, endDateObservedCandidateCount: 0 });
  assert.equal(observedPeriodCoverage(values, "2026-11-02", "2026-11-02", 5).actualDataEndDate, null);
});
