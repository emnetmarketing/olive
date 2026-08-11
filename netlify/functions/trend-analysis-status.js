const { connect, readJob } = require("./trend-analysis-cache");
const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
exports.handler = async (event) => {
  connect(event);
  const jobId = String(event.queryStringParameters?.jobId || "");
  if (!jobId) return json(400, { error: "jobId가 필요합니다." });
  const job = await readJob(jobId);
  return job ? json(200, job) : json(404, { error: "분석 작업을 찾을 수 없습니다." });
};
