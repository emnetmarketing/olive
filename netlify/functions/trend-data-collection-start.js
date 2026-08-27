const { handle } = require("./trend-analysis-start");

// Administrator-facing Slow Path entry point. Browser role restrictions remain
// the V1 UI policy; server role enforcement is intentionally unchanged.
exports.handler = (event) => handle(event, { fastPath: false });
