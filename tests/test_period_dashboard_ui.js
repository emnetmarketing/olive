const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync("index.html", "utf8");

test("period dashboard has a dedicated result area with TOP 10 and all results", () => {
  assert.match(html, /<h2>선택 기간 분석 결과<\/h2>/);
  assert.match(html, /<h3>TOP 10<\/h3>/);
  assert.match(html, /id="periodAnalysisTopBody"/);
  assert.match(html, /id="periodAllResultsSummary">전체 결과 보기 \(0건\)/);
  assert.match(html, /id="periodAnalysisBody"/);
});

test("period dashboard exposes every requested existing result field", () => {
  for (const label of ["순위", "키워드", "NAVER 추정 급등량", "상승률", "기간 신뢰도", "기간 신뢰 근거", "상품·브랜드", "YouTube 기간 변화", "Search Ad 기간 변화", "데이터 상태", "NAVER 기준일"])
    assert.match(html, new RegExp(label));
  assert.match(html, /row\.estimatedSurgeCount/);
  assert.match(html, /row\.peakRelativeLiftPct/);
  assert.match(html, /row\.periodMarketConfidenceScore \?\? row\.marketConfidenceScore/);
  assert.match(html, /row\.periodMarketConfidenceReasons \|\| row\.marketConfidenceReasons/);
});

test("TOP 10 preserves the Period Job result order", () => {
  assert.match(html, /rows\.slice\(0, 10\)\.map\(periodResultRow\)/);
  assert.doesNotMatch(html, /rows\.slice\(0, 10\)\.sort/);
});

test("all period results can be expanded and searched locally", () => {
  assert.match(html, /<details id="periodAllResultsDetails"/);
  assert.match(html, /id="periodResultSearch" type="search"/);
  assert.match(html, /rows\.filter\(\(row\) => String\(row\.keyword \|\| ""\)\.toLowerCase\(\)\.includes\(query\)\)/);
  assert.doesNotMatch(html, /periodResultSearch[\s\S]{0,300}fetch\(/);
});

test("missing Period evidence is not rendered as zero", () => {
  assert.match(html, /source\.availability === "no_data"\) return '<span class="muted">데이터 없음/);
  assert.match(html, /source\.delta == null \? "비교 불가"/);
  assert.match(html, /row\.estimatedSurgeCount == null \? "계산 불가"/);
  assert.match(html, /row\.peakRelativeLiftPct == null \? "비교 불가"/);
});

test("selected dates must exactly match the displayed Period Job", () => {
  assert.match(html, /function periodSelectionMatchesJob\(job\)/);
  assert.match(html, /job\.startDate === \$\("collectionStart"\)\.value/);
  assert.match(html, /job\.endDate === \$\("collectionEnd"\)\.value/);
  assert.match(html, /기존 \$\{job\.startDate[\s\S]*결과를 새 기간 결과로 표시하지 않습니다/);
  assert.match(html, /bindEvent\("collectionStart", "change", refreshPeriodSelectionDisplay\)/);
  assert.match(html, /bindEvent\("collectionEnd", "change", refreshPeriodSelectionDisplay\)/);
});

test("dashboard and Excel use the same current Period Job identity", () => {
  assert.match(html, /state\.currentPeriodAnalysisJob = job/);
  assert.match(html, /matchingPeriodJobId = periodJob\?\.startDate === selectedStartDate && periodJob\?\.endDate === selectedEndDate \? periodJob\.jobId : null/);
  assert.match(html, /periodJobId: matchingPeriodJobId/);
});

test("running Period jobs show recent progress while stale jobs are distinct", () => {
  assert.match(html, /job\.updatedAt \|\| job\.progressUpdatedAt/);
  assert.match(html, /progressAgeMs >= 12 \* 60 \* 1000/);
  assert.match(html, /정상 계산 중 · 마지막 진행 갱신/);
  assert.match(html, /계산이 중단된 것으로 보입니다 · 재개 가능/);
  assert.match(html, /job\.mode === "period" && job\.state === "running"/);
});

test("period dashboard change is display-only and keeps collection and instant paths", () => {
  assert.match(html, /trend-analysis-start/);
  assert.match(html, /trend-period-data-collection-start/);
  assert.match(html, /loadLastSuccessfulAnalysis\("instant"\)/);
  assert.match(html, /loadTodayEarlySignals\(\)/);
});
