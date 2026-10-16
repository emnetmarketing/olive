// Pure planning policy for a frozen Instant collection. This module performs no
// I/O and does not change Trend ratios, result ordering, or quota allocation.
const POLICY_VERSION = 1;
const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
const HOUR = 60 * 60 * 1000;
function normalizedKeyword(value) { return String(value || "").normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[^0-9a-z가-힣]/g, ""); }
function day(value) { return formatter.format(new Date(value)); }
function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function shiftDate(value, amount) { return new Date(Date.parse(`${value}T00:00:00Z`) + amount * 24 * HOUR).toISOString().slice(0, 10); }
function frozenWindow(job) {
  const startDate = job?.queryStartDate || job?.requiredWindow?.startDate;
  const endDate = job?.endDate || job?.requiredWindow?.endDate;
  const target = job?.targetDataDate;
  const observationStartedAt = job?.collectionObservationStartedAt || job?.createdAt;
  const validObservationTime = Number.isFinite(Date.parse(observationStartedAt || ""));
  const observationDate = job?.collectionObservationDate || (validObservationTime ? day(observationStartedAt) : null);
  if (job?.mode !== "instant" || ![startDate, endDate, target, observationDate].every(validDate) || startDate > target || target > endDate
      || !Number.isFinite(Date.parse(observationStartedAt || "")))
    throw Object.assign(new Error("Instant collection requires a valid frozen window, target date, and observation start."), { code: "INVALID_INSTANT_COLLECTION_INPUT" });
  return { startDate, endDate, targetDataDate: target, observationStartedAt, observationDate };
}
function covers(record, window) {
  return Boolean(record && validDate(record.requestStartDate) && validDate(record.requestEndDate)
    && record.requestStartDate <= window.startDate && record.requestEndDate >= window.endDate);
}
function healthy(record) {
  return Boolean(record && record.version === 1 && record.normalizationVersion === "keyword-v1"
    && record.timeUnit === "date" && Array.isArray(record.rawRatioSeries)
    && record.rawRatioSeries.every(point => validDate(point?.period) && point.ratio !== null && point.ratio !== ""
      && Number.isFinite(Number(point.ratio))));
}

// cached may be an ordinary lookup result. The coordinator can additionally
// attach its durable per-Job receipt as cached.attempted/cached.receipt.
function classify(record, cached = {}, job, now = new Date()) {
  const window = frozenWindow(job), time = new Date(now).getTime();
  if (!Number.isFinite(time)) throw new Error("Invalid Instant collection clock.");
  const attempted = Boolean(cached.attempted || cached.receipt);
  const compatible = covers(record, window), reusable = compatible && healthy(record);
  const series = reusable ? record.rawRatioSeries.filter(point => point.period >= window.startDate && point.period <= window.endDate) : null;
  const dates = (series || []).map(point => point.period).sort();
  const actual = dates.at(-1) || null;
  const fetched = Date.parse(record?.fetchedAt || "");
  const fetchedDate = Number.isFinite(fetched) ? day(fetched) : null;
  const observed = reusable && fetched <= time && fetched >= Date.parse(window.observationStartedAt)
    && fetchedDate >= window.observationDate;
  const result = { state: "needs-refresh", shouldFetch: true, reusable, attempted,
    targetDataDate: window.targetDataDate, actualDataDate: actual, empty: reusable && dates.length === 0,
    observedInCollection: Boolean(observed), reason: "missing-cache", nextCheckAt: null };
  if (reusable && dates.includes(window.targetDataDate)) {
    Object.assign(result, { state: "target-confirmed", shouldFetch: false, reason: "target-day-observed" });
  } else if (reusable) {
    const empty = dates.length === 0;
    const delay = (empty ? 24 : 2) * HOUR;
    const settled = window.endDate <= shiftDate(window.observationDate, -3)
      && fetchedDate && fetchedDate >= shiftDate(window.endDate, 2);
    const recent = Number.isFinite(fetched) && fetched <= time && time - fetched < delay;
    if (observed || settled || recent) {
      Object.assign(result, { state: empty ? "empty" : "confirmed-no-target", shouldFetch: false,
        reason: observed ? "successful-observation-reused" : settled ? "settled-historical-response" : "recent-response-reused" });
    } else {
      result.reason = empty ? "empty-response-recheck-due" : "target-day-recheck-due";
    }
    result.nextCheckAt = Number.isFinite(fetched) ? new Date(fetched + delay).toISOString() : null;
  } else if (record && !compatible) {
    Object.assign(result, { state: "window-unavailable", reason: "cache_window_unavailable" });
  } else if (record || cached.error || cached.state === "error") {
    Object.assign(result, { state: "error", reason: "invalid-or-failed-cache" });
  }
  // A missing/failed durable response is not proof that the provider was never
  // called. Never retry that keyword automatically inside this logical Job.
  if (attempted && result.shouldFetch) {
    Object.assign(result, { state: "error", shouldFetch: false, reason: "already-attempted-in-job" });
  }
  return result;
}

function bestRecord(entry, window) {
  if (!entry) return null;
  const records = entry.rawRatioSeries ? [entry] : [entry.search, ...Object.values(entry.searchWindows || {})].filter(Boolean);
  const ordered = records.slice().sort((a, b) => (Date.parse(b.fetchedAt || "") || 0) - (Date.parse(a.fetchedAt || "") || 0));
  return ordered.find(record => covers(record, window) && healthy(record))
    || ordered.find(record => covers(record, window)) || ordered[0] || null;
}
function receiptFor(attempted, key) {
  if (attempted instanceof Set) return attempted.has(key);
  if (attempted instanceof Map) return attempted.get(key);
  if (Array.isArray(attempted)) return attempted.some(value => normalizedKeyword(typeof value === "string" ? value : value.keyword) === key);
  return attempted?.[key] || false;
}
function createPlan(candidates, entries, job, options = {}) {
  const window = frozenWindow(job), now = options.now || new Date(), seen = new Set(), items = [];
  for (const candidate of candidates || []) {
    const keyword = typeof candidate === "string" ? candidate : candidate.keyword;
    const key = normalizedKeyword(keyword);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entry = entries instanceof Map ? entries.get(key) : entries?.[key];
    const record = bestRecord(entry, window), receipt = receiptFor(options.attempted, key);
    items.push({ index: items.length, key, keyword, candidate, record,
      ...classify(record, { attempted: Boolean(receipt), receipt: receipt || null }, job, now) });
  }
  const counts = {};
  for (const item of items) counts[item.state] = Number(counts[item.state] || 0) + 1;
  const selected = items.filter(item => item.shouldFetch).map(item => item.candidate);
  return { version: POLICY_VERSION, ...window, items, selected, fetchCandidates: selected,
    reusableItems: items.filter(item => item.reusable), blockedItems: items.filter(item => !item.reusable && !item.shouldFetch),
    totalCount: items.length, fetchCount: selected.length, reusableCount: items.filter(item => item.reusable).length,
    targetConfirmedCount: counts["target-confirmed"] || 0, counts };
}
module.exports = { POLICY_VERSION, normalizedKeyword, frozenWindow, classify, createPlan, bestRecord };
