const { connect, acquireJob, writeJob, readJob } = require("./trend-analysis-cache");
const { connect: connectSnapshot, readLatest: readLatestSnapshot } = require("./signal-snapshot-cache");
const { readCandidateCache } = require("./keyword-candidate-cache");
const { readCache: readProductCache } = require("./search-ad-cache");
const { readOperatingSettings } = require("./operating-settings-cache");
const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) });

function isoDate(date) { return date.toISOString().slice(0, 10); }
function seoulDate() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function inclusiveDays(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`); const end = new Date(`${endDate}T00:00:00Z`);
  return Math.round((end - start) / 86400000) + 1;
}
function analysisQueryStart(mode, start, end) {
  const queryStart = new Date(end); queryStart.setUTCDate(end.getUTCDate() - 30);
  if (mode === "period") {
    const baselineStart = new Date(start); baselineStart.setUTCDate(start.getUTCDate() - 7);
    if (baselineStart < queryStart) queryStart.setTime(baselineStart.getTime());
  }
  return queryStart;
}

async function handle(event, { fastPath = true } = {}) {
  connect(event); connectSnapshot(event);
  if (event.httpMethod !== "POST") return json(405, { error: "POST 요청만 허용됩니다." });
  let createdJob;
  try {
    const input = JSON.parse(event.body || "{}");
    const mode = input.mode === "instant" ? "instant" : "period";
    const { surgeThreshold, matchThreshold } = await readOperatingSettings();
    let startDate = String(input.startDate || "");
    let endDate = String(input.endDate || "");
    if (mode === "instant") {
      const end = new Date(`${seoulDate()}T00:00:00Z`);
      const start = new Date(end); start.setDate(end.getDate() - 29);
      startDate = isoDate(start); endDate = isoDate(end);
    }
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    const days = inclusiveDays(startDate, endDate);
    if (!Number.isFinite(days) || days < 1 || days > 31) return json(400, { error: "분석 기간은 1~31일이어야 합니다." });
    const queryStart = analysisQueryStart(mode, start, end);
    if (fastPath) {
      const snapshot = await readLatestSnapshot(mode).catch(() => null);
      if (snapshot?.jobId && snapshot.mode === mode && snapshot.startDate === startDate && snapshot.endDate === endDate
        && Number(snapshot.surgeThreshold) === Number(surgeThreshold) && Number(snapshot.matchThreshold) === Number(matchThreshold)) {
        const snapshotJob = await readJob(snapshot.jobId).catch(() => null);
        if (snapshotJob?.state === "completed") return json(200, { jobId: snapshotJob.jobId, existing: false, fastPath: true,
          cachedSnapshot: true, message: "동일 조건의 최신 signal snapshot을 즉시 사용합니다." });
      }
    }
    const [candidateCache, productCache] = await Promise.all([readCandidateCache(), readProductCache()]);
    if (!candidateCache?.candidates?.length) return json(409, { error: "검색어 후보 데이터가 없습니다. 먼저 '검색어 후보 새로고침'을 실행해주세요." });
    if (!productCache?.items?.length) return json(409, { error: "Search Ad 전체 상품 데이터가 없습니다. 먼저 'Search Ad 상품 새로고침'을 실행해주세요." });
    const triggerSource = String(input.triggerSource || (fastPath ? "user-fast-path" : "admin-manual"));
    const schedulerExecutionId = input.schedulerExecutionId ? String(input.schedulerExecutionId) : null;
    const historicalCollection = mode === "period" && !fastPath;
    const acquired = await acquireJob({ mode, startDate, endDate, queryStartDate: isoDate(queryStart), surgeThreshold, matchThreshold, fastPath,
      triggerSource, schedulerExecutionId, historicalCollection,
      currentStage: "preparing", processedCount: 0, totalCount: 0 });
    const job = acquired.job;
    createdJob = job;
    if (acquired.existing) return json(200, { jobId: job.jobId, existing: true, fastPath: Boolean(job.fastPath),
      message: "현재 Background 작업이 실행 중입니다. 최신 저장 결과를 표시하고 기존 진행 상태에 연결합니다." });
    const baseUrl = String(process.env.URL || "").replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/.netlify/functions/trend-analysis-background`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: job.jobId, job })
    });
    if (!response.ok && response.status !== 202) throw new Error(`분석 Background Function 시작 실패: HTTP ${response.status}`);
    return json(202, { jobId: job.jobId, existing: false, fastPath,
      message: fastPath ? "저장된 최신 데이터로 분석을 시작했습니다." : "최신 데이터 Background 수집을 시작했습니다." });
  } catch (error) {
    if (createdJob) await writeJob(createdJob.jobId, { ...createdJob, state: "failed", message: "분석 시작 실패", errors: [error.message], updatedAt: new Date().toISOString() }).catch(() => {});
    return json(500, { error: error.message || "분석 시작 실패" });
  }
}
exports.handler = (event) => handle(event, { fastPath: true });
exports.handle = handle;
exports._test = { inclusiveDays, analysisQueryStart, isoDate };
