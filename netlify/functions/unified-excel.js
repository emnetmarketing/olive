const ExcelJS = require("exceljs");

const gradeLabels = { very_strong: "매우 강함", strong: "강함", medium: "보통", reference: "참고" };
const strengthLabels = { strong: "강한 신호", rising: "상승 신호", watch: "관찰 신호" };
const asDate = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value) : null;
const text = (value) => Array.isArray(value) ? value.filter(Boolean).join(" / ") : String(value ?? "");
const percent = (value) => value == null || value === "" ? null : Number(value) / 100;
const sourceList = (row) => row.discoverySource || row.sources || [];

function resultRow(row) {
  const signal = row.relatedSignal || {}; const match = row.match || {}; const item = match.item || {};
  const early = row.earlyMarketEvidence || {};
  return {
    keyword: row.keyword, latestDataDate: asDate(row.latestDataDate), estimatedSurgeCount: Number(row.estimatedSurgeCount || 0),
    relativeLift: percent(row.peakRelativeLiftPct), baseline: Number(row.estimatedBaseline ?? row.peakBaseline ?? 0),
    peakDailyLift: Number(row.peakDailyLift || 0), peakDate: asDate(row.peakDate || row.peakDailyDate), resultType: row.resultType || "",
    confidenceScore: row.marketConfidenceScore == null ? null : Number(row.marketConfidenceScore),
    confidenceGrade: gradeLabels[row.marketConfidenceGrade] || "", confidenceReasons: text(row.marketConfidenceReasons),
    matchScore: Number(match.score || 0) / 100, product: item.product || signal.referenceProducts?.[0]?.product || "",
    brand: signal.relatedBrand || item.brand || "", productContext: signal.relatedProductContext || signal.relatedProductLine || signal.relatedProductType || "",
    youtubeEvidence: early.comparisons?.youtube ? JSON.stringify(early.comparisons.youtube) : "",
    searchAdEvidence: row.searchAdNewQuery ? "신규 유입" : Number(row.searchAdImpressionDelta || 0) ? `노출 변화 ${Number(row.searchAdImpressionDelta)}` : "",
    shoppingRise: row.shoppingRise == null ? null : Number(row.shoppingRise), newsEvidence: row.news?.total ? `${row.news.total}건` : "",
    discoverySource: text(sourceList(row))
  };
}

function earlyRow(row) {
  const yt = row.comparisons?.youtube; const ad = row.comparisons?.searchAd;
  return { keyword: row.keyword, strength: strengthLabels[row.strength] || row.strength || "", score: Number(row.todayEarlySignalScore || 0),
    detectedAt: asDate(row.detectedAt), reasons: text(row.reasons), productBrand: text([row.relatedBrand, row.relatedProductLine || row.relatedProductType, row.relatedProduct].filter(Boolean)),
    sources: text(row.sources), youtubeChange: yt ? `현재 ${yt.current} / 이전 ${yt.previous} / Δ ${yt.delta}` : "",
    searchAdChange: ad ? `현재 ${ad.current} / 이전 ${ad.previous ?? "-"} / Δ ${ad.delta ?? "-"}` : "",
    previousNaver: row.previousNaverState ? text([row.previousNaverState.resultType, row.previousNaverState.estimatedSurgeCount]) : "",
    earlySignalDate: asDate(row.earlySignalDate) };
}

function discoveryRow(row) {
  return { rank: Number(row.rank || 0), keyword: row.keyword, sources: text(row.discoverySource), discoveredAt: asDate(row.discoveredAt),
    lastSeenAt: asDate(row.lastSeenAt), confidence: Number(row.sourceConfidence || 0), brand: row.relatedBrand || "",
    productContext: row.relatedProductLine || row.relatedProductType || "", monthlySearchStatus: row.monthlySearchStatus || "",
    monthlyTotalSearches: row.monthlyTotalSearches == null ? null : Number(row.monthlyTotalSearches), marketDiscoveryRank: Number(row.marketDiscoveryRank || 0),
    protectedSlot: row.selectedForProtectedSlot ? "Y" : "N", trendStatus: row.trendStatus || "" };
}

