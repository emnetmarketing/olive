(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./kst-time-presentation"));
  else root.NaverStatusPresentation = factory(root.KstTimePresentation);
})(typeof globalThis !== "undefined" ? globalThis : this, function (time) {
  "use strict";
  const unknown = "상태 확인 불가";
  const dataLabels = { "target-observed": "검색 추이 데이터 있음 · 목표일 관측 있음",
    "cached-before-target": "검색 추이 데이터 있음 · 목표일 미확인", empty: "조회 완료 · 데이터 없음",
    "window-unavailable": "분석 기간 데이터 부족", missing: "데이터 미확보", unknown, invalid: "저장 자료 유효성 확인 불가" };
  const selectionLabels = { selected: "분석 대상 선정", "not-selected": "해당 분석 Job 대상 아님", unknown: "실제 분석 대상 선정 여부 확인 불가" };
  const collectionLabels = { running: "수집 중", queued: "수집 대기", processed: "저장된 조회 처리 기록 있음",
    "waiting-target-date": "표본에서 목표일 미확인 · 재확인 상태는 Job 기록 참조", "not-queued": "수집 예약 기록 없음",
    interrupted: "수집 중단 기록", "budget-held": "해당 작업 예산 제한 · 현재 잔여 예산 확인 불가", "budget-exhausted": "해당 작업 예산 제한 · 현재 잔여 예산 확인 불가", unknown };
  function discoveryView(item = {}) {
    const status = item.naverStatus || {}, data = status.data || {}, selection = status.selection || {}, collection = status.collection || {}, assessment = status.assessment || {};
    const priority = item.selectedForProtectedSlot === true
      ? `우선 검증 추천${item.protectedSlotRank ? ` #${Number(item.protectedSlotRank)}` : ""} · 실제 Job 선정과 별도`
      : item.selectedForProtectedSlot === false ? "우선 검증 대상 미선정" : "우선 검증 추천 여부 확인 불가";
    const selectedLabel = selectionLabels[selection.state] || selectionLabels.unknown;
    return { priority, selection: selectedLabel,
      data: data.state === "missing" && selection.state === "selected" ? "분석 대상 선정 · 데이터 미확보" : data.label || dataLabels[data.state] || unknown,
      collection: collection.label || collectionLabels[collection.state] || unknown,
      assessment: assessment.label || "급등 판정 기록 확인 불가",
      dates: `데이터 기준일: ${time.formatDateOnly(data.actualDataDate, "확인 불가")} · 마지막 수집 (한국시간(KST)): ${time.formatKstTimestamp(data.fetchedAt, "기록 없음")}`,
      job: `기준 Instant Job: ${status.jobId || "확인 불가"} · 목표일: ${time.formatDateOnly(status.targetDataDate, "확인 불가")} · 필요 분석 기간: ${status.requiredWindow || "확인 불가"}`,
      note: "최근 24시간 등 발견 필터는 키워드 발견 시점 기준이며 NAVER 분석 기간·데이터 최신성을 뜻하지 않습니다." };
  }
  function previousDayView(item = {}) {
    const status = item.previousDayNaverStatus;
    if (!status) return "전일 NAVER 상태 확인 불가 · 해당 날짜의 조회·분석 기록 부족";
    const date = time.formatDateOnly(status.targetDataDate, "확인 불가"), data = status.data || {}, assessment = status.assessment || {};
    let label = assessment.label || "급등 판정 기록 확인 불가";
    if (!['surge-confirmed', 'not-surged', 'criteria-not-met'].includes(assessment.state)) {
      label = data.label || dataLabels[data.state] || unknown;
      label += ` · ${assessment.label || "해당 날짜 급등 판정 미확인"}`;
    }
    return `확인 대상일 ${date} · ${label} · 데이터 기준일 ${time.formatDateOnly(data.actualDataDate, "확인 불가")}`;
  }
  function periodView(job = {}) {
    job = job || {};
    const first = job.actualDataStartDate || job.sourceFreshness?.actualStartDate || null;
    const last = job.actualDataEndDate || job.sourceFreshness?.actualDataDate || null;
    return { title: "저장된 과거 기간 결과", requested: `요청 기간 ${time.formatDateOnly(job.startDate, "확인 불가")} ~ ${time.formatDateOnly(job.endDate, "확인 불가")}`,
      actual: `실제 확보 기간 ${time.formatDateOnly(first, "확인 불가")} ~ ${time.formatDateOnly(last, "확인 불가")}`,
      note: `Job ${job.jobId || "확인 불가"} · 저장 결과 ${(job.results || []).length}건 · 현재 최신 결과와 별도. 캐시 확보율은 요청 종료일까지의 데이터 완전성을 뜻하지 않습니다.` };
  }
  return { discoveryView, previousDayView, periodView };
});
