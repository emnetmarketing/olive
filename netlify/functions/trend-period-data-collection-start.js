const { handle } = require("./trend-analysis-start");

// Explicit user-authorized historical collection. It shares the analysis lock,
// quota accounting and exact-window cache with the normal Slow Path, while its
// cache records and pointers remain period-only.
exports.handler = (event) => handle(event, { fastPath: false });
