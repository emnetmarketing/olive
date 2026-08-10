const { readCache, readStatus } = require("./search-ad-cache");

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

exports.handler = async () => {
  try {
    const [cache, status] = await Promise.all([readCache(), readStatus()]);
    return json(200, {
      cacheExists: Boolean(cache?.refreshedAt && Array.isArray(cache.items)),
      cache: cache ? {
        refreshedAt: cache.refreshedAt,
        uniqueProducts: cache.uniqueProducts,
        accountCounts: cache.accountCounts,
        processedAdgroups: cache.processedAdgroups,
        totalAdgroups: cache.totalAdgroups,
        totalCreatives: cache.totalCreatives,
        beforeDeduplication: cache.beforeDeduplication,
        apiCalls: cache.apiCalls,
        retries: cache.retries,
        durationMs: cache.durationMs
      } : null,
      status: status || { state: "idle", message: "상품 캐시가 없습니다." }
    });
  } catch (error) {
    return json(500, { error: `상품 캐시 상태 조회 실패: ${error.message}` });
  }
};