const resultColumns = [
  ["keyword", "키워드", 24], ["latestDataDate", "NAVER 데이터 기준일", 16, "yyyy-mm-dd"], ["estimatedSurgeCount", "estimatedSurgeCount", 18, "#,##0"],
  ["relativeLift", "상대 상승률", 13, "0.00%"], ["baseline", "baseline", 13, "#,##0"], ["peakDailyLift", "peakDailyLift", 15, "#,##0.00"],
  ["peakDate", "Peak 날짜", 13, "yyyy-mm-dd"], ["resultType", "resultType", 24], ["confidenceScore", "종합 신뢰도 점수", 16, "0"],
  ["confidenceGrade", "종합 신뢰도 등급", 16], ["confidenceReasons", "핵심 신뢰 근거", 42], ["matchScore", "상품 매칭률", 13, "0%"],
  ["product", "대표 상품", 40], ["brand", "브랜드", 18], ["productContext", "제품라인/성분/제품군", 28], ["youtubeEvidence", "YouTube 근거", 30],
  ["searchAdEvidence", "Search Ad 근거", 24], ["shoppingRise", "Shopping Rise", 15, "0.00"], ["newsEvidence", "News 근거", 16], ["discoverySource", "discovery source", 28]
];

function addSheet(workbook, name, columns, rows) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = columns.map(([key, header, width, numFmt]) => ({ key, header, width, style: numFmt ? { numFmt } : {} }));
  sheet.addRows(rows);
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  sheet.getRow(1).eachCell((cell) => { cell.font = { bold: true, color: { argb: "FFFFFFFF" } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4F46E5" } }; cell.alignment = { vertical: "middle" }; });
  sheet.getRow(1).height = 24;
  sheet.eachRow((row, index) => { if (index > 1) row.alignment = { vertical: "top", wrapText: true }; });
  return sheet;
}

function periodStatus(job, request) {
  if (!job) return request?.startDate && request?.endDate ? "분석 이력 없음" : "선택 기간 없음";
  if (Number(job.cacheWindowUnavailableCount || 0) > 0 && Number(job.trendCoveragePct || 0) < 100) return "cache window 부족 / 부분 분석";
  return job.partialAnalysis ? "부분 분석" : "완료";
}

function addPeriodSheet(workbook, job, request) {
  const meta = [
    ["선택 시작일", request?.startDate || job?.startDate || ""], ["선택 종료일", request?.endDate || job?.endDate || ""],
    ["required cache window", job?.queryStartDate && job?.endDate ? `${job.queryStartDate} ~ ${job.endDate}` : ""],
    ["NAVER 사용 가능 기준일", job?.latestDataDate || "확인 불가"], ["coverage", Number(job?.trendCoveragePct || 0) / 100],
    ["분석 완료 후보", Number(job?.trendAvailableCount || 0)], ["전체 후보", Number(job?.analyzedCandidateCount || job?.totalCandidates || 0)],
    ["결과 건수", Number(job?.results?.length || 0)], ["분석 상태", periodStatus(job, request)]
  ];
  const sheet = workbook.addWorksheet("07_선택기간분석", { views: [{ state: "frozen", ySplit: 12 }] });
  meta.forEach((row) => sheet.addRow(row)); sheet.getCell(5, 2).numFmt = "0.0%";
  sheet.addRow([]); const headerRow = sheet.addRow(resultColumns.map(([, header]) => header));
  headerRow.eachCell((cell) => { cell.font = { bold: true, color: { argb: "FFFFFFFF" } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4F46E5" } }; });
  sheet.autoFilter = { from: { row: 11, column: 1 }, to: { row: 11, column: resultColumns.length } };
  sheet.columns = resultColumns.map(([, , width]) => ({ width }));
  const rows = (job?.results || []).map(resultRow);
  if (rows.length) for (const row of rows) sheet.addRow(resultColumns.map(([key]) => row[key]));
  else sheet.addRow(["분석 결과 없음"]);
  resultColumns.forEach(([, , , numFmt], index) => { if (numFmt) for (let row = 12; row <= sheet.rowCount; row += 1) sheet.getCell(row, index + 1).numFmt = numFmt; });
  return sheet;
}

async function buildWorkbook(data) {
  const workbook = new ExcelJS.Workbook(); workbook.creator = "네쇼검 트렌드 모니터"; workbook.created = new Date();
  const instant = data.instantJob || {}; const results = instant.results || []; const early = data.early?.items || []; const discoveries = data.discoveries || [];
  const summaryRows = [
    { item: "파일 생성 시각", value: asDate(data.generatedAt) }, { item: "오늘 급상승 신호 기준일", value: asDate(data.early?.signalDate) },
    { item: "오늘 신호 마지막 갱신 시각", value: asDate(data.early?.generatedAt) }, { item: "NAVER 최신 데이터 기준일", value: asDate(instant.latestDataDate) },
    { item: "어제 분석 coverage", value: Number(instant.trendCoveragePct || 0) / 100 }, { item: "분석 완료 수", value: Number(instant.trendAvailableCount || 0) },
    { item: "전체 후보 수", value: Number(instant.analyzedCandidateCount || 0) }, { item: "급등 기준", value: Number(instant.surgeThreshold || 0) },
    { item: "상품 일치율 기준", value: Number(instant.matchThreshold || 0) / 100 }, { item: "오늘 급상승 신호 건수", value: early.length },
    { item: "어제 급등 전체 결과 건수", value: results.length }, { item: "상품 직접 매칭 건수", value: results.filter((r) => r.resultType === "product_match").length },
    { item: "브랜드/카테고리 건수", value: results.filter((r) => r.resultType === "brand_or_category_signal").length },
    { item: "기타 관련 급등 건수", value: results.filter((r) => r.resultType === "domain_related_signal").length }, { item: "최근 발견 키워드 건수", value: discoveries.length },
    { item: "선택 분석 시작일", value: data.periodRequest?.startDate || data.periodJob?.startDate || "" },
    { item: "선택 분석 종료일", value: data.periodRequest?.endDate || data.periodJob?.endDate || "" },
    { item: "선택 기간 coverage", value: Number(data.periodJob?.trendCoveragePct || 0) / 100 },
    { item: "선택 기간 결과 건수", value: Number(data.periodJob?.results?.length || 0) },
    { item: "선택 기간 분석 상태", value: periodStatus(data.periodJob, data.periodRequest) }
  ];
  const summary = addSheet(workbook, "00_요약", [["item", "항목", 30], ["value", "값", 28]], summaryRows);
  summaryRows.forEach((row, index) => {
    const cell = summary.getCell(index + 2, 2);
    if (row.value instanceof Date) cell.numFmt = "yyyy-mm-dd hh:mm";
    else if (["어제 분석 coverage", "상품 일치율 기준", "선택 기간 coverage"].includes(row.item)) cell.numFmt = "0.0%";
    else if (typeof row.value === "number") cell.numFmt = "#,##0";
  });
  addSheet(workbook, "01_오늘 급상승 신호", [["keyword", "키워드", 24], ["strength", "신호 강도", 14], ["score", "Early Signal Score", 18, "0"],
    ["detectedAt", "발견 시각", 20, "yyyy-mm-dd hh:mm"], ["reasons", "주요 탐지 근거", 42], ["productBrand", "상품/브랜드", 32], ["sources", "Source", 24],
    ["youtubeChange", "YouTube 변화", 28], ["searchAdChange", "Search Ad 변화", 28], ["previousNaver", "전일 NAVER 상태", 22], ["earlySignalDate", "Early Signal 날짜", 18, "yyyy-mm-dd"]], early.map(earlyRow));
  addSheet(workbook, "02_어제 급등 확인", resultColumns, results.map(resultRow));
  addSheet(workbook, "03_상품 직접 매칭", resultColumns, results.filter((r) => r.resultType === "product_match").map(resultRow));
  addSheet(workbook, "04_브랜드_카테고리", resultColumns, results.filter((r) => r.resultType === "brand_or_category_signal").map(resultRow));
  addSheet(workbook, "05_기타 관련 급등", resultColumns, results.filter((r) => r.resultType === "domain_related_signal").map(resultRow));
  addSheet(workbook, "06_최근 발견 키워드", [["rank", "순위", 8, "0"], ["keyword", "키워드", 24], ["sources", "발견 소스", 24],
    ["discoveredAt", "최초 발견", 20, "yyyy-mm-dd hh:mm"], ["lastSeenAt", "마지막 발견", 20, "yyyy-mm-dd hh:mm"], ["confidence", "sourceConfidence", 17, "0"],
    ["brand", "관련 브랜드", 18], ["productContext", "제품군/제품라인", 24], ["monthlySearchStatus", "월간검색량 상태", 18],
    ["monthlyTotalSearches", "월간검색량", 14, "#,##0"], ["marketDiscoveryRank", "후보 순위", 12, "0"], ["protectedSlot", "500 보호 슬롯", 14], ["trendStatus", "Trend 상태", 20]], discoveries.map(discoveryRow));
  if (data.periodJob?.jobId || (data.periodRequest?.startDate && data.periodRequest?.endDate)) addPeriodSheet(workbook, data.periodJob, data.periodRequest);
  return workbook;
}

async function toBuffer(data) { const workbook = await buildWorkbook(data); return Buffer.from(await workbook.xlsx.writeBuffer()); }
module.exports = { buildWorkbook, toBuffer, resultRow, earlyRow, discoveryRow, resultColumns, periodStatus, addPeriodSheet };
