const { connect, readHistory, appendHistory } = require("./download-history-cache");
const { readJob } = require("./trend-analysis-cache");
const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
const compactDate = (value) => String(value || "").replaceAll("-", "");
function filenameFor(job) {
  if (job.mode === "instant") return `monitoring-result-instant-${compactDate(job.latestDataDate)}.xls`;
  return `monitoring-result-${compactDate(job.startDate)}-${compactDate(job.endDate)}.xls`;
}
exports.handler = async (event) => {
  connect(event);
  try {
    if (event.httpMethod === "GET") return json(200, { items: await readHistory() });
    if (event.httpMethod !== "POST") return json(405, { error: "GET/POST only." });
    const input = JSON.parse(event.body || "{}");
    const sourceJobId = String(input.sourceJobId || "");
    const job = await readJob(sourceJobId);
    if (!job || job.state !== "completed") return json(409, { error: "완료된 분석 Job만 다운로드 이력에 등록할 수 있습니다." });
    const item = await appendHistory({
      mode: job.mode, startDate: job.startDate || null, endDate: job.endDate || null,
      latestDataDate: job.latestDataDate || null, sourceJobId: job.jobId,
      downloadedAt: new Date().toISOString(), filename: filenameFor(job), resultCount: Number(job.resultCount || job.results?.length || 0)
    });
    return json(201, item);
  } catch (error) {
    return json(500, { error: error.message || "다운로드 이력 처리 실패" });
  }
};
exports._test = { filenameFor };
