const { handle } = require("./trend-analysis-start");

// Once per day. Market discovery continues independently every six hours.
exports.config = { schedule: "0 21 * * *" };
exports.handler = async (event) => {
  if (String(process.env.DISABLE_SCHEDULED_TREND_COLLECTION || "false").toLowerCase() === "true") {
    return { statusCode: 200, body: "scheduled Trend collection is explicitly disabled" };
  }
  return handle({ ...event, httpMethod: "POST", body: JSON.stringify({ mode: "instant" }) }, { fastPath: false });
};
