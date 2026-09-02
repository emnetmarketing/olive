const early = require("./today-early-signal-cache");
const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
exports.handler = async (event) => { early.connect(event); if (event.httpMethod !== "GET") return json(405, { error: "GET 요청만 허용됩니다." });
  try { const cache = await early.readCache(); return json(200, { ok: true, generatedAt: cache.generatedAt || null, signalDate: cache.signalDate || early.kstDate(),
    refreshIntervalHours: cache.refreshIntervalHours || 6, count: (cache.items || []).length, items: (cache.items || []).slice(0, 100) }); }
  catch (error) { return json(500, { error: `오늘 급상승 신호 조회 실패: ${error.message}` }); } };
