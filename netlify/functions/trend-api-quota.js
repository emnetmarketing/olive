const { connectLambda, getStore } = require("@netlify/blobs");
const STORE_NAME = "trend-api-quota"; const USAGE_KEY = "usage-v1";
function connect(event) { if (event?.blobs) connectLambda(event); }
function store() { return getStore(STORE_NAME); }
function seoulParts(now = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now).reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
  return { date: `${p.year}-${p.month}-${p.day}`, month: `${p.year}-${p.month}` };
}
function limits() {
  return { searchTrend: { daily: Number(process.env.DAILY_TREND_FETCH_BUDGET || process.env.NAVER_SEARCH_TREND_DAILY_BUDGET || 300), monthly: Number(process.env.NAVER_SEARCH_TREND_MONTHLY_BUDGET || 50000) },
    shoppingInsight: { daily: Number(process.env.NAVER_SHOPPING_INSIGHT_DAILY_BUDGET || 1000), monthly: Number(process.env.NAVER_SHOPPING_INSIGHT_MONTHLY_BUDGET || 50000) } };
}
async function readUsage(now = new Date()) {
  const current = await store().get(USAGE_KEY, { type: "json" }).catch(() => null) || {}; const period = seoulParts(now);
  return { version: 1, date: period.date, month: period.month,
    daily: current.date === period.date ? current.daily || {} : {}, monthly: current.month === period.month ? current.monthly || {} : {},
    exhausted: current.date === period.date ? current.exhausted || {} : {}, updatedAt: current.updatedAt || null };
}
function statusFor(usage, type, expectedCalls = 0) {
  const limit = limits()[type]; const dailyUsed = Number(usage.daily[type] || 0); const monthlyUsed = Number(usage.monthly[type] || 0);
  const dailyRemaining = Math.max(0, limit.daily - dailyUsed); const monthlyRemaining = Math.max(0, limit.monthly - monthlyUsed);
  return { type, dailyLimit: limit.daily, monthlyLimit: limit.monthly, dailyUsed, monthlyUsed, dailyRemaining, monthlyRemaining,
    dailyKeywords: Number(usage.daily[`${type}Keywords`] || 0),
    remaining: Math.min(dailyRemaining, monthlyRemaining), expectedCalls, exhausted: Boolean(usage.exhausted[type]),
    sufficient: !usage.exhausted[type] && expectedCalls <= Math.min(dailyRemaining, monthlyRemaining) };
}
function applyUsage(usage, metricsByType) {
  for (const [type, metrics] of Object.entries(metricsByType || {})) {
    usage.daily[type] = Number(usage.daily[type] || 0) + Number(metrics.calls || 0);
    usage.monthly[type] = Number(usage.monthly[type] || 0) + Number(metrics.calls || 0);
    usage.exhausted[type] = Boolean(usage.exhausted[type] || metrics.exhausted);
    usage.daily[`${type}Retries`] = Number(usage.daily[`${type}Retries`] || 0) + Number(metrics.retries || 0);
    usage.daily[`${type}Keywords`] = Number(usage.daily[`${type}Keywords`] || 0) + Number(metrics.keywords || 0);
  }
  usage.updatedAt = new Date().toISOString(); return usage;
}
async function recordUsageBatch(metricsByType) {
  const usage = applyUsage(await readUsage(), metricsByType);
  await store().setJSON(USAGE_KEY, usage); return usage;
}
async function recordUsage(type, calls, options = {}) { return recordUsageBatch({ [type]: { calls, ...options } }); }
module.exports = { connect, readUsage, statusFor, recordUsage, recordUsageBatch, applyUsage, limits, seoulParts, USAGE_KEY };
