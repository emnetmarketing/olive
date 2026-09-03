const { run } = require("./trend-scheduled-runner");

// One recovery check at 08:00 KST. It skips without API calls when today's
// collection has completed or an analysis job already owns the atomic lock.
exports.config = { schedule: "0 23 * * *" };
exports.handler = (event) => run(event, "scheduled-recovery");
