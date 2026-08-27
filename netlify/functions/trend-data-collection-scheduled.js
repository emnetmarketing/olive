const { handle } = require("./trend-analysis-start");

// Once per day. Market discovery continues independently every six hours.
exports.config = { schedule: "0 21 * * *" };
exports.handler = async (event) => {
  if (String(process.env.ENABLE_SCHEDULED_TREND_COLLECTION || "").toLowerCase() !== "true") {
    return { statusCode: 200, body: "scheduled Trend collection is paused until explicitly enabled" };
  }
  return handle({ ...event, httpMethod: "POST", body: JSON.stringify({ mode: "instant" }) }, { fastPath: false });
};
