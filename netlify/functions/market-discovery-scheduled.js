const { acquireJob, connect, writeStatus } = require("./market-discovery-cache");

exports.config = { schedule: "0 */6 * * *" };

exports.handler = async (event) => {
  connect(event);
  let status;
  try {
    const acquired = await acquireJob();
    status = acquired.status;
    if (!acquired.acquired) return { statusCode: 200, body: "market discovery already running" };
    const baseUrl = String(process.env.URL || "").replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/.netlify/functions/market-discovery-refresh-background`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: status.jobId, status }),
    });
    if (!response.ok && response.status !== 202) throw new Error(`Background Function 시작 실패: HTTP ${response.status}`);
    return { statusCode: 202, body: "market discovery started" };
  } catch (error) {
    if (status) await writeStatus({ ...status, state: "failed", message: "자동 신규 시장 후보 수집 시작 실패",
      updatedAt: new Date().toISOString(), errors: [error.message] }).catch(() => {});
    return { statusCode: 500, body: "market discovery start failed" };
  }
};
