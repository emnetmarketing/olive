const { connectLambda, getCompatibleStore } = require("./blob-store-compat");
const STORE_NAME = "trend-api-quota"; const USAGE_KEY = "usage-v1";
function connect(event) { if (event?.blobs) connectLambda(event); }
function store() { return getCompatibleStore({ name: STORE_NAME, consistency: "strong" }); }
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
function historicalRemaining(usage, now = new Date()) {
  const limit = limits().searchTrend;
  const monthlyUsed = Number(usage.monthly.searchTrend || 0);
  const historicalUsed = Number(usage.monthly.searchTrendHistorical || 0);
  const automaticUsed = Math.max(0, monthlyUsed - historicalUsed);
  const projectedAutomaticUsage = Math.max(0, limit.operatingMonthly - automaticUsed);
  // Preserve the pre-existing effective reserve: the official monthly limit,
  // less the automatic operating target and the former 2,000-call historical
  // envelope. Historical work may use only the remainder after that reserve
  // and all projected automatic collection have been protected.
  const formerHistoricalEnvelope = Math.max(0, Number(process.env.NAVER_HISTORICAL_TREND_MONTHLY_BUDGET || 2000));
  const defaultSafetyReserve = Math.max(0, limit.monthly - limit.operatingMonthly - formerHistoricalEnvelope);
  const safetyReserve = Math.max(0, Number(process.env.NAVER_SEARCH_TREND_SAFETY_RESERVE || defaultSafetyReserve));
  const officialRemaining = Math.max(0, limit.monthly - monthlyUsed);
  const uncertainUsageReserve = Math.max(0, Number(usage.monthly.searchTrendHistoricalUncertainReserve || 0));
  const remaining = Math.max(0, officialRemaining - projectedAutomaticUsage - safetyReserve - uncertainUsageReserve);
  return { budgetMode: "dynamic-monthly", officialMonthlyLimit: limit.monthly, officialRemaining,
    automaticOperatingTarget: limit.operatingMonthly, automaticUsed, projectedAutomaticUsage,
    safetyReserve, uncertainUsageReserve, historicalUsed, remaining, daysRemaining: daysRemainingInMonth(now) };
}
function daysRemainingInMonth(now = new Date()) { const period = seoulParts(now); const last = new Date(Date.UTC(Number(period.month.slice(0, 4)), Number(period.month.slice(5, 7)), 0)).getUTCDate(); return Math.max(1, last - Number(period.date.slice(8, 10)) + 1); }
function dynamicDailyLimit(usage, type, now = new Date(), options = {}) {
  const limit = limits()[type]; const monthlyUsed = Number(usage.monthly[type] || 0); const dailyUsed = Number(usage.daily[type] || 0);
  const operatingMonthlyUsed = type === "searchTrend" ? Math.max(0, monthlyUsed - Number(usage.monthly.searchTrendHistorical || 0)) : monthlyUsed;
  // Fix the day's allocation at the amount that was available at the start of
  // the Seoul date. Recomputing it from the post-use monthly balance made the
  // displayed limit shrink below dailyUsed (for example 666 used / 644 limit).
  const operatingDailyUsed = type === "searchTrend" ? Math.max(0, dailyUsed - Number(usage.daily.searchTrendHistorical || 0)) : dailyUsed;
  const operatingRemaining = Math.max(0, limit.operatingMonthly - Math.max(0, operatingMonthlyUsed - operatingDailyUsed));
  const allocation = options.bootstrap && type === "searchTrend"
    ? operatingRemaining
    : Math.floor(operatingRemaining / daysRemainingInMonth(now));
  return Math.max(0, Math.min(limit.dailyCap, allocation));
}
function normalizeUsage(current = {}, now = new Date()) {
  const period = seoulParts(now);
  return { ...current, version: 1, date: period.date, month: period.month,
    daily: current.date === period.date ? current.daily || {} : {}, monthly: current.month === period.month ? current.monthly || {} : {},
    exhausted: current.date === period.date ? current.exhausted || {} : {}, updatedAt: current.updatedAt || null,
    invocations: current.month === period.month ? current.invocations || {} : {},
    jobs: current.month === period.month ? current.jobs || {} : {} };
}
async function readUsage(now = new Date(), options = {}) {
  const current = await (options.store || store()).get(USAGE_KEY, { type: "json" }) || {};
  return normalizeUsage(current, now);
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
    if (type === "searchTrend" && Number(metrics.historicalCalls || 0) > 0) {
      usage.daily.searchTrendHistorical = Number(usage.daily.searchTrendHistorical || 0) + Number(metrics.historicalCalls);
      usage.monthly.searchTrendHistorical = Number(usage.monthly.searchTrendHistorical || 0) + Number(metrics.historicalCalls);
    }
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
const METRIC_KEYS = ["calls", "retries", "keywords", "http200", "http429", "httpOther", "historicalCalls"];
function cumulativeDelta(current = {}, previous = {}) {
  return Object.fromEntries(Object.entries(current).map(([type, metrics]) => [type, {
    ...Object.fromEntries(METRIC_KEYS.map(key => [key, Math.max(0, Number(metrics[key] || 0) - Number(previous[type]?.[key] || 0))])),
    exhausted: Boolean(metrics.exhausted),
  }]));
}
function addMetrics(target = {}, delta = {}) {
  for (const [type, metrics] of Object.entries(delta)) {
    target[type] ||= {};
    for (const key of METRIC_KEYS) target[type][key] = Number(target[type][key] || 0) + Number(metrics[key] || 0);
    target[type].exhausted = Boolean(target[type].exhausted || metrics.exhausted);
  }
  return target;
}
async function recordUsageBatch(metricsByType, options = {}) {
  const blobStore = options.store || store(); const now = options.now || new Date();
  for (let attempt = 0; attempt < 12; attempt++) {
    const entry = await blobStore.getWithMetadata(USAGE_KEY, { type: "json" });
    const usage = normalizeUsage(entry?.data || {}, now);
    const previous = options.cumulative ? usage.invocations[options.invocationId] : null;
    if (options.cumulative && (!options.invocationId || !options.jobId)) throw new Error("Cumulative quota usage requires Job and invocation IDs.");
    if (previous && previous.jobId !== options.jobId) throw new Error("Quota invocation identity mismatch.");
    const delta = options.cumulative ? cumulativeDelta(metricsByType, previous?.metricsByType) : metricsByType;
    if (options.enforceBudget) for (const [type, metrics] of Object.entries(delta)) {
      if (!limits()[type] || Number(metrics.calls || 0) <= 0) continue;
      const historical = type === "searchTrend" && options.enforceBudget.historical;
      const available = historical ? historicalRemaining(usage, now).remaining
        : statusFor(usage, type, 0, now, { bootstrap: Boolean(options.enforceBudget.bootstrap) }).remaining;
      if (usage.exhausted[type] || Number(metrics.calls) > available)
        throw Object.assign(new Error("Provider request blocked before dispatch by the current safe budget."),
          { code: "QUOTA_BUDGET_EXHAUSTED", type, available });
    }
    applyUsage(usage, delta);
    if (options.cumulative) {
      const metrics = structuredClone(previous?.metricsByType || {});
      addMetrics(metrics, delta);
      usage.invocations[options.invocationId] = { jobId: options.jobId, source: options.source || "automatic",
        metricsByType: metrics, updatedAt: usage.updatedAt };
      const jobUsage = usage.jobs[options.jobId] ||= { source: options.source || "automatic",
        // Legacy saved Job totals are a known lower bound, not a fabricated
        // correction to the provider/monthly quota. Seed this audit total once.
        metricsByType: addMetrics({}, options.jobBaseline || {}), baselineSource: "saved-job" };
      addMetrics(jobUsage.metricsByType, delta); jobUsage.updatedAt = usage.updatedAt;
    }
    const written = await blobStore.setJSON(USAGE_KEY, usage, entry?.etag ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
    if (written?.modified) return usage;
  }
  throw Object.assign(new Error("Quota usage changed concurrently; provider work must stop."), { code: "QUOTA_WRITE_CONFLICT" });
}
async function recordUsage(type, calls, options = {}) { return recordUsageBatch({ [type]: { calls, ...options } }); }
async function reserveUncertainHistoricalUsage(calls) {
  const blobStore = store();
  for (let attempt = 0; attempt < 12; attempt++) {
    const entry = await blobStore.getWithMetadata(USAGE_KEY, { type: "json" });
    const usage = normalizeUsage(entry?.data || {});
    usage.monthly.searchTrendHistoricalUncertainReserve = Number(usage.monthly.searchTrendHistoricalUncertainReserve || 0)
      + Math.max(0, Number(calls || 0));
    usage.updatedAt = new Date().toISOString();
    if ((await blobStore.setJSON(USAGE_KEY, usage, entry?.etag ? { onlyIfMatch: entry.etag } : { onlyIfNew: true }))?.modified) return usage;
  }
  throw Object.assign(new Error("Historical reserve changed concurrently."), { code: "QUOTA_WRITE_CONFLICT" });
}
module.exports = { connect, readUsage, statusFor, recordUsage, recordUsageBatch, applyUsage, limits, seoulParts,
  dynamicDailyLimit, daysRemainingInMonth, historicalRemaining, reserveUncertainHistoricalUsage, USAGE_KEY, normalizeUsage, cumulativeDelta };
