const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { _test: dateTest } = require("../netlify/functions/trend-analysis-start");
const { _test: downloadTest } = require("../netlify/functions/download-history");

test("period validation is inclusive from one through thirty-one days", () => {
  assert.equal(dateTest.inclusiveDays("2026-05-22", "2026-05-22"), 1);
  assert.equal(dateTest.inclusiveDays("2026-05-22", "2026-05-23"), 2);
  assert.equal(dateTest.inclusiveDays("2026-05-01", "2026-05-31"), 31);
  assert.equal(dateTest.inclusiveDays("2026-05-01", "2026-06-01"), 32);
  assert.equal(dateTest.isoDate(dateTest.analysisQueryStart("period", new Date("2026-05-01T00:00:00Z"), new Date("2026-05-31T00:00:00Z"))), "2026-04-24");
});

test("download filenames identify the analyzed period", () => {
  assert.equal(downloadTest.filenameFor({ mode: "period", startDate: "2026-05-01", endDate: "2026-05-31" }), "monitoring-result-20260501-20260531.xls");
  assert.equal(downloadTest.filenameFor({ mode: "instant", latestDataDate: "2026-08-10" }), "monitoring-result-instant-20260810.xls");
});

test("shared current job and download history endpoints are wired into the dashboard", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /trend-analysis-current/);
  assert.match(html, /\.netlify\/functions\/download-history/);
  assert.match(html, /sourceJobId/);
  assert.match(html, /id="brandSignalBody"/);
  assert.match(html, /brand_or_category_signal/);
  assert.match(html, /CURRENT_JOB_WATCH_INTERVAL_MS = 8000/);
  assert.match(html, /startCurrentJobWatcher\(\)/);
  const analysisCache = fs.readFileSync("netlify/functions/trend-analysis-cache.js", "utf8");
  assert.match(analysisCache, /current-job\/v1/);
  assert.match(analysisCache, /onlyIfMatch/);
  assert.match(analysisCache, /onlyIfNew/);
  assert.doesNotMatch(analysisCache, /consistency: "strong"/);
  const currentEndpoint = fs.readFileSync("netlify/functions/trend-analysis-current.js", "utf8");
  assert.match(currentEndpoint, /readCurrentJob\(\)/);
  assert.doesNotMatch(currentEndpoint, /markStale:\s*true/);
  assert.match(analysisCache, /acquireJob[\s\S]*readCurrentJob\(\{ markStale: true \}\)/);
  assert.match(fs.readFileSync("netlify/functions/download-history-cache.js", "utf8"), /shared-history\/v1/);
});
