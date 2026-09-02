const { connect, acquireCandidateJob, writeCandidateStatus } = require("./keyword-candidate-cache");

exports.config = { schedule: "0 17 * * *" };
exports.handler = async (event) => {
  connect(event);
  let status;
  try {
    const acquired = await acquireCandidateJob();
    status = acquired.status;
    if (!acquired.acquired) return { statusCode: 200, body: "keyword candidate refresh already running" };
    const baseUrl = String(process.env.URL || "").replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/.netlify/functions/keyword-candidate-refresh-background`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: status.jobId, status }),
    });
    if (!response.ok && response.status !== 202) throw new Error(`Background Function 시작 실패: HTTP ${response.status}`);
    return { statusCode: 202, body: "keyword candidate refresh started" };
  } catch (error) {
    if (status) await writeCandidateStatus({ ...status, state: "failed", message: "자동 검색어 후보 수집 시작 실패",
      updatedAt: new Date().toISOString(), errors: [error.message] }).catch(() => {});
    return { statusCode: 500, body: "keyword candidate refresh start failed" };
  }
};
