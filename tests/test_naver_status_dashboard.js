const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { extractFunction } = require("../scripts/verify-deployed-period-display.cjs");
const html = fs.readFileSync("index.html", "utf8");
const scripts = ["shared/kst-time-presentation.js", "shared/naver-status-presentation.js"]
  .map(file => fs.readFileSync(file, "utf8"));

function runtime(payload = {}) {
  const nodes = new Map(), requests = [], detailRows = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", innerHTML: "", hidden: false,
      classList: { toggle() {} }, style: {} });
    return nodes.get(id);
  };
  const context = vm.createContext({ $: node, state: { marketDiscoveryRows: [], periodResultQuery: "" },
    comparisonRow: row => { detailRows.push(row); return "<tr>" + row.cells.join("") + "</tr>"; },
    canOperate: () => true, fetch: async route => { requests.push(route); return new Response(JSON.stringify(payload)); } });
  for (const script of scripts) vm.runInContext(script, context);
  for (const name of ["escapeHtml", "formatHistoryDate", "earlyBrandContextSummary", "sourceFreshnessLabel", "earlySignalFreshnessDisplay",
    "sourceComparisonFacts", "sourceComparisonNames", "sourceComparisonTime", "sourceNaverBadges", "discoveryComparisonRow", "earlyComparisonRow",
    "loadMarketDiscoveryNewList", "loadTodayEarlySignals", "periodSelectionMatchesJob", "renderPeriodResultTables", "refreshPeriodSelectionDisplay"])
    vm.runInContext(extractFunction(html, name), context);
  // Rendering machinery is exercised; simple stable cells keep this test about
  // status/date binding rather than re-testing unchanged analysis calculations.
  context.periodResultRow = (row, rank) => `<tr><td>${rank + 1}</td><td>${row.keyword}</td></tr>`;
  return { context, node, requests, detailRows, details: () => detailRows.map(row => row.detail).join("") };
}

function status(overrides = {}) {
  return { jobId: "instant-fixed", targetDataDate: "2026-11-01", requiredWindow: { startDate: "2026-10-03", endDate: "2026-11-02" },
    selection: { state: "selected" }, data: { state: "target-observed", actualDataDate: "2026-11-01", fetchedAt: "2026-11-02T02:03:04Z" },
    collection: { state: "processed" }, assessment: { state: "not-assessed", label: "급등 판정 미확인" }, ...overrides };
}

test("recent-discovery headings distinguish recommendation from NAVER data verification", () => {
  assert.match(html, /<th>신규 후보 우선 선정<\/th><th>네이버 데이터 확인 상태<\/th>/);
  assert.doesNotMatch(html, /<th>보호 슬롯<\/th>|<th>Trend 상태<\/th>/);
  assert.match(html, /‘최근 24시간’은 발견 범위이지 네이버 수집 기간이 아닙니다/);
  assert.match(html, /naver-status-presentation\.js/);
});

test("priority, actual Job selection, cache, collection and assessment remain separate in each discovery row", async () => {
  const item = { keyword: "fixture", rank: 1, selectedForProtectedSlot: false, trendStatus: "not-selected",
    naverStatus: status() };
  const payload = { items: [item] }, before = JSON.stringify(payload), rt = runtime(payload);
  await rt.context.loadMarketDiscoveryNewList();
  const list = rt.node("marketDiscoveryNewBody").innerHTML, output = rt.details();
  assert.match(list, /우선 미선정/); assert.match(list, /분석 대상 선정/); assert.match(list, /11\/1 자료 있음/);
  assert.match(list, /판정 확인 불가/); assert.doesNotMatch(list, /기준 Instant Job|최근 24시간/);
  assert.match(output, /우선 검증 대상 미선정/);
  assert.match(output, /data-naver-status="selection">분석 대상 선정/);
  assert.match(output, /data-naver-status="data">검색 추이 데이터 있음 · 목표일 관측 있음/);
  assert.match(output, /data-naver-status="collection">저장된 조회 처리 기록 있음/);
  assert.match(output, /data-naver-status="assessment">급등 판정 미확인/);
  assert.match(output, /데이터 기준일: 2026-11-01/);
  assert.match(output, /2026-11-02 11:03:04/);
  assert.match(output, /기준 Instant Job: instant-fixed · 목표일: 2026-11-01/);
  assert.doesNotMatch(output, /보호 슬롯 대기|Trend 미조회|수집 대기/);
  assert.equal(JSON.stringify(payload), before);
  assert.deepEqual(rt.requests, ["/.netlify/functions/market-discovery-list?window=24h&limit=100"]);
});

test("a legacy pending label does not fabricate queue membership or target-day availability", async () => {
  const rt = runtime({ items: [{ keyword: "legacy", rank: 1, trendStatus: "pending", trendFetchedAt: "2026-11-02T02:00:00Z" }] });
  await rt.context.loadMarketDiscoveryNewList();
  const output = rt.details();
  assert.match(output, /선정 여부 확인 불가/);
  assert.match(output, /data-naver-status="collection">상태 확인 불가/);
  assert.match(output, /데이터 기준일: 확인 불가/);
  assert.doesNotMatch(output, />수집 대기<|>수집 중<|목표일 관측 있음|정상 cache 사용 가능/);
});

