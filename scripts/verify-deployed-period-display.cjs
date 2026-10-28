/* Read-only/offline display proof. Execute functions extracted from the supplied
 * deployed HTML against saved HTTP response bodies. Never contact Production,
 * request a download, start an analysis, or substitute source calculation code. */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const assert = require("node:assert/strict");

const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const digest = value => sha(JSON.stringify(ordered(value)));
const clone = value => JSON.parse(JSON.stringify(value));
const decode = text => String(text).replace(/&#(?:x([\da-f]+)|(\d+));|&(amp|lt|gt|quot|apos);/gi,
  (_, hex, decimal, name) => hex || decimal ? String.fromCodePoint(parseInt(hex || decimal, hex ? 16 : 10))
    : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name.toLowerCase()]);
const plain = html => decode(String(html).replace(/<[^>]*>/g, ""));

function extractFunction(html, name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, "m").exec(html);
  assert.ok(start, `Supplied HTML lacks function ${name}`);
  const remainder = html.slice(start.index);
  const boundary = /\r?\n    (?:async )?function \w+\(/.exec(remainder);
  assert.ok(boundary, `Cannot safely extract ${name}`);
  return remainder.slice(0, boundary.index);
}

function unzip(bytes) {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, "XLSX ZIP end record missing");
  const files = new Map(); let cursor = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10), size = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    const begin = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    assert.ok(method === 0 || method === 8, "Unsupported XLSX compression");
    const compressed = bytes.subarray(begin, begin + size);
    files.set(name, (method === 8 ? zlib.inflateRawSync(compressed) : compressed).toString());
    cursor += 46 + nameLength + extra + comment;
  }
  return files;
}

