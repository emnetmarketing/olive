const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const ExcelJS = require("exceljs");
const time = require("../shared/kst-time-presentation");
const { toBuffer, earlyRow, discoveryRow, resultRow, periodResultRow } = require("../netlify/functions/unified-excel");

const cases = [
  ["2026-11-02T00:30:00Z", "2026-11-02 09:30:00"],
  ["2026-11-01T18:30:00Z", "2026-11-02 03:30:00"],
  ["2026-11-02T09:30:00+09:00", "2026-11-02 09:30:00"],
  ["2026-11-01T15:00:00Z", "2026-11-02 00:00:00"],
  ["2026-11-02T00:30:00.987Z", "2026-11-02 09:30:00"]
];
test("KST presentation converts explicit instants once, including midnight", () => {
  for (const [input, expected] of cases) {
    assert.equal(time.formatKstTimestamp(input), expected);
    assert.equal(time.toKstExcelDate(input).toISOString(), expected.replace(" ", "T") + ".000Z");
  }
  const input = new Date(cases[0][0]), original = input.getTime();
  assert.equal(time.formatKstTimestamp(input), cases[0][1]); assert.equal(input.getTime(), original);
});
test("missing and unzoned timestamps are not guessed; date-only fields remain dates", () => {
  for (const input of [null, undefined, ""]) {
    assert.equal(time.formatKstTimestamp(input), "—"); assert.equal(time.toKstExcelDate(input), null);
  }
  for (const input of ["2026-11-02", "2026-11-02T09:30:00", "2026-11-02 09:30:00", "not a date", false]) {
    assert.equal(time.formatKstTimestamp(input), "시간대 미확인"); assert.equal(time.toKstExcelDate(input), null);
  }
  assert.equal(time.formatDateOnly("2026-11-01"), "2026-11-01");
  assert.equal(time.toDateOnlyExcelDate("2026-11-01").toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(time.toDateOnlyExcelDate("2026-02-30"), null);
});
test("display and Excel timestamp values do not depend on process timezone", () => {
  const script = `const t=require('./shared/kst-time-presentation');console.log(JSON.stringify(${JSON.stringify(cases)}.map(([v])=>[t.formatKstTimestamp(v),t.toKstExcelDate(v).toISOString(),t.toDateOnlyExcelDate('2026-11-01').toISOString()])));`;
  const outputs = ["UTC", "America/Los_Angeles", "Asia/Seoul"].map(TZ => execFileSync(process.execPath, ["-e", script], { cwd: process.cwd(), env: { ...process.env, TZ }, encoding: "utf8" }));
  assert.equal(outputs[0], outputs[1]); assert.equal(outputs[1], outputs[2]);
});
test("actual serialized workbook has KST cell values and second precision, not just KST headings", async () => {
  const data = {
    generatedAt: cases[0][0], instantJob: { jobId: "instant", latestDataDate: "2026-11-01", targetDataDate: "2026-11-01",
      productCacheObservedAt: cases[2][0], results: [{ keyword: "세럼", latestDataDate: "2026-11-01", peakDate: "2026-10-31", estimatedSurgeCount: 1121 }] },
    early: { signalDate: "2026-11-02", generatedAt: cases[1][0], items: cases.slice(0,3).map(([detectedAt], i) => ({ keyword: "신호" + i, detectedAt, earlySignalDate: "2026-11-02" })) },
    discoveries: [{ keyword: "키워드", discoveredAt: cases[1][0], lastSeenAt: cases[2][0] }],
    periodRequest: { startDate: "2026-10-01", endDate: "2026-10-16" },
    periodJob: { jobId: "period", startDate: "2026-10-01", endDate: "2026-10-16", results: [{ keyword: "기간", latestDataDate: "2026-10-14" }] }
  };
  const original = JSON.stringify(data), wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await toBuffer(data)); assert.equal(JSON.stringify(data), original);
  const assertTime = (sheet, cell, expected) => {
    const c = wb.getWorksheet(sheet).getCell(cell);
    assert.ok(c.value instanceof Date); assert.equal(c.value.toISOString(), expected.replace(" ", "T") + ".000Z");
    assert.equal(c.numFmt, "yyyy-mm-dd hh:mm:ss");
  };
  assertTime("00_요약", "B2", cases[0][1]); assertTime("00_요약", "B4", cases[1][1]); assertTime("00_요약", "B8", cases[2][1]);
  for (let i = 0; i < 3; i++) assertTime("01_오늘 급상승 신호", "D" + (i+2), cases[i][1]);
  assertTime("06_최근 발견 키워드", "D2", cases[1][1]); assertTime("06_최근 발견 키워드", "E2", cases[2][1]);
  for (const [sheet, cell] of [["00_요약", "A2"], ["00_요약", "A4"], ["00_요약", "A8"], ["01_오늘 급상승 신호", "D1"], ["06_최근 발견 키워드", "D1"], ["06_최근 발견 키워드", "E1"]]) assert.match(wb.getWorksheet(sheet).getCell(cell).value, /한국시간\(KST\)/);
  for (const [sheet, cell, date] of [["00_요약", "B3", "2026-11-02"], ["00_요약", "B5", "2026-11-01"], ["00_요약", "B6", "2026-11-01"], ["02_어제 급등 확인", "B2", "2026-11-01"], ["01_오늘 급상승 신호", "K2", "2026-11-02"], ["07_선택기간분석", "A12", "2026-10-01"], ["07_선택기간분석", "B12", "2026-10-16"]]) {
    const c = wb.getWorksheet(sheet).getCell(cell); assert.equal(c.value.toISOString(), date + "T00:00:00.000Z"); assert.equal(c.numFmt, "yyyy-mm-dd");
  }
});
test("ambiguous or missing export timestamps stay blank rather than fabricated", () => {
  assert.equal(earlyRow({ detectedAt: "2026-11-02T09:30:00" }).detectedAt, null);
  assert.equal(discoveryRow({ lastSeenAt: "" }).lastSeenAt, null);
  assert.equal(resultRow({ latestDataDate: "2026-11-01" }).latestDataDate.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(periodResultRow({}, { startDate: "2026-10-01", endDate: "2026-10-16" }).endDate.toISOString(), "2026-10-16T00:00:00.000Z");
});
