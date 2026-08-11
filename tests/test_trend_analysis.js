const assert = require("node:assert/strict");
const { _test } = require("../netlify/functions/trend-analysis-background.js");

const ratios = Array.from({ length: 30 }, (_, index) => ({ period: `2026-08-${String(index + 1).padStart(2, "0")}`, ratio: index < 20 ? 1 : 10 }));
const estimated = _test.estimate(ratios, 120000);
assert.equal(Math.round(estimated.reduce((sum, point) => sum + point.estimated, 0)), 120000);
const period = _test.periodMetrics(estimated, "2026-08-01", "2026-08-30");
assert.ok(period.peakLift > 0);
assert.equal(period.surgeCount, Math.max(0, period.endLift, period.peakLift));
assert.equal(period.surgeCount >= 500, true);
assert.equal(period.surgeCount >= 100000, false);
const instant = _test.instantMetrics(estimated);
assert.equal(instant.surgeCount, Math.max(0, instant.latest - instant.baseline));

const products = [{ product: "메디힐 비타민씨 세럼", brand: "메디힐", account: "계정1" }];
const index = _test.buildIndex(products);
const match = _test.bestMatch("비타민씨 세럼", products, index);
assert.ok(match.score >= 60);
console.log("Trend estimation, surge calculation, and indexed matching OK");
