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
const EMERGENCY_BINDING_KEYS = ["jobId", "mode", "collectionScope", "targetDataDate", "createdAt", "startDate", "endDate", "queryStartDate", "surgeThreshold", "matchThreshold"];
const EMERGENCY_TERMINAL_STATES = new Set(["completed", "failed", "interrupted", "cancelled", "canceled", "publication_failed"]);
function emergencyError(code, message) { return Object.assign(new Error(message), { code }); }
function emergencyBinding(job = {}) {
  return Object.fromEntries(EMERGENCY_BINDING_KEYS.map(key => [key, job[key] ?? null]));
}
function safeCount(value) { return Number.isSafeInteger(value) && value >= 0; }
function validEmergencyJob(job = {}) {
  return typeof job.jobId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(job.jobId)
    && job.mode === "instant" && job.collectionScope === "search-trend-only"
    && job.fastPath !== true && job.historicalCollection !== true
    && /^\d{4}-\d{2}-\d{2}$/.test(job.targetDataDate || "");
}
// An operator provisions this record directly; no HTTP request can create a
// grant. It is not a replacement for the default or Historical quota policy.
function emergencyStatus(usage, job, now = new Date()) {
  const grant = usage.emergencyInstantGrants?.[job?.jobId];
  const denied = reason => ({ exists: Boolean(grant), eligible: false, remaining: 0, reason,
    jobId: job?.jobId || null, used: Number(grant?.used || 0), maxAttempts: Number(grant?.maxAttempts || 0) });
  if (!grant) return denied("grant-not-found");
  if (!validEmergencyJob(job) || JSON.stringify(grant.jobBinding) !== JSON.stringify(emergencyBinding(job))) return denied("job-binding-mismatch");
  const period = seoulParts(now);
  if (grant.month !== period.month || usage.month !== period.month || grant.date !== period.date) return denied("grant-period-mismatch");
  if (grant.state !== "active") return denied("grant-closed");
  if (EMERGENCY_TERMINAL_STATES.has(job.state)) return denied("job-terminal");
  if (!Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now.getTime()) return denied("grant-expired");
  if (usage.exhausted?.searchTrend) return denied("provider-exhausted");
  const observation = grant.officialObservation || {};
  const monthlyUsed = Number(usage.monthly?.searchTrend || 0);
  const currentUncertain = Number(usage.monthly?.searchTrendHistoricalUncertainReserve || 0);
  if (!safeCount(monthlyUsed) || !safeCount(observation.internalMonthlyBaseline) || monthlyUsed < observation.internalMonthlyBaseline
    || observation.month !== period.month || !safeCount(observation.remaining) || !safeCount(observation.monthlyLimit)
    || !safeCount(observation.used) || observation.monthlyLimit - observation.used !== observation.remaining
    || !safeCount(grant.used) || !safeCount(grant.maxAttempts) || !safeCount(currentUncertain)
    || grant.maxAttempts < 1 || grant.maxAttempts > 1000 || !safeCount(grant.automaticReserve) || !safeCount(grant.safetyReserve)
    || grant.safetyReserve < 12000 || !safeCount(grant.uncertainReserve)) return denied("grant-accounting-invalid");
  const internalUsageSinceObservation = monthlyUsed - observation.internalMonthlyBaseline;
  const officialRemainingAdjusted = Math.max(0, observation.remaining - internalUsageSinceObservation);
  const automaticReserve = Math.max(grant.automaticReserve, historicalRemaining(usage, now).projectedAutomaticUsage);
  // A reserve is a single risk allowance, not another attempted-call counter.
  // Never add the same allowance both at observation time and at request time.
  const uncertainReserve = Math.max(grant.uncertainReserve, currentUncertain);
  const safeAvailable = Math.max(0, officialRemainingAdjusted - automaticReserve - grant.safetyReserve - uncertainReserve);
  const remaining = Math.max(0, Math.min(grant.maxAttempts - grant.used, safeAvailable,
    limits().searchTrend.monthly - monthlyUsed));
  return { exists: true, eligible: true, budgetMode: "job-one-off", jobId: job.jobId,
    remaining, used: grant.used, maxAttempts: grant.maxAttempts, expiresAt: grant.expiresAt,
    officialRemainingAdjusted, internalUsageSinceObservation, automaticReserve,
    safetyReserve: grant.safetyReserve, uncertainReserve, reason: remaining ? null : "emergency-budget-exhausted" };
}
async function provisionEmergencyGrant(job, approval, options = {}) {
  const now = options.now || new Date(), period = seoulParts(now), observation = approval?.officialObservation || {};
  const exactValue = Object.hasOwn(observation, "exactObservedAt") ? observation.exactObservedAt : observation.observedAt ?? null;
  const observed = exactValue === null ? null : Date.parse(exactValue);
  const observedDateKST = observation.observedDateKST || (Number.isFinite(observed) ? seoulParts(new Date(observed)).date : null);
  const recorded = observation.recordedAt == null ? now.getTime() : Date.parse(observation.recordedAt);
  const expires = Date.parse(approval?.expiresAt);
  const midnight = Date.parse(`${period.date}T00:00:00+09:00`) + 86400000;
  if (!validEmergencyJob(job) || EMERGENCY_TERMINAL_STATES.has(job.state) || job.targetDataDate >= period.date
    || !safeCount(approval?.maxAttempts) || approval.maxAttempts < 1 || approval.maxAttempts > 1000
    || !Number.isFinite(expires) || expires <= now.getTime() || expires > midnight
    || observedDateKST !== period.date
    || (exactValue !== null && (!Number.isFinite(observed) || observed > now.getTime() || seoulParts(new Date(observed)).date !== observedDateKST))
    || (observation.observedAt != null && Date.parse(observation.observedAt) !== observed)
    || !Number.isFinite(recorded) || recorded > now.getTime() || seoulParts(new Date(recorded)).date !== period.date
    || (observed !== null && recorded < observed)
    || observation.month !== period.month || !safeCount(observation.monthlyLimit) || !safeCount(observation.used)
    || !safeCount(observation.remaining) || observation.monthlyLimit - observation.used !== observation.remaining
    || !safeCount(observation.internalMonthlyBaseline) || observation.used < observation.internalMonthlyBaseline
    || !safeCount(approval.automaticReserve) || !safeCount(approval.safetyReserve) || approval.safetyReserve < 12000)
    throw emergencyError("EMERGENCY_GRANT_INVALID", "Invalid operator-only one-off quota approval.");
  const blobStore = options.store || store();
  for (let attempt = 0; attempt < 12; attempt++) {
    const entry = await blobStore.getWithMetadata(USAGE_KEY, { type: "json" });
    const usage = normalizeUsage(entry?.data || {}, now);
    if (Number(usage.monthly.searchTrend || 0) < observation.internalMonthlyBaseline
      || approval.automaticReserve < historicalRemaining(usage, now).projectedAutomaticUsage)
      throw emergencyError("EMERGENCY_GRANT_BASELINE", "The observation baseline or automatic reserve is not compatible with current accounting.");
    const prior = usage.emergencyInstantGrants?.[job.jobId];
    const exactObservedAt = observed === null ? null : new Date(observed).toISOString();
    const grant = { version: 1, jobId: job.jobId, jobBinding: emergencyBinding(job), date: period.date, month: period.month,
      maxAttempts: approval.maxAttempts, expiresAt: new Date(expires).toISOString(),
      officialObservation: { observedAt: exactObservedAt, exactObservedAt, observedDateKST,
        // Recording an operator's report does not establish the time when the
        // provider screenshot was taken. Preserve unknown precision honestly.
        recordedAt: prior?.officialObservation?.recordedAt || new Date(recorded).toISOString(),
        observationPrecision: exactObservedAt === null ? "date" : "instant", month: observation.month,
        monthlyLimit: observation.monthlyLimit, used: observation.used, remaining: observation.remaining,
        internalMonthlyBaseline: observation.internalMonthlyBaseline,
        unclassifiedDifference: observation.used - observation.internalMonthlyBaseline,
        scopeAssumption: "production-app-as-approved-by-user" },
      automaticReserve: approval.automaticReserve, safetyReserve: approval.safetyReserve,
      uncertainReserve: Number(usage.monthly.searchTrendHistoricalUncertainReserve || 0) };
    if (prior) {
      if (JSON.stringify(Object.fromEntries(Object.keys(grant).map(key => [key, prior[key]]))) !== JSON.stringify(grant))
        throw emergencyError("EMERGENCY_GRANT_IMMUTABLE", "An existing one-off approval cannot be replaced or increased.");
      return prior;
    }
    if (Object.values(usage.emergencyInstantGrants || {}).some(value => value.date === period.date))
      throw emergencyError("EMERGENCY_GRANT_ALREADY_PROVISIONED", "Only one operator-approved Job may receive the day's one-off grant.");
    usage.emergencyInstantGrants = { ...usage.emergencyInstantGrants, [job.jobId]: {
      ...grant, createdAt: now.toISOString(), state: "active", used: 0 } };
    if (!emergencyStatus(usage, job, now).remaining)
      throw emergencyError("EMERGENCY_GRANT_UNAVAILABLE", "Official remaining quota does not leave room after the approved reserves.");
    usage.updatedAt = now.toISOString();
    if ((await blobStore.setJSON(USAGE_KEY, usage, entry?.etag ? { onlyIfMatch: entry.etag } : { onlyIfNew: true }))?.modified)
      return usage.emergencyInstantGrants[job.jobId];
  }
  throw emergencyError("QUOTA_WRITE_CONFLICT", "One-off quota approval changed concurrently.");
}
async function closeEmergencyGrant(jobId, options = {}) {
  const blobStore = options.store || store(), now = options.now || new Date();
  for (let attempt = 0; attempt < 12; attempt++) {
    const entry = await blobStore.getWithMetadata(USAGE_KEY, { type: "json" });
    const current = entry?.data, grant = current?.emergencyInstantGrants?.[jobId];
    if (!grant || grant.state !== "active") return grant || null;
    const closed = { ...grant, state: "closed", closedAt: now.toISOString(), closeReason: String(options.reason || "terminal").slice(0, 100) };
    const usage = { ...current, emergencyInstantGrants: { ...current.emergencyInstantGrants, [jobId]: closed }, updatedAt: now.toISOString() };
    if ((await blobStore.setJSON(USAGE_KEY, usage, { onlyIfMatch: entry.etag }))?.modified) return closed;
  }
  throw emergencyError("QUOTA_WRITE_CONFLICT", "One-off quota closure changed concurrently.");
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
    const emergencyJob = options.enforceBudget?.emergencyJob;
    if (emergencyJob && (!options.cumulative || emergencyJob.jobId !== options.jobId || options.enforceBudget.historical
      || Object.entries(delta).some(([type, metrics]) => type !== "searchTrend" && Number(metrics.calls || 0) > 0
        || Number(metrics.historicalCalls || 0) > 0 || METRIC_KEYS.some(key => !safeCount(Number(metrics[key] ?? 0))))))
      throw emergencyError("EMERGENCY_GRANT_INVALID", "Emergency accounting must be cumulative and bound to this Search Trend-only Job.");
    if (options.enforceBudget) for (const [type, metrics] of Object.entries(delta)) {
      if (!limits()[type] || Number(metrics.calls || 0) <= 0) continue;
      const historical = type === "searchTrend" && options.enforceBudget.historical;
      const available = emergencyJob ? emergencyStatus(usage, emergencyJob, now).remaining : historical ? historicalRemaining(usage, now).remaining
        : statusFor(usage, type, 0, now, { bootstrap: Boolean(options.enforceBudget.bootstrap) }).remaining;
      if (usage.exhausted[type] || Number(metrics.calls) > available)
        throw Object.assign(new Error("Provider request blocked before dispatch by the current safe budget."),
          { code: "QUOTA_BUDGET_EXHAUSTED", type, available });
    }
    if (emergencyJob && Number(delta.searchTrend?.calls || 0) > 0) {
      const grant = usage.emergencyInstantGrants[emergencyJob.jobId];
      grant.used += Number(delta.searchTrend.calls); grant.lastAttemptAt = now.toISOString();
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
  dynamicDailyLimit, daysRemainingInMonth, historicalRemaining, reserveUncertainHistoricalUsage, USAGE_KEY, normalizeUsage, cumulativeDelta,
  emergencyStatus, provisionEmergencyGrant, closeEmergencyGrant };
