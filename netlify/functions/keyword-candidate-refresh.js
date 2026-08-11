const { connect, acquireCandidateJob, writeCandidateStatus } = require("./keyword-candidate-cache");

const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  connect(event);
  if (event.httpMethod !== "POST") return json(405, { error: "POST 요청만 허용됩니다." });
  let acquired;
  try {
    const result = await acquireCandidateJob();
    if (!result.acquired) return json(409, { error: "현재 검색어 후보 동기화가 진행 중입니다.", status: result.status });
    acquired = result.status;
    const baseUrl = String(process.env.URL || "").replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/.netlify/functions/keyword-candidate-refresh-background`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: acquired.jobId, status: acquired })
    });
    if (!response.ok && response.status !== 202) throw new Error(`Background Function 시작 실패: HTTP ${response.status}`);
    return json(202, { message: "검색어 후보 새로고침을 시작했습니다.", status: acquired });
  } catch (error) {
    if (acquired) {
      const now = new Date().toISOString();
      await writeCandidateStatus({ ...acquired, state: "failed", message: "검색어 후보 새로고침 시작 실패", updatedAt: now, errors: [error.message] }).catch(() => {});
    }
    return json(500, { error: error.message || "검색어 후보 새로고침 시작 실패" });
  }
};
