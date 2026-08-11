const { connect, createJob, writeJob } = require("./trend-analysis-cache");
const { readCandidateCache } = require("./keyword-candidate-cache");
const { readCache: readProductCache } = require("./search-ad-cache");
const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) });

function isoDate(date) { return date.toISOString().slice(0, 10); }
function seoulDate() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

exports.handler = async (event) => {
  connect(event);
  if (event.httpMethod !== "POST") return json(405, { error: "POST 요청만 허용됩니다." });
  let createdJob;
  try {
    const input = JSON.parse(event.body || "{}");
    const mode = input.mode === "instant" ? "instant" : "period";
    const surgeThreshold = Number(input.surgeThreshold);
    const matchThreshold = Number(input.matchThreshold);
    if (!Number.isInteger(surgeThreshold) || surgeThreshold < 1 || surgeThreshold > 10000000) return json(400, { error: "급등수 기준은 1~10,000,000 사이의 정수여야 합니다." });
    if (!Number.isFinite(matchThreshold) || matchThreshold < 1 || matchThreshold > 100) return json(400, { error: "상품 일치율은 1~100 사이여야 합니다." });
    let startDate = String(input.startDate || "");
    let endDate = String(input.endDate || "");
    if (mode === "instant") {
      const end = new Date(`${seoulDate()}T00:00:00Z`);
      const start = new Date(end); start.setDate(end.getDate() - 29);
      startDate = isoDate(start); endDate = isoDate(end);
    }
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    const days = Math.round((end - start) / 86400000) + 1;
    if (!Number.isFinite(days) || days < 3 || days > 30) return json(400, { error: "분석 기간은 3~30일이어야 합니다." });
    const queryStart = new Date(end); queryStart.setUTCDate(end.getUTCDate() - 30);
    const [candidateCache, productCache] = await Promise.all([readCandidateCache(), readProductCache()]);
    if (!candidateCache?.candidates?.length) return json(409, { error: "검색어 후보 데이터가 없습니다. 먼저 '검색어 후보 새로고침'을 실행해주세요." });
    if (!productCache?.items?.length) return json(409, { error: "Search Ad 전체 상품 데이터가 없습니다. 먼저 'Search Ad 상품 새로고침'을 실행해주세요." });
    const job = await createJob({ mode, startDate, endDate, queryStartDate: isoDate(queryStart), surgeThreshold, matchThreshold });
    createdJob = job;
    const baseUrl = String(process.env.URL || "").replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/.netlify/functions/trend-analysis-background`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: job.jobId, job })
    });
    if (!response.ok && response.status !== 202) throw new Error(`분석 Background Function 시작 실패: HTTP ${response.status}`);
    return json(202, { jobId: job.jobId, message: mode === "instant" ? "즉시 분석을 시작했습니다." : "기간 분석을 시작했습니다." });
  } catch (error) {
    if (createdJob) await writeJob(createdJob.jobId, { ...createdJob, state: "failed", message: "분석 시작 실패", errors: [error.message], updatedAt: new Date().toISOString() }).catch(() => {});
    return json(500, { error: error.message || "분석 시작 실패" });
  }
};
