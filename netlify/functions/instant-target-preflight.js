// Scheduled collection readiness only. A small sample is not a claim about
// provider-wide availability and never changes mathematical analysis inputs.
const SAMPLE_SIZE = 5;
const MAX_ATTEMPTS = 3;
const RETRY_MS = 2 * 60 * 60 * 1000;
const normalized = value => String(value || "").normalize("NFKC").toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
const scheduled = job => job?.mode === "instant" && !job.fastPath && job.targetDatePreflightEnabled === true
  && /^scheduled-(primary|recovery)$/.test(job.triggerSource || "");
function plan(job, entries) {
  if (!scheduled(job)) return null;
  const target = job.targetDataDate;
  const confirmed = entries.filter(e => e.compatible && e.series?.some(p => p.period === target));
  const latest = entries.flatMap(e => (e.series || []).map(p => p.period)).filter(Boolean).sort().at(-1) || null;
  const representatives = entries.filter(e => Array.isArray(e.series) && e.series.length >= 7
    && e.series.every(p => /^\d{4}-\d{2}-\d{2}$/.test(p?.period || "") && p.ratio !== null && p.ratio !== "" && Number.isFinite(Number(p.ratio)))
    && e.series.some(p => Number(p.ratio) > 0)
    && e.series.map(p => p.period).sort().at(-1) >= new Date(Date.parse(`${target}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10))
    .sort((a, b) => b.series.length - a.series.length || Number(b.priority || 0) - Number(a.priority || 0)
      || a.partIndex - b.partIndex || a.offset - b.offset).slice(0, SAMPLE_SIZE)
    .map(({ keyword, category, partIndex, offset }) => ({ keyword, category, partIndex, offset }));
  const day = new Date(Date.parse(job.createdAt) + 9 * 3600000).toISOString().slice(0, 10);
  return { version: 1, targetDataDate: target, samples: representatives, sampleSize: representatives.length,
    status: confirmed.length ? "confirmed-cache" : representatives.length ? "pending" : "no-representative-sample",
    targetConfirmedKeywords: confirmed.length, lastResponseDate: latest,
    lastCheckedAt: confirmed.map(e => e.fetchedAt).filter(Boolean).sort().at(-1) || null,
    expiresAt: new Date(Date.parse(`${day}T00:00:00+09:00`) + 86400000).toISOString(),
    deadlineAt: new Date(Date.parse(`${day}T00:00:00+09:00`) + 86400000).toISOString(),
    maxAttempts: MAX_ATTEMPTS, retryMs: RETRY_MS, attempts: 0, nextCheckAt: null,
    scope: "sample-only-not-provider-wide", reason: confirmed.length ? "target-observed-in-compatible-cache" : "target-sample-required" };
}
function summarize(check) {
  if (!check) return null;
  const { samples, successfulSampleKeys, ...summary } = check;
  return summary;
}
function observe(check, responses, items, at = new Date().toISOString()) {
  const successful = responses.filter(r => r.success);
  const targetConfirmedKeywords = successful.filter(r => (r.series || []).some(p => p.period === check.targetDataDate)).length;
  const lastResponseDate = successful.flatMap(r => (r.series || []).map(p => p.period)).filter(Boolean).sort().at(-1) || null;
  const nextCheckAt = new Date(Date.parse(at) + RETRY_MS).toISOString();
  const more = check.attempts < MAX_ATTEMPTS && Date.parse(nextCheckAt) < Date.parse(check.expiresAt);
  return { ...check, lastCheckedAt: at, lastResponseDate, successfulKeywords: successful.length, targetConfirmedKeywords,
    successfulSampleKeys: [...new Set([...(check.successfulSampleKeys || []),
      ...responses.flatMap((r, i) => r.success ? [normalized(items[i].keyword)] : [])])],
    status: targetConfirmedKeywords ? "confirmed-sample" : more ? "waiting" : successful.length ? "sample-target-unconfirmed" : "sample-error",
    nextCheckAt: !targetConfirmedKeywords && more ? nextCheckAt : null,
    reason: targetConfirmedKeywords ? "target-observed-in-sample" : successful.length ? "target-not-observed-in-sample" : "sample-request-failed" };
}
function action(check, now = Date.now()) {
  if (!check || ["confirmed-cache", "confirmed-sample"].includes(check.status)) return "collect";
  if (Date.parse(check.expiresAt) <= now || ["sample-target-unconfirmed", "sample-error", "budget-limited", "no-representative-sample"].includes(check.status)) return "defer";
  if (check.nextCheckAt && Date.parse(check.nextCheckAt) > now) return "wait";
  return Number(check.attempts || 0) >= MAX_ATTEMPTS ? "defer" : "probe";
}
module.exports = { SAMPLE_SIZE, MAX_ATTEMPTS, RETRY_MS, scheduled, plan, summarize, observe, action, normalized };