function verifyExcel(bytes, job) {
  const files = unzip(bytes);
  const shared = [...(files.get("xl/sharedStrings.xml") || "").matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(match => [...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(item => decode(item[1])).join(""));
  const sheets = [...files.get("xl/workbook.xml").matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/?\s*>/g)];
  const relationships = new Map([...files.get("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b([^>]+)\/?\s*>/g)]
    .map(match => [match[1].match(/\bId="([^"]+)"/)?.[1], match[1].match(/\bTarget="([^"]+)"/)?.[1]]));
  function sheetCells(name) {
    const sheet = sheets.find(item => decode(item[1]) === name); assert.ok(sheet, `Missing ${name}`);
    const target = relationships.get(sheet[2]); assert.ok(target);
    const xml = files.get(target.startsWith("/") ? target.slice(1) : path.posix.normalize(`xl/${target}`)); assert.ok(xml);
    return new Map([...xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(match => {
      const ref = match[1].match(/\br="([^"]+)"/)?.[1], type = match[1].match(/\bt="([^"]+)"/)?.[1];
      const value = (match[2] || "").match(/<v>([\s\S]*?)<\/v>/)?.[1];
      return [ref, type === "s" ? shared[Number(value)] : type === "inlineStr" ? plain(match[2] || "") : value === undefined ? null : Number(value)];
    }));
  }
  const cells = sheetCells("07_선택기간분석"), summary = sheetCells("00_요약");
  // The existing workbook does not necessarily embed Job ID. Do not invent
  // provenance from matching row values; report that limit separately.
  const jobIdEmbedded = [...cells.values()].includes(job.jobId);
  assert.equal(cells.get("B1"), job.startDate); assert.equal(cells.get("B2"), job.endDate);
  assert.equal(cells.get("B3"), `${job.queryStartDate} ~ ${job.endDate}`);
  const grades = { very_strong: "매우 강함", strong: "강함", medium: "보통", reference: "참고" };
  const header = [...cells].find(([ref, value]) => /^C\d+$/.test(ref) && value === "키워드");
  assert.ok(header, "Period keyword header missing"); const firstRow = Number(header[0].slice(1)) + 1;
  for (const [i, row] of job.results.entries()) {
    const excelRow = firstRow + i;
    assert.equal(cells.get(`C${excelRow}`), row.keyword);
    assert.equal(cells.get(`D${excelRow}`) ?? null, row.estimatedSurgeCount ?? null);
    assert.equal(cells.get(`E${excelRow}`) ?? null, row.peakRelativeLiftPct == null ? null : row.peakRelativeLiftPct / 100);
    assert.equal(cells.get(`F${excelRow}`) ?? null, row.periodMarketConfidenceScore ?? null);
    const grade = row.periodMarketConfidenceGrade;
    if (grade) assert.equal(cells.get(`G${excelRow}`), grades[grade] || "참고");
  }
  assert.ok(!cells.has(`C${firstRow + job.results.length}`), "Excel includes extra Period results");
  const countRow = [...summary].find(([ref, value]) => /^A\d+$/.test(ref) && value === "선택 기간 결과 건수");
  assert.ok(countRow); assert.equal(summary.get(countRow[0].replace(/^A/, "B")), job.results.length);
  return { verified: true, comparedJobId: job.jobId, jobIdEmbedded, resultCount: job.results.length,
    periodAndWindowMatch: true, valuesAndOrderMatch: true, sha256: sha(bytes) };
}

async function verifyDisplay({ html, period, instant, status, snapshot, partial, excel, growthScript, provenance = "unspecified local saved inputs" }) {
  assert.equal(period.mode, "period"); assert.equal(period.state, "completed");
  assert.ok(period.jobId && period.startDate && period.endDate && Array.isArray(period.results));
  if (period.resultCount != null) assert.equal(period.resultCount, period.results.length);
  if (status) {
    assert.equal(status.jobId, period.jobId); assert.equal(status.state, "completed");
    assert.equal(status.startDate, period.startDate); assert.equal(status.endDate, period.endDate);
    assert.equal(digest(status.results), digest(period.results));
  }
  if (snapshot) {
    assert.equal(snapshot.jobId, period.jobId); assert.equal(snapshot.mode, "period");
    assert.equal(snapshot.startDate, period.startDate); assert.equal(snapshot.endDate, period.endDate);
    assert.equal(digest(snapshot.items || snapshot.results), digest(period.results));
  }
  const nodes = new Map(), requests = [], downloads = [], errors = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: "", innerHTML: "", textContent: "", classList: { toggle() {} } });
    return nodes.get(id);
  };
  node("collectionStart").value = period.startDate; node("collectionEnd").value = period.endDate;
  const instantFixture = instant || { jobId: "LOCAL-ONLY-INSTANT-GUARD-FIXTURE", mode: "instant", state: "completed", results: [] };
  const instantBefore = digest(instantFixture);
  const context = vm.createContext({
    state: { currentAnalysisJob: clone(instantFixture), currentPeriodAnalysisJob: null, periodResultQuery: "", marketDiscoveryRows: [] },
    $: node,
    log() {}, showApiErrors(value) { errors.push(value); }, alert(message) { throw new Error(message); },
    triggerXlsxDownload(filename, contentBase64) { downloads.push({ filename, byteLength: Buffer.from(contentBase64, "base64").length }); },
    async renderDownloadHistoryShared() {},
    async fetch(route, options = {}) {
      const url = new URL(route, "https://OFFLINE.invalid");
      assert.equal(url.origin, "https://offline.invalid", "Network access forbidden");
      const method = options.method || "GET";
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method, body });
      if (url.pathname === "/.netlify/functions/trend-analysis-latest" && method === "GET") {
        assert.equal(url.searchParams.get("mode"), "period");
        const payload = url.searchParams.get("result") === "full" ? period : partial || null;
        return new Response(JSON.stringify(payload), { status: payload ? 200 : 404 });
      }
      if (url.pathname === "/.netlify/functions/download-history" && method === "POST") {
        // Inspect the actual UI request, but never perform the write or pretend
        // the dummy payload is an Excel file. Optional supplied XLSX is separate.
        return new Response(JSON.stringify({ filename: "OFFLINE-REQUEST-BINDING-ONLY.xlsx", contentBase64: "" }), { status: 201 });
      }
      throw new Error(`Unapproved offline UI route ${method} ${url.pathname}`);
    }
  }, { codeGeneration: { strings: false, wasm: false } });
  if (html.includes("ResultGrowthPresentation.growthView(")) {
    assert.ok(growthScript, "Supply the same deployed /shared/result-growth-presentation.js asset; do not substitute a different source version");
    vm.runInContext(growthScript, context, { filename: "supplied-result-growth-presentation.js" });
  }
  const functions = ["escapeHtml", "formatDateTimeText", "formatHistoryDate", "surgeSignalSummary", "periodSelectionMatchesJob",
    ...(html.includes("function storedPeriodConfidenceDisplay(") ? ["storedInstantConfidenceDisplay", "storedPeriodConfidenceDisplay"] : []),
    "periodConfidenceSummary", "periodRelationSummary", "periodSourceEvidence", "periodDataStatus", "periodResultRow",
    "renderPeriodResultTables", "refreshPeriodSelectionDisplay", "displayPeriodAnalysis", "displayCompletedAnalysis",
    "loadLastSuccessfulAnalysis", "downloadExcelShared"];
  for (const name of functions) vm.runInContext(extractFunction(html, name), context, { filename: `deployed-index.html:${name}` });
  const loaded = await context.loadLastSuccessfulAnalysis("period");
  assert.equal(errors.length, 0, JSON.stringify(errors)); assert.equal(loaded?.jobId, period.jobId);
  assert.equal(digest(context.state.currentPeriodAnalysisJob.results), digest(period.results));
  const keywords = markup => [...markup.matchAll(/data-period-keyword="([^"]*)"/g)].map(match => decode(match[1]));
  const allMarkup = node("periodAnalysisBody").innerHTML;
  const topMarkup = node("periodAnalysisTopBody").innerHTML;
  const expectedKeywords = period.results.map(row => String(row.keyword || "").toLowerCase());
  assert.deepEqual(keywords(allMarkup), expectedKeywords);
  assert.deepEqual(keywords(topMarkup), expectedKeywords.slice(0, 10));
  assert.ok(node("periodAnalysisMeta").textContent.includes(period.startDate));
  assert.ok(node("periodAnalysisMeta").textContent.includes(period.endDate));
  assert.ok(node("periodAnalysisMeta").textContent.includes(`${period.results.length.toLocaleString("ko-KR")}건`));
  const renderedRows = [...allMarkup.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(match => [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(cell => plain(cell[1])));
  for (const [i, row] of period.results.entries()) {
    const cells = renderedRows[i]; assert.equal(cells.length, 11);
    assert.equal(cells[0], String(i + 1)); assert.ok(cells[1].startsWith(String(row.keyword || "")));
    assert.equal(cells[2], row.estimatedSurgeCount == null ? "계산 불가" : `+${Number(row.estimatedSurgeCount).toLocaleString("ko-KR")}`);
    if (context.ResultGrowthPresentation) {
      const growth = context.ResultGrowthPresentation.growthView(row);
      assert.equal(cells[3], growth.rateLabel + (growth.roundedToZero ? `원본 기준 ${growth.baselineLabel}` : ""));
    } else assert.equal(cells[3], row.peakRelativeLiftPct == null ? "비교 불가" : `+${Number(row.peakRelativeLiftPct).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}%`);
    const confidence = row.qualityProjection && row.periodMarketConfidenceScore === null ? null : row.periodMarketConfidenceScore ?? row.marketConfidenceScore;
    assert.ok(cells[4].includes(confidence == null ? row.qualityProjection?.displayWarning ? "확인 불가" : "미계산" : `${Number(confidence)}/100`));
    const displayReasons = context.storedPeriodConfidenceDisplay ? context.storedPeriodConfidenceDisplay(row).reasons
      : row.periodMarketConfidenceReasons || row.marketConfidenceReasons || [];
    for (const reason of displayReasons.slice(0, 5)) assert.ok(cells[5].includes(reason));
    for (const [column, source] of [[7, row.periodMarketEvidence?.youtube], [8, row.periodMarketEvidence?.searchAd]]) {
      if (!source || source.availability === "no_data") assert.equal(cells[column], "데이터 없음");
      else if (source.delta == null) assert.ok(cells[column].includes("비교 불가"));
    }
  }
  const originalMeta = node("periodAnalysisMeta").textContent;
  if (period.cacheOnlyRecovery) {
    assert.ok(originalMeta.includes(period.jobId)); assert.ok(originalMeta.includes("캐시 확보율은 요청 종료일까지의 데이터 완전성을 의미하지 않습니다"));
    if (period.actualDataEndDate) assert.ok(originalMeta.includes(period.actualDataEndDate));
  }
  const query = expectedKeywords[0] || "no-matches";
  context.state.periodResultQuery = query; context.renderPeriodResultTables();
  assert.deepEqual(keywords(node("periodAnalysisBody").innerHTML), expectedKeywords.filter(keyword => keyword.includes(query)));
  context.state.periodResultQuery = ""; context.renderPeriodResultTables();
  await context.downloadExcelShared();
  const exportRequest = requests.find(item => item.method === "POST").body;
  assert.equal(exportRequest.periodJobId, period.jobId); assert.equal(exportRequest.periodStartDate, period.startDate); assert.equal(exportRequest.periodEndDate, period.endDate);
  node("collectionStart").value = period.startDate === "2000-01-01" ? "2000-01-02" : "2000-01-01";
  context.refreshPeriodSelectionDisplay();
  assert.equal(keywords(node("periodAnalysisBody").innerHTML).length, 0);
  assert.ok(node("periodAnalysisMeta").textContent.includes("일치하는 분석 결과가 없습니다"));
  await context.downloadExcelShared();
  assert.equal(requests.filter(item => item.method === "POST").at(-1).body.periodJobId, null);
  assert.equal(digest(context.state.currentAnalysisJob), instantBefore);
  return {
    verificationKind: "Actual supplied HTML functions plus saved API responses, executed offline in a minimal DOM; NOT a logged-in browser visual test",
    provenance, htmlSha256: sha(html), growthScriptSha256: growthScript ? sha(growthScript) : null, jobId: period.jobId, selectedPeriod: [period.startDate, period.endDate],
    requiredWindow: [period.queryStartDate, period.endDate], resultCount: period.results.length, rowsDigest: digest(period.results),
    actualDataRange: [period.actualDataStartDate || null, period.actualDataEndDate || period.latestDataDate || null],
    metadata: originalMeta, top10OrderMatches: true, allRowsOrderMatches: true, numericAndEvidenceValuesMatch: true,
    searchFilterMatches: true, changedSelectionHidesOldRows: true, changedSelectionCannotExportOldJob: true,
    excelRequestBinding: { verified: true, ...exportRequest, actualDownloadPerformed: false },
    suppliedWorkbook: excel ? verifyExcel(excel, period) : { verified: false, reason: "No saved XLSX supplied; request binding is not an actual download verification" },
    statusMatches: status ? true : null, snapshotMatches: snapshot ? true : null,
    instantUnchanged: true, instantInputKind: instant ? "saved supplied Instant response" : "explicit local guard-only fixture",
    executedFunctionCount: functions.length, localFixtureRequests: requests.length,
    actualNetworkRequests: 0, productionWrites: 0, providerCalls: 0
  };
}

function readJson(file) {
  const saved = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  return typeof saved.body === "string" ? JSON.parse(saved.body) : saved;
}
async function main() {
  const [htmlPath, periodPath, reportPath, ...flags] = process.argv.slice(2);
  assert.ok(htmlPath && periodPath && reportPath, "Usage: node verify-deployed-period-display.cjs deployed-index.html period-latest.json report.json [--instant=...] [--status=...] [--snapshot=...] [--partial=...] [--excel=...] [--provenance=...]");
  const options = Object.fromEntries(flags.map(flag => { const index = flag.indexOf("="); assert.ok(index > 2); return [flag.slice(2, index), flag.slice(index + 1)]; }));
  const report = await verifyDisplay({ html: fs.readFileSync(htmlPath, "utf8").replace(/^\uFEFF/, ""), period: readJson(periodPath),
    ...Object.fromEntries(["instant", "status", "snapshot", "partial"].filter(name => options[name]).map(name => [name, readJson(options[name])])),
    excel: options.excel ? fs.readFileSync(options.excel) : undefined, growthScript: options["growth-script"] ? fs.readFileSync(options["growth-script"], "utf8") : undefined,
    provenance: options.provenance || "saved responses supplied by caller; provenance must be confirmed separately" });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: path.resolve(reportPath), jobId: report.jobId, resultCount: report.resultCount,
    rowsDigest: report.rowsDigest, networkRequests: 0, loggedInBrowserVisualVerification: false }));
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { verifyDisplay, verifyExcel, extractFunction, digest };
