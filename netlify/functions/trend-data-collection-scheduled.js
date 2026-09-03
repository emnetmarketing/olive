const { run } = require("./trend-scheduled-runner");

// Once per day. Market discovery continues independently every six hours.
// DISABLE_SCHEDULED_TREND_COLLECTION is enforced by the shared runner so the
// primary and recovery entries cannot diverge.
exports.config = { schedule: "0 21 * * *" };
exports.handler = (event) => run(event, "scheduled-primary");
