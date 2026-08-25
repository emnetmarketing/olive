const { connect, readCache, readStatus } = require("./market-discovery-cache");
const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
exports.handler = async (event) => {
  connect(event);
  try {
    const [cache, status] = await Promise.all([readCache(), readStatus()]);
    return json(200, { cacheExists: Boolean(cache?.refreshedAt), cache: cache ? { refreshedAt: cache.refreshedAt, candidateCount: cache.items?.length || 0,
      sourceCounts: cache.sourceCounts, monthlyVolumeCounts: cache.monthlyVolumeCounts, ratioOnlyCandidateCount: cache.ratioOnlyCandidateCount,
      productBackfill: cache.productBackfill, youtube: cache.youtube } : null, status: status || { state: "idle", message: "신규 시장 후보 캐시가 없습니다." } });
  } catch (error) { return json(500, { error: `신규 시장 후보 상태 조회 실패: ${error.message}` }); }
};
