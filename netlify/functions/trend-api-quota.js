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
  return { searchTrend: { dailyCap: Number(process.env.DAILY_TREND_FETCH_BUDGET || process.env.NAVER_SEARCH_TREND_DAILY_BUDGET || 1000),
      monthly: Number(process.env.NAVER_SEARCH_TREND_MONTHLY_BUDGET || 50000), operatingMonthly: Number(process.env.NAVER_SEARCH_TREND_OPERATING_BUDGET || 20000) },
    shoppingInsight: { dailyCap: Number(process.env.NAVER_SHOPPING_INSIGHT_DAILY_BUDGET || 500),
      monthly: Number(process.env.NAVER_SHOPPING_INSIGHT_MONTHLY_BUDGET || 50000), operatingMonthly: Number(process.env.NAVER_SHOPPING_INSIGHT_OPERATING_BUDGET || 5000) } };
}
function daysRemainingInMonth(now = new Date()) { const period = seoulParts(now); const last = new Date(Date.UTC(Number(period.month.slice(0, 4)), Number(period.month.slice(5, 7)), 0)).getUTCDate(); return Math.max(1, last - Number(period.date.slice(8, 10)) + 1); }
function dynamicDailyLimit(usage, type, now = new Date(), options = {}) {
  const limit = limits()[type]; const monthlyUsed = Number(usage.monthly[type] || 0); const dailyUsed = Number(usage.daily[type] || 0);
  // Fix the day's allocation at the amount that was available at the start of
  // the Seoul date. Recomputing it from the post-use monthly balance made the
  // displayed limit shrink below dailyUsed (for example 666 used / 644 limit).
  const operatingRemaining = Math.max(0, limit.operatingMonthly - Math.max(0, monthlyUsed - dailyUsed));
  const allocation = options.bootstrap && type === "searchTrend"
    ? operatingRemaining
    : Math.floor(operatingRemaining / daysRemainingInMonth(now));
  return Math.max(0, Math.min(limit.dailyCap, allocation));
}
async function readUsage(now = new Date()) {
  const current = await store().get(USAGE_KEY, { type: "json" }).catch(() => null) || {}; const period = seoulParts(now);
  return { version: 1, date: period.date, month: period.month,
    daily: current.date === period.date ? current.daily || {} : {}, monthly: current.month === period.month ? current.monthly || {} : {},
    exhausted: current.date === period.date ? current.exhausted || {} : {}, updatedAt: current.updatedAt || null };
}
function statusFor(usage, type, expectedCalls = 0, now = new Date(), options = {}) {
  const limit = limits()[type]; const dailyLimit = dynamicDailyLimit(usage, type, now, options); const dailyUsed = Number(usage.daily[type] || 0); const monthlyUsed = Number(usage.monthly[type] || 0);
  const dailyRemaining = Math.max(0, dailyLimit - dailyUsed); const monthlyRemaining = Math.max(0, limit.monthly - monthlyUsed);
  return { type, budgetMode: options.bootstrap && type === "searchTrend" ? "bootstrap" : "normal", dailyLimit, dailyCap: limit.dailyCap, monthlyLimit: limit.monthly, operatingMonthlyBudget: limit.operatingMonthly,
    daysRemaining: daysRemainingInMonth(now), dailyUsed, monthlyUsed, dailyRemaining, monthlyRemaining,
    dailyKeywords: Number(usage.daily[`${type}Keywords`] || 0),
    http200: Number(usage.daily[`${type}Http200`] || 0), http429: Number(usage.daily[`${type}Http429`] || 0),
    httpOther: Number(usage.daily[`${type}HttpOther`] || 0),
    monthlyHttp200: Number(usage.monthly[`${type}Http200`] || 0), monthlyHttp429: Number(usage.monthly[`${type}Http429`] || 0),
    monthlyHttpOther: Number(usage.monthly[`${type}HttpOther`] || 0),
    remaining: Math.min(dailyRemaining, monthlyRemaining), expectedCalls, exhausted: Boolean(usage.exhausted?.[type]),
    sufficient: !usage.exhausted?.[type] && expectedCalls <= Math.min(dailyRemaining, monthlyRemaining) };
}
function applyUsage(usage, metricsByType) {
  for (const [type, metrics] of Object.entries(metricsByType || {})) {
    usage.daily[type] = Number(usage.daily[type] || 0) + Number(metrics.calls || 0);
    usage.monthly[type] = Number(usage.monthly[type] || 0) + Number(metrics.calls || 0);
    usage.exhausted[type] = Boolean(usage.exhausted[type] || metrics.exhausted);
    usage.daily[`${type}Retries`] = Number(usage.daily[`${type}Retries`] || 0) + Number(metrics.retries || 0);
    usage.daily[`${type}Keywords`] = Number(usage.daily[`${type}Keywords`] || 0) + Number(metrics.keywords || 0);
    for (const code of ["Http200", "Http429", "HttpOther"]) {
      const value = Number(metrics[code.charAt(0).toLowerCase() + code.slice(1)] || 0);
      usage.daily[`${type}${code}`] = Number(usage.daily[`${type}${code}`] || 0) + value;
      usage.monthly[`${type}${code}`] = Number(usage.monthly[`${type}${code}`] || 0) + value;
    }
  }
  usage.updatedAt = new Date().toISOString(); return usage;
}
async function recordUsageBatch(metricsByType) {
  const usage = applyUsage(await readUsage(), metricsByType);
  await store().setJSON(USAGE_KEY, usage); return usage;
}
async function recordUsage(type, calls, options = {}) { return recordUsageBatch({ [type]: { calls, ...options } }); }
module.exports = { connect, readUsage, statusFor, recordUsage, recordUsageBatch, applyUsage, limits, seoulParts,
  dynamicDailyLimit, daysRemainingInMonth, USAGE_KEY };
