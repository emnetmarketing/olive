const test = require("node:test");
const assert = require("node:assert/strict");
const { calculationRows, buildDiagnostic } = require("../netlify/functions/trend-diagnostic")._test;

test("diagnostic uses the production rolling peak calculation", () => {
  const ratios = Array.from({ length: 31 }, (_, index) => ({
    period: new Date(Date.UTC(2026, 3, 29 + index)).toISOString().slice(0, 10),
    ratio: index === 23 ? 100 : 10
  }));
  const candidate = { monthlyPcSearches: 760, monthlyMobileSearches: 7530, monthlyTotalSearches: 8290 };
  const result = buildDiagnostic("라카트윈립", candidate, { status: 200, data: ratios }, "2026-05-15", "2026-05-29", "2026-04-29");
  assert.equal(result.monthlyTotalSearches, 8290);
  assert.equal(result.rows.length, 15);
  assert.equal(result.windowDays, 7);
  assert.equal(result.peakDailyLift, result.peak.peakLift);
  assert.equal(result.estimatedSurgeCount, Math.max(0, result.endLift, result.peakLift));
});

test("per-date rows use the preceding seven-day median without future dilution", () => {
  const selected = Array.from({ length: 22 }, (_, index) => ({ period: `2026-05-${String(index + 8).padStart(2, "0")}`, ratio: index, estimated: index * 100 }));
  const rows = calculationRows(selected, "2026-05-15", "2026-05-29");
  const may22 = rows.find((row) => row.period === "2026-05-22");
  assert.equal(may22.baseline, 1000);
  assert.equal(may22.estimated, 1400);
  assert.equal(may22.lift, 400);
});
