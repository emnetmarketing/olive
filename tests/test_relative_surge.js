const assert = require("node:assert/strict");
const { _test } = require("../netlify/functions/trend-analysis-background");

function metrics(lift, baseline, surgeCount = lift) {
  return {
    surgeCount,
    peakDailyLift: lift,
    peakDailyBaseline: baseline,
    peakDailyEstimated: baseline + lift,
    peakDailyDate: "2026-01-01",
  };
}

const threshold = 300;

let signal = _test.surgePassSignals(metrics(400, 1000), threshold);
assert.equal(signal.absoluteSurgePassed, true);
assert.equal(signal.relativeTrendPassed, false);

signal = _test.surgePassSignals(metrics(120, 100), threshold);
assert.equal(signal.absoluteSurgePassed, false);
assert.equal(signal.relativeTrendPassed, true);

signal = _test.surgePassSignals(metrics(400, 100), threshold);
assert.equal(signal.absoluteSurgePassed, true);
assert.equal(signal.relativeTrendPassed, true);

signal = _test.surgePassSignals(metrics(99, 100), threshold);
assert.equal(signal.absoluteSurgePassed, false);
assert.equal(signal.relativeTrendPassed, false);

signal = _test.surgePassSignals(metrics(500, 0), threshold);
assert.equal(signal.absoluteSurgePassed, true);
assert.equal(signal.relativeTrendPassed, false);
assert.equal(signal.peakRelativeLiftPct, null);

assert.equal(_test.surgePassSignals(metrics(100, 200), threshold).relativeTrendPassed, true);
assert.equal(_test.surgePassSignals(metrics(99.99, 199.98), threshold).relativeTrendPassed, false);
assert.equal(_test.surgePassSignals(metrics(100, 200.01), threshold).relativeTrendPassed, false);

const noDomainEvidence = _test.classifySurgeResult(
  { keyword: "키보드", category: "unknown", relevanceEvidence: [], sources: [] },
  null,
  [],
  40,
);
assert.equal(noDomainEvidence.resultType, null);

const representatives = {
  laka: _test.surgePassSignals(metrics(1413.409, 488.449), threshold),
  zeroid: _test.surgePassSignals(metrics(694.620, 223.022), threshold),
  snpe: _test.surgePassSignals(metrics(398.994, 1288.653), threshold),
  illiyoon: _test.surgePassSignals(metrics(118.799, 28.169), threshold),
  ohui: _test.surgePassSignals(metrics(107.707, 162.074), threshold),
  numbuzin: _test.surgePassSignals(metrics(42.159, 179.946), threshold),
};
assert.deepEqual(
  Object.fromEntries(Object.entries(representatives).map(([name, value]) => [name, [value.absoluteSurgePassed, value.relativeTrendPassed]])),
  {
    laka: [true, true],
    zeroid: [true, true],
    snpe: [true, false],
    illiyoon: [false, true],
    ohui: [false, true],
    numbuzin: [false, false],
  },
);

console.log("Absolute and relative surge gates OK");
