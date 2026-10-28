const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { growthView, formatBaseline } = require("../shared/result-growth-presentation");
const excel = require("../netlify/functions/unified-excel");
const { extractFunction } = require("../scripts/verify-deployed-period-display.cjs");
const html = fs.readFileSync("index.html", "utf8");

test("unverifiable legacy discovery confidence stays unavailable in Excel, not a fabricated zero", () => {
  const source = { keyword: "워터선크림", relatedBrand: "워터", relatedProductType: "선크림", sourceConfidence: 69,
    discoverySource: ["youtube"], evidence: [], discoveredAt: "2026-10-28T00:00:00Z" };
  const before = JSON.stringify(source), row = excel.discoveryRow(source);
  assert.equal(row.confidence, null); assert.equal(row.brand, "");
  assert.match(row.brandStatus, /워터 · 브랜드 미확인/);
  assert.match(row.confidenceStatus, /근거 부족/);
  assert.equal(JSON.stringify(source), before);
  assert.match(html, /item\.sourceConfidence == null \? '확인 불가'/);
});

// Read-only captured fields from 12bc84e1-9944-4f60-a7a4-566aa14d0b1b.
// Six preceding zero values and one 2017.0588235294117 give a true median 0.
const actual = () => ({ keyword: "나이아신아마이드20", estimatedBaseline: 0, peakBaseline: 0, estimatedLatest: 1121,
  estimatedSurgeCount: 1121, peakDailyLift: 1120.5882352941176, peakRelativeLiftPct: null, riseRate: null,
  absoluteSurgePassed: true, relativeSurgePassed: false, latestDataDate: "2026-10-23", resultType: "product_match",
  today: 1121, yesterday: 0, lift: 1121, marketConfidenceScore: 54,
  match: { score: 90, item: { product: "주미소 나이아신아마이드 20% 세럼 40ml", brand: "" }, matchingCandidateCount: 2, uniqueIdentification: false } });
function ui() {
  const nodes = new Map(); const $ = id => { if (!nodes.has(id)) nodes.set(id, { innerHTML: "" }); return nodes.get(id); };
  const context = vm.createContext({ $, ResultGrowthPresentation: { growthView, formatBaseline }, state: {},
    marketConfidenceSummary: () => "", instantRowDateSummary: () => "", storedPeriodConfidenceDisplay: () => ({ reasons: [] }),
    periodConfidenceSummary: () => "", periodRelationSummary: () => "", periodSourceEvidence: () => "", periodDataStatus: () => "" });
  for (const name of ["escapeHtml", "surgeSignalSummary", "renderTrendChart", "periodResultRow", "earlyBrandContextSummary", "periodConfidenceSummary", "storedInstantConfidenceDisplay", "marketConfidenceSummary", "periodRelationSummary", "renderRelatedSignals"])
    vm.runInContext(extractFunction(html, name), context);
  return { context, $ };
}

test("captured zero baseline reproduces old TOP10 100% bug and now remains unavailable", () => {
  const row = actual(), before = JSON.stringify(row);
  const oldRate = row.yesterday > 0 ? (row.today - row.yesterday) / row.yesterday * 100 : 100;
  assert.equal(oldRate, 100); assert.equal(row.peakRelativeLiftPct, null);
  const view = growthView(row); assert.equal(view.value, null); assert.equal(view.rateLabel, "비교 불가 · 기준값 0");
  const rt = ui(); rt.context.renderTrendChart([row]);
  assert.match(rt.$("trendChart").innerHTML, /비교 불가 · 기준값 0/);
  assert.doesNotMatch(rt.$("trendChart").innerHTML, /1,121 · 100%/);
  assert.match(rt.context.surgeSignalSummary(row), /비교 불가 · 기준값 0/);
  assert.match(rt.context.periodResultRow(row, 0), /비교 불가 · 기준값 0/);
  assert.equal(JSON.stringify(row), before);
});

test("positive original baseline rounded to zero retains stored rate and discloses original precision", () => {
  const row = { ...actual(), peakBaseline: 0.125, peakRelativeLiftPct: 890.1234, riseRate: 900.1 };
  const view = growthView(row); assert.equal(view.value, 890.1234); assert.equal(view.baselineLabel, "0.125");
  assert.equal(view.rateLabel, "+890.12%"); assert.equal(view.roundedToZero, true);
  const rt = ui(); rt.context.renderTrendChart([row]);
  assert.match(rt.$("trendChart").innerHTML, /원본 기준 0.125/);
  assert.match(rt.$("trendChart").innerHTML, /\+890\.12%/);
  assert.match(rt.context.periodResultRow(row, 0), /원본 기준 0.125/);
  assert.equal(excel.resultRow(row).relativeLift, row.peakRelativeLiftPct / 100);
  assert.equal(excel.resultRow(row).baseline, 0.125);
  assert.equal(excel.periodResultRow(row, {}).relativeLift, row.peakRelativeLiftPct / 100);
});

test("missing unrounded baseline is not confused with true zero or recomputed from rounded estimates", () => {
  const missing = { estimatedBaseline: 0, today: 1121, yesterday: 0, peakRelativeLiftPct: null };
  assert.equal(growthView(missing).value, null); assert.equal(growthView(missing).status, "unavailable");
  assert.match(growthView(missing).rateLabel, /원본 기준값/);
  assert.equal(growthView({ ...missing, peakRelativeLiftPct: 80.5 }).value, 80.5);
  assert.equal(growthView({ ...missing, peakBaseline: 0, peakRelativeLiftPct: 100 }).value, null);
  assert.notEqual(formatBaseline(0.00000001), "0");
  assert.equal(growthView({ ...missing, peakBaseline: 10, peakRelativeLiftPct: 0 }).rateLabel, "0%");
});

