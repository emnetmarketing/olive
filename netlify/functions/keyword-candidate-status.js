const { connect, readCandidateCache, readCandidateStatus } = require("./keyword-candidate-cache");
const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  connect(event);
  try {
    const [cache, status] = await Promise.all([readCandidateCache({ summaryOnly: true }), readCandidateStatus()]);
    return json(200, {
      cacheExists: Boolean(cache?.refreshedAt && Array.isArray(cache.candidates)),
      cache: cache ? {
        refreshedAt: cache.refreshedAt, candidateCount: cache.candidateCount,
        actualQueryCount: cache.actualQueryCount, keywordToolCount: cache.keywordToolCount,
        categoryCounts: cache.categoryCounts, monthlyVolumeCounts: cache.monthlyVolumeCounts,
        seedCount: cache.seedCount, apiCalls: cache.apiCalls, retries: cache.retries, durationMs: cache.durationMs
      } : null,
      status: status || { state: "idle", message: "검색어 후보 캐시가 없습니다." }
    });
  } catch (error) { return json(500, { error: `검색어 후보 상태 조회 실패: ${error.message}` }); }
};
