const { connect, readCache } = require("./trend-series-cache");
const { connect: connectQuota, readUsage, statusFor } = require("./trend-api-quota");

exports.handler = async (event) => {
  connect(event); connectQuota(event);
  if (event.httpMethod !== "GET") return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  try {
    const [cache, usage] = await Promise.all([readCache(), readUsage()]);
    return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify({
      ok: true,
      cache: { ...(cache.manifest || {}), loadedEntryCount: cache.entries.size },
      quota: { searchTrend: statusFor(usage, "searchTrend"), shoppingInsight: statusFor(usage, "shoppingInsight"), updatedAt: usage.updatedAt },
    }) };
  } catch (error) {
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: error.message }) };
  }
};
