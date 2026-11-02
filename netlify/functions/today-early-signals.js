const early = require("./today-early-signal-cache");
const naver = require('./naver-observation-context');
const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
exports.handler = async (event) => { early.connect(event); naver.connect(event); if (event.httpMethod !== "GET") return json(405, { error: "GET 요청만 허용됩니다." });
  try { const saved = early.projectCache(await early.readCache());
    const context = await naver.loadNaverObservationContext({ keys: (saved.items || []).slice(0, 100).map(item => item.keyword) });
    const cache = naver.projectEarlyNaverStatus(saved, context); return json(200, { ok: true, jobId: cache.jobId || null, generatedAt: cache.generatedAt || null, signalDate: cache.signalDate || null,
    freshness: early.freshness(cache), refreshIntervalHours: cache.refreshIntervalHours || 6, count: (cache.items || []).length, items: (cache.items || []).slice(0, 100) }); }
  catch (error) { return json(500, { error: `오늘 급상승 신호 조회 실패: ${error.message}` }); } };
