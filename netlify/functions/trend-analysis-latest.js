const { connect, readLastSuccess } = require("./trend-analysis-cache");
const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  connect(event);
  if (event.httpMethod !== "GET") return json(405, { error: "Only GET is allowed." });
  try {
    const requestedMode = String(event.queryStringParameters?.mode || "latest");
    const mode = ["instant", "period"].includes(requestedMode) ? requestedMode : "latest";
    const job = await readLastSuccess(mode);
    if (!job) return json(404, { error: "No completed analysis result has been saved yet." });
    return json(200, job);
  } catch (error) {
    return json(500, { error: error.message || "Failed to read the last successful analysis." });
  }
};
