const { connect, readLatest } = require("./signal-snapshot-cache");
const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
exports.handler = async (event) => { connect(event); if (event.httpMethod !== "GET") return json(405, { error: "GET only" });
  const snapshot = await readLatest(); return snapshot ? json(200, snapshot) : json(404, { error: "No signal snapshot" }); };