test("queue, running, old data and confirmed empty response are displayed only from their own structured state", async () => {
  const items = [
    { keyword: "queued", naverStatus: status({ collection: { state: "queued" }, data: { state: "cached-before-target", actualDataDate: "2026-10-31" } }) },
    { keyword: "running", naverStatus: status({ collection: { state: "running" }, data: { state: "missing" } }) },
    { keyword: "empty", naverStatus: status({ collection: { state: "processed" }, data: { state: "empty" } }) }
  ];
  const rt = runtime({ items }); await rt.context.loadMarketDiscoveryNewList();
  const list = rt.node("marketDiscoveryNewBody").innerHTML, output = rt.details();
  assert.match(list, /실제 수집 대기/); assert.match(list, /수집 중/); assert.match(list, /10\/31 자료 있음<\/span> <span class="cmp-badge">목표일 미확인/);
  assert.match(list, /조회 완료 · 빈 응답/); assert.doesNotMatch(list, /상승 확인/);
  assert.match(output, /data-naver-status="collection">수집 대기/);
  assert.match(output, /data-naver-status="collection">수집 중/);
  assert.match(output, /검색 추이 데이터 있음 · 목표일 미확인/);
  assert.match(output, /조회 완료 · 데이터 없음/);
  assert.doesNotMatch(output, /급등 아님/);
});

test("unlabelled budget states do not claim today's budget is exhausted", async () => {
  for (const budgetState of ["budget-held", "budget-exhausted"]) {
    const item = { keyword: budgetState, naverStatus: status({ collection: { state: budgetState } }) };
    const before = JSON.stringify(item), rt = runtime({ items: [item] });
    await rt.context.loadMarketDiscoveryNewList();
    const output = rt.details(); assert.match(rt.node("marketDiscoveryNewBody").innerHTML, /해당 작업 예산 제한/);
    assert.match(output, /data-naver-status="collection">해당 작업 예산 제한 · 현재 잔여 예산 확인 불가/);
    assert.doesNotMatch(output, /오늘 수집 예산 소진/);
    assert.equal(JSON.stringify(item), before);
  }
});

test("server-provided budget labels take precedence over the conservative fallback", async () => {
  for (const budgetState of ["budget-held", "budget-exhausted"]) {
    for (const label of ["오늘 수집 예산 소진", "해당 Job 내부 수집 예산 제한 · 일/월 구분 기록 없음"]) {
      const item = { keyword: budgetState, naverStatus: status({ collection: { state: budgetState, label } }) };
      const rt = runtime({ items: [item] });
      await rt.context.loadMarketDiscoveryNewList();
      const output = rt.details();
      assert.ok(output.includes(`<div data-naver-status="collection">${label}</div>`));
      assert.doesNotMatch(output, /해당 작업 예산 제한 · 현재 잔여 예산 확인 불가/);
    }
  }
});

test("today signals do not turn lifetime everSurged into a prior-day verdict", async () => {
  const payload = { signalDate: "2026-11-02", generatedAt: "2026-11-02T00:00:00Z", freshness: { status: "partial" }, items: [
    { keyword: "old-history", previousNaverState: { everSurged: true, estimatedSurgeCount: 9999 } },
    { keyword: "prior-confirmed", previousNaverState: { everSurged: false }, previousDayNaverStatus: status({ assessment: { state: "surge-confirmed", label: "전일 급등 확인" } }) },
    { keyword: "prior-empty", previousNaverState: { everSurged: true }, previousDayNaverStatus: status({ data: { state: "empty" } }) }
  ] };
  const before = JSON.stringify(payload), rt = runtime(payload);
  await rt.context.loadTodayEarlySignals();
  const list = rt.node("todayEarlySignalBody").innerHTML, output = rt.details();
  assert.match(list, /상승 확인/); assert.match(list, /조회 완료 · 빈 응답/);
  assert.doesNotMatch(rt.detailRows[0].cells.join(""), /상승 확인|9,999/);
  assert.match(output, /전일 NAVER 상태 확인 불가 · 해당 날짜의 조회·분석 기록 부족/);
  assert.match(output, /확인 대상일 2026-11-01 · 전일 급등 확인/);
  assert.match(output, /조회 완료 · 데이터 없음 · 급등 판정 미확인/);
  assert.doesNotMatch(output, /이전 상승 · \+9,999|이전 상승 · \+9999/);
  assert.equal(JSON.stringify(payload), before);
  assert.deepEqual(rt.requests, ["/.netlify/functions/today-early-signals"]);
});

