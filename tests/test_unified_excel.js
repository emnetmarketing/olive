const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ExcelJS = require("exceljs");
const { toBuffer } = require("../netlify/functions/unified-excel");
const { _test: download } = require("../netlify/functions/download-history");

const fixture = {
  generatedAt: "2026-09-03T01:00:00Z",
  instantJob: { jobId: "instant-1", mode: "instant", latestDataDate: "2026-09-02", trendCoveragePct: 66.6,
    trendAvailableCount: 3330, analyzedCandidateCount: 5000, surgeThreshold: 300, matchThreshold: 40, results: [
      { keyword: "상품키워드", resultType: "product_match", estimatedSurgeCount: 420, estimatedBaseline: 100, peakDailyLift: 420,
        peakRelativeLiftPct: 120, peakDate: "2026-09-02", latestDataDate: "2026-09-02", marketConfidenceScore: 82,
        marketConfidenceGrade: "strong", marketConfidenceReasons: ["NAVER 절대 급등 확인"], match: { score: 87, item: { product: "대표 상품", brand: "브랜드" } }, discoverySource: ["youtube", "product-cache"] },
      { keyword: "브랜드키워드", resultType: "brand_or_category_signal", estimatedSurgeCount: 350, relatedSignal: { relatedBrand: "브랜드" } },
      { keyword: "기타키워드", resultType: "domain_related_signal", estimatedSurgeCount: 310, relatedSignal: { relatedProductType: "세럼" } }
    ] },
  periodJob: { jobId: "period-1", mode: "period", results: [{ keyword: "기간키워드", resultType: "product_match", estimatedSurgeCount: 301 }] },
  early: { signalDate: "2026-09-03", generatedAt: "2026-09-03T00:30:00Z", items: [{ keyword: "오늘키워드", strength: "rising", todayEarlySignalScore: 55,
    detectedAt: "2026-09-03T00:20:00Z", earlySignalDate: "2026-09-03", reasons: ["YouTube 증가"], sources: ["youtube"], comparisons: { youtube: { current: 3, previous: 1, delta: 2 } } }] },
  discoveries: [{ rank: 1, keyword: "발견키워드", discoverySource: ["youtube"], discoveredAt: "2026-09-03T00:00:00Z", sourceConfidence: 80 }]
};

async function workbook() { const book = new ExcelJS.Workbook(); await book.xlsx.load(await toBuffer(fixture)); return book; }

test("unified download creates every required sheet including optional period", async () => {
  const book = await workbook();
  assert.deepEqual(book.worksheets.map((sheet) => sheet.name), ["00_요약", "01_오늘 급상승 신호", "02_어제 급등 확인", "03_상품 직접 매칭", "04_브랜드_카테고리", "05_기타 관련 급등", "06_최근 발견 키워드", "07_선택기간분석"]);
});

test("period sheet is omitted when no period result exists", async () => {
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await toBuffer({ ...fixture, periodJob: null }));
  assert.equal(book.getWorksheet("07_선택기간분석"), undefined);
});

test("today instant and period rows remain in separate sheets", async () => {
  const book = await workbook();
  assert.equal(book.getWorksheet("01_오늘 급상승 신호").getCell("A2").value, "오늘키워드");
  assert.equal(book.getWorksheet("02_어제 급등 확인").getCell("A2").value, "상품키워드");
  assert.equal(book.getWorksheet("07_선택기간분석").getCell("A2").value, "기간키워드");
});

test("result type sheets use production enums", async () => {
  const book = await workbook();
  assert.equal(book.getWorksheet("03_상품 직접 매칭").getCell("A2").value, "상품키워드");
  assert.equal(book.getWorksheet("04_브랜드_카테고리").getCell("A2").value, "브랜드키워드");
  assert.equal(book.getWorksheet("05_기타 관련 급등").getCell("A2").value, "기타키워드");
});

test("all sheets freeze the header and enable AutoFilter", async () => {
  const book = await workbook();
  for (const sheet of book.worksheets) { assert.equal(sheet.views[0].ySplit, 1); assert.ok(sheet.autoFilter); }
});

test("numeric percentages and dates are typed Excel values", async () => {
  const book = await workbook(); const sheet = book.getWorksheet("02_어제 급등 확인");
  assert.equal(typeof sheet.getCell("C2").value, "number"); assert.equal(sheet.getCell("D2").value, 1.2);
  assert.ok(sheet.getCell("B2").value instanceof Date); assert.equal(sheet.getCell("D2").numFmt, "0.00%");
});

test("integrated workbook keeps confidence and evidence", async () => {
  const book = await workbook(); const sheet = book.getWorksheet("02_어제 급등 확인");
  assert.equal(sheet.getCell("I2").value, 82); assert.equal(sheet.getCell("J2").value, "강함");
  assert.match(String(sheet.getCell("K2").value), /NAVER/);
});

test("download history endpoint reuses the existing route and stores workbook availability", () => {
  const source = fs.readFileSync("netlify/functions/download-history.js", "utf8");
  assert.match(source, /downloadType === "unified_results"/); assert.match(source, /appendHistory/);
  assert.match(source, /downloadAvailable: true/); assert.match(source, /writeFile/); assert.match(source, /readFile/);
});

test("download creation contains no external source API calls", () => {
  const sources = ["netlify/functions/unified-excel.js", "netlify/functions/download-history.js"].map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(sources, /openapi\.naver|youtube\.googleapis|keywordstool|searchad\/|\/datalab\//i);
});

test("download buttons exist once and are located inside today Early Signal section", () => {
  const html = fs.readFileSync("index.html", "utf8"); const panel = html.slice(html.indexOf('id="todayEarlySignalPanel"'), html.indexOf('id="yesterdaySurgePanel"'));
  assert.equal((html.match(/id="excelDownloadBtn"/g) || []).length, 1); assert.equal((html.match(/id="downloadHistoryBtn"/g) || []).length, 1);
  assert.match(panel, /전체 결과 엑셀 다운로드/); assert.match(panel, /다운로드 신청 이력/);
});

test("integrated download uses cached rows and does not mix period into main results", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /downloadType: "unified_results"/); assert.match(html, /state\.marketDiscoveryRows\.slice\(0, 100\)/);
  assert.match(fs.readFileSync("netlify/functions/download-history.js", "utf8"), /readLatestSnapshot\("instant"\)/);
});

test("unified filename is an xlsx timestamped in the existing history flow", () => {
  assert.match(download.unifiedFilename(new Date("2026-09-03T01:23:00Z")), /^monitoring-all-results-\d{8}-\d{4}\.xlsx$/);
});