test("TOP10 keeps existing order and estimated quantities while correcting growth display only", () => {
  const rows = [actual(), { ...actual(), keyword: "두 번째", today: 500, estimatedSurgeCount: 500 }], before = JSON.stringify(rows);
  const rt = ui(); rt.context.renderTrendChart(rows);
  const markup = rt.$("trendChart").innerHTML;
  assert.ok(markup.indexOf("나이아신아마이드20") < markup.indexOf("두 번째"));
  assert.match(markup, /추정 \+1,121/); assert.equal(JSON.stringify(rows), before);
  assert.equal(excel.resultRow(rows[0]).estimatedSurgeCount, 1121);
});

test("Excel actual typed growth cells are blank for zero baseline and include explicit reason in every result sheet", async () => {
  const row = actual(); const workbook = await excel.buildWorkbook({ instantJob: { results: [row] },
    periodJob: { jobId: "period", results: [row], startDate: "2026-10-01", endDate: "2026-10-16" } });
  for (const name of ["02_어제 급등 확인", "03_상품 직접 매칭"]) {
    const sheet = workbook.getWorksheet(name);
    assert.equal(sheet.getCell("D2").value, null); assert.equal(sheet.getCell("E2").value, 0);
    assert.equal(sheet.getCell("U2").value, "비교 불가 · 기준값 0"); assert.equal(sheet.getCell("C2").value, 1121);
  }
  const period = workbook.getWorksheet("07_선택기간분석");
  assert.equal(period.getCell("E12").value, null); assert.equal(period.getCell("U12").value, "비교 불가 · 기준값 0");
  assert.equal(period.getCell("V12").value, 0);
});

test("browser helper executes standalone without Node and matches Excel's pure projection", () => {
  const context = vm.createContext({}); vm.runInContext(fs.readFileSync("shared/result-growth-presentation.js", "utf8"), context);
  assert.equal(JSON.stringify(context.ResultGrowthPresentation.growthView(actual())), JSON.stringify(growthView(actual())));
  assert.match(html, /script src="\/shared\/result-growth-presentation\.js"/);
});

test("unverified Early Signal brand is presented as a general expression, not a confirmed brand", () => {
  const rt = ui();
  assert.equal(rt.context.earlyBrandContextSummary({ brandContextStatus: "unverified", relatedExpression: "모공", relatedBrand: "" }), "모공 · 일반 표현 · 브랜드 미확인");
  assert.equal(rt.context.earlyBrandContextSummary({ brandContextStatus: "verified", relatedBrand: "확인 브랜드" }), "확인 브랜드");
});

test("reclassification never loses the saved ratio-only rate or silently creates a numeric baseline", () => {
  const row = { resultType: "unverified_context_signal", ratioBaseline: 0.25, relativeRatioLift: 32.5,
    qualityProjection: { sourceResultType: "ratio_only_market_signal" } };
  assert.equal(growthView(row).value, 32.5); assert.equal(growthView(row).baseline, 0.25);
  assert.equal(growthView({ ...row, ratioBaseline: 0 }).value, null);
});

test("unknown projected confidence is not zero and Period never borrows the old Instant score", () => {
  const rt = ui(); const qualityProjection = { version: 1, displayWarning: "저장된 세부 점수 없음 · 점수 보정 불가" };
  const instant = rt.context.marketConfidenceSummary({ marketConfidenceScore: null, qualityProjection });
  assert.match(instant, /점수 확인 불가/); assert.doesNotMatch(instant, /0\/100|이전 결과에는 미계산/);
  const period = rt.context.periodConfidenceSummary({ periodMarketConfidenceScore: null, marketConfidenceScore: 66, qualityProjection });
  assert.match(period, /점수 확인 불가/); assert.doesNotMatch(period, /66|0\/100/);
  assert.match(html, /item\.todayEarlySignalScore == null \? "점수 확인 불가"/);
  assert.equal(excel.earlyRow({ keyword: "unknown", todayEarlySignalScore: null }).score, null);
});

test("unverified primary and additional comparison candidates are not represented as verified products", () => {
  const row = { keyword: "일반어", resultType: "unverified_context_signal", match: { score: 10,
    item: { product: "기존 상품", brand: "기존 브랜드" }, additionalMatches: [{ item: { product: "추가 후보" } }] },
    relatedSignal: { referenceProducts: [], relatedProductCount: null, verifiedReferenceCount: 0, countScope: "stored_references_only" },
    qualityProjection: { version: 1, displayWarning: "브랜드 미확인 참고 신호" } };
  const before = JSON.stringify(row), rt = ui();
  rt.context.renderRelatedSignals("unverified", [row], "empty");
  const markup = rt.$("unverified").innerHTML;
  assert.match(markup, /기존 비교 후보\(미검증\)/); assert.match(markup, /기존 상품/); assert.match(markup, /추가 후보/);
  assert.match(markup, /저장 참고 상품 0건 · 전체 수 미재집계/);
  assert.match(rt.context.periodRelationSummary(row), /기존 비교 후보\(미검증\): 기존 상품/);
  assert.equal(excel.resultRow(row).product, "기존 비교 후보(미검증): 기존 상품");
  assert.match(excel.resultRow(row).brand, /기존 비교 후보 브랜드\(미검증\)/);
  assert.match(excel.periodResultRow(row, {}).productBrand, /^기존 비교 후보\(미검증\):/);
  assert.equal(JSON.stringify(row), before);
});
