const { acquireJob, connect, writeStatus } = require("./search-ad-cache");

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  connect(event);
  if (event.httpMethod !== "POST") return json(405, { error: "POST 요청만 허용됩니다." });
  let acquiredStatus = null;
  try {
    const result = await acquireJob();
    if (!result.acquired) return json(409, { error: "현재 상품 동기화가 진행 중입니다.", status: result.status });
    acquiredStatus = result.status;
    const baseUrl = String(process.env.URL || "").replace(/\/$/, "");
    if (!baseUrl) throw new Error("Netlify URL 환경변수를 확인할 수 없습니다.");
    const response = await fetch(`${baseUrl}/.netlify/functions/search-ad-refresh-background`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: result.status.jobId })
    });
    if (!response.ok && response.status !== 202) throw new Error(`Background Function 시작 실패: HTTP ${response.status}`);
    return json(202, { message: "Search Ad 상품 동기화를 시작했습니다.", status: result.status });
  } catch (error) {
    if (acquiredStatus) {
      const failedAt = new Date().toISOString();
      await writeStatus({ ...acquiredStatus, state: "failed", message: "Search Ad 상품 동기화 시작 실패", failedAt, updatedAt: failedAt, errors: [error.message] }).catch(() => {});
    }
    return json(500, { error: error.message || "상품 동기화를 시작하지 못했습니다." });
  }
};
