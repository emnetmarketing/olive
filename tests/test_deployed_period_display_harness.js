const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { verifyDisplay } = require("../scripts/verify-deployed-period-display.cjs");
const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");

function fixture(count = 439) {
  const results = Array.from({ length: count }, (_, index) => ({
    keyword: `가상 & <기간> ${count - index}`, estimatedSurgeCount: index === 2 ? null : 7031 - index,
    peakRelativeLiftPct: index === 2 ? null : 420 - index / 10,
    periodMarketConfidenceScore: 66, periodMarketConfidenceGrade: "medium",
    periodMarketConfidenceReasons: ["저장된 기간 상승 확인", "상품 직접 매칭"],
    match: { score: 87, item: { product: "fixture", brand: "brand" } },
    periodMarketEvidence: { dataAvailability: "no_data", youtube: { availability: "no_data" }, searchAd: { availability: "partial", delta: null } }
  }));
  return { jobId: "offline-period-only", mode: "period", state: "completed", startDate: "2026-10-01", endDate: "2026-10-16",
    queryStartDate: "2026-09-16", createdAt: "2026-10-16T05:22:00Z", completedAt: "2026-10-16T06:00:00Z",
    latestDataDate: "2026-10-14", actualDataStartDate: "2026-09-16", actualDataEndDate: "2026-10-14",
    cacheOnlyRecovery: true, trendAvailableCount: 5000, analyzedCandidateCount: 5000, trendCoveragePct: 100,
    validSeriesCandidateCount: 4904, emptySeriesCandidateCount: 96, resultCount: count, results };
}

test("deployed HTML display harness uses actual render functions and saved rows without network", async () => {
  const period = fixture(); const report = await verifyDisplay({ html, period, status: period,
    snapshot: { ...period, items: period.results }, provenance: "explicit synthetic fixture" });
  assert.equal(report.resultCount, 439); assert.equal(report.top10OrderMatches, true);
  assert.equal(report.allRowsOrderMatches, true); assert.equal(report.numericAndEvidenceValuesMatch, true);
  assert.equal(report.searchFilterMatches, true); assert.equal(report.changedSelectionHidesOldRows, true);
  assert.equal(report.excelRequestBinding.periodJobId, period.jobId);
  assert.equal(report.excelRequestBinding.actualDownloadPerformed, false);
  assert.equal(report.suppliedWorkbook.verified, false); assert.equal(report.actualNetworkRequests, 0);
  assert.match(report.verificationKind, /NOT a logged-in browser visual test/);
});

test("display harness refuses mismatched snapshot or incomplete Job instead of manufacturing completion", async () => {
  const period = fixture(12);
  await assert.rejects(verifyDisplay({ html, period: { ...period, state: "calculated" } }));
  await assert.rejects(verifyDisplay({ html, period, snapshot: { ...period, jobId: "other", items: period.results } }));
  await assert.rejects(verifyDisplay({ html, period, status: { ...period, results: period.results.slice(1) } }));
});

test("saved Instant response remains unchanged and result generation chooses the actual latest Period", async () => {
  const period = fixture(12); period.publicationGeneration = 20;
  const partial = { ...fixture(5), jobId: "older-partial", publicationGeneration: 10, completedAt: "2026-10-17T00:00:00Z" };
  const instant = { jobId: "saved-instant", mode: "instant", state: "completed", results: [{ keyword: "instant" }] };
  const before = JSON.stringify(instant);
  const report = await verifyDisplay({ html, period, partial, instant });
  assert.equal(report.jobId, period.jobId); assert.equal(report.instantUnchanged, true);
  assert.equal(report.instantInputKind, "saved supplied Instant response"); assert.equal(JSON.stringify(instant), before);
});

test("optional saved workbook comparison checks existing summary, period metadata and row values without inventing embedded Job ID", async () => {
  const period = fixture(12);
  const { toBuffer } = require("../netlify/functions/unified-excel.js");
  const excel = await toBuffer({ generatedAt: "2026-10-16T10:00:00Z", instantJob: { results: [] }, periodJob: period, periodRequest: period });
  const report = await verifyDisplay({ html, period, excel });
  assert.equal(report.suppliedWorkbook.verified, true); assert.equal(report.suppliedWorkbook.jobIdEmbedded, false);
  assert.equal(report.suppliedWorkbook.valuesAndOrderMatch, true); assert.equal(report.suppliedWorkbook.resultCount, 12);
});
