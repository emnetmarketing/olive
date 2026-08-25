const { connect, acquireJob, writeStatus } = require("./market-discovery-cache");
const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
exports.handler = async (event) => {
  connect(event); if (event.httpMethod !== "POST") return json(405, { error: "POST 요청만 허용됩니다." });
  let status;
  try {
    const acquired = await acquireJob(); status = acquired.status;
    if (!acquired.acquired) return json(409, { error: "신규 시장 후보 수집이 진행 중입니다.", status });
    const baseUrl = String(process.env.URL || "").replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/.netlify/functions/market-discovery-refresh-background`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: status.jobId, status })
    });
    if (!response.ok && response.status !== 202) throw new Error(`Background Function 시작 실패: HTTP ${response.status}`);
    return json(202, { message: "신규 시장 후보 수집을 시작했습니다.", status });
  } catch (error) {
    if (status) await writeStatus({ ...status, state: "failed", message: "신규 시장 후보 수집 시작 실패", updatedAt: new Date().toISOString(), errors: [error.message] }).catch(() => {});
    return json(500, { error: error.message || "신규 시장 후보 수집 시작 실패" });
  }
};
