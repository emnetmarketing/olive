const { connect, readCurrentJob } = require("./trend-analysis-cache");
const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  connect(event);
  if (event.httpMethod !== "GET") return json(405, { error: "Only GET is allowed." });
  try {
    const job = await readCurrentJob({ markStale: true });
    return json(200, job ? { running: true, job } : { running: false, job: null });
  } catch (error) {
    return json(500, { error: error.message || "Failed to read the current analysis job." });
  }
};