function period() {
  return { jobId: "period439", mode: "period", state: "completed", startDate: "2026-10-01", endDate: "2026-10-16",
    actualDataStartDate: "2026-10-01", actualDataEndDate: "2026-10-14", latestDataDate: "2026-10-14",
    publishedAt: "2026-10-16T07:00:35.698Z", results: Array.from({ length: 439 }, (_, i) => ({ keyword: `saved-${i}` })) };
}

test("stored Period 439 has explicit historical/requested/actual labels without being attached to a different selected range", () => {
  const rt = runtime(), job = period(), before = JSON.stringify(job);
  rt.context.state.currentPeriodAnalysisJob = job;
  rt.node("collectionStart").value = "2026-10-26"; rt.node("collectionEnd").value = "2026-11-02";
  rt.context.refreshPeriodSelectionDisplay();
  const meta = rt.node("periodStoredResultMeta");
  assert.equal(meta.hidden, false);
  assert.match(meta.textContent, /저장된 과거 기간 결과/);
  assert.match(meta.textContent, /요청 기간 2026-10-01 ~ 2026-10-16/);
  assert.match(meta.textContent, /실제 확보 기간 2026-10-01 ~ 2026-10-14/);
  assert.match(meta.textContent, /저장 결과 439건/);
  assert.match(meta.textContent, /2026-10-16 16:00:35/);
  assert.match(rt.node("periodAnalysisMeta").textContent, /기존 2026-10-01 ~ 2026-10-16 결과를 새 기간 결과로 표시하지 않습니다/);
  assert.doesNotMatch(rt.node("periodAnalysisTopBody").innerHTML, /saved-/);
  assert.doesNotMatch(rt.node("periodAnalysisBody").innerHTML, /saved-/);
  assert.equal(rt.node("periodAllResultsSummary").textContent, "전체 결과 보기 (0건)");
  assert.equal(JSON.stringify(job), before); assert.equal(rt.requests.length, 0);
});

test("matching stored Period retains 439 rows, top10 order and local search without new analysis", () => {
  const rt = runtime(), job = period(), before = JSON.stringify(job);
  rt.context.state.currentPeriodAnalysisJob = job;
  rt.node("collectionStart").value = job.startDate; rt.node("collectionEnd").value = job.endDate;
  rt.context.renderPeriodResultTables();
  assert.equal((rt.node("periodAnalysisBody").innerHTML.match(/<tr>/g) || []).length, 439);
  assert.equal((rt.node("periodAnalysisTopBody").innerHTML.match(/<tr>/g) || []).length, 10);
  assert.match(rt.node("periodAnalysisTopBody").innerHTML, /saved-0[\s\S]*saved-9/);
  rt.context.state.periodResultQuery = "saved-438"; rt.context.renderPeriodResultTables();
  assert.match(rt.node("periodAnalysisBody").innerHTML, /saved-438/);
  assert.equal(JSON.stringify(job), before); assert.equal(rt.requests.length, 0);
});

test("status strings are escaped rather than interpreted as HTML", async () => {
  const rt = runtime({ items: [{ keyword: "safe", naverStatus: status({ assessment: { label: "<script>alert(1)</script>" } }) }] });
  await rt.context.loadMarketDiscoveryNewList();
  assert.match(rt.details(), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(rt.node("marketDiscoveryNewBody").innerHTML + rt.details(), /<script>/);
});

test("compact source rows keep order and the full per-keyword evidence outside the list", async () => {
  const warning = "기존 출처 신뢰도 · 정확한 분리 근거가 부족합니다";
  const items = [
    { keyword: "가나다".repeat(32), rank: 4, sourceConfidence: null, sourceConfidenceQuality: { warning },
      naverStatus: status({ data: { state: "window-unavailable", actualDataDate: "2026-10-23" } }) },
    { keyword: "다음 키워드", rank: 5, sourceConfidence: 0, naverStatus: status({ data: { state: "empty" },
      collection: { state: "error", errorCode: "UPSTREAM_503", label: "해당 Job 조회 오류: UPSTREAM_503" } }) }
  ];
  const rt = runtime({ items }), before = JSON.stringify(items); await rt.context.loadMarketDiscoveryNewList();
  const [first, second] = rt.detailRows;
  assert.deepEqual(rt.detailRows.map(row => row.keyword), items.map(row => row.keyword));
  assert.equal(first.cells.length, 8); assert.match(first.cells[4], /확인 불가/);
  assert.match(first.cells[7], /기간 데이터 부족 · 10\/23까지/);
  assert.doesNotMatch(first.cells.join(""), /정확한 분리 근거/); assert.ok(first.detail.includes(warning));
  assert.doesNotMatch(second.detail, /정확한 분리 근거/); assert.match(second.cells[4], />0</);
  assert.match(second.cells[7], /조회 완료 · 빈 응답/); assert.match(second.cells[7], /조회 오류/); assert.match(second.detail, /해당 Job 조회 오류: UPSTREAM_503/);
  assert.equal(JSON.stringify(rt.context.state.marketDiscoveryRows), before);
});
