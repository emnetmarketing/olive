const { getStore } = require('@netlify/blobs');
const analysis = require('./trend-analysis-cache');
const snapshots = require('./signal-snapshot-cache');
const series = require('./trend-series-cache');
const artifacts = require('./instant-continuation');
const { resolveNaverObservationStatus, compatibleDiagnostic, sameIdentity, normalize, date } = require('./naver-observation-status');

function connect(event) { analysis.connect(event); snapshots.connect(event); series.connect(event); }
// Use immutable, hashed artifacts with an ordinary read connection. No worker acquisition,
// stale reconciliation, pointer repair, or provider requests may run on a status GET.
async function loadNaverObservationContext(options = {}) {
  const dependencies = { readLatest: snapshots.readLatest, readJob: analysis.readRawJob, readDiagnostic: analysis.readDiagnosticIndex,
    store: analysis.store, seriesStore: () => getStore('trend-series-cache'), readInputs: artifacts.readInputs,
    readState: artifacts.readState, readArtifact: artifacts.readArtifact, ...options.dependencies };
  let job = options.job;
  if (job === undefined) {
    try { const snapshot = await dependencies.readLatest('instant');
      job = snapshot?.jobId ? await dependencies.readJob(snapshot.jobId) : null;
      if (job?.jobId !== snapshot?.jobId) job = null;
    } catch { job = null; }
  }
  if (job?.mode !== 'instant') job = null;
  const wanted = Array.isArray(options.keys) ? new Set(options.keys.map(normalize).filter(Boolean)) : null;
  const entries = new Map(), failedShards = new Set();
  if (options.trendCache) {
    for (const [key, value] of options.trendCache.entries || []) entries.set(key, value);
    for (const shard of options.trendCache.failedShards || []) failedShards.add(shard);
  } else {
    const shards = wanted ? [...new Set([...wanted].map(series.shardFor))] : Array.from({ length: series.SHARD_COUNT }, (_, index) => index);
    await Promise.all(shards.map(async index => {
      try {
        const shard = await dependencies.seriesStore().get(`shards/v1/${index}`, { type: 'json' });
        for (const [key, value] of Object.entries(shard?.entries || {})) if (!wanted || wanted.has(key)) entries.set(key, value);
      } catch { failedShards.add(index); }
    }));
  }
  let diagnostic = options.diagnostic;
  if (diagnostic === undefined) { try { diagnostic = await dependencies.readDiagnostic(); } catch { diagnostic = null; } }
  if (!compatibleDiagnostic(diagnostic, job)) diagnostic = null;
  let traces = new Map((diagnostic?.items || []).map(item => [normalize(item.normalizedKeyword || item.keyword), item]));
  let membership = new Map([...traces].filter(([, item]) => item.selectedForAnalysis === true).map(([key], index) => [key, index + 1]));
  const total = Number(job?.analyzedCandidateCount || job?.totalCandidates || 0);
  let complete = total > 0 && membership.size === total;
  let basis = 'same-job-diagnostic', input = null, checkpoint = null, registered = false;
  // A full completed same-Job diagnostic is enough; avoid reloading 5,000 frozen product/evidence records.
  if (job && (!complete || job.state !== 'completed')) {
    const store = dependencies.store(), readOptions = { store, jobId: job.jobId };
    try { input = await dependencies.readInputs(job, readOptions); if (!sameIdentity(input, job)) input = null; } catch { input = null; }
    try { checkpoint = await dependencies.readState(job, readOptions); if (!sameIdentity(checkpoint, job)) checkpoint = null; } catch { checkpoint = null; }
    if (job.state !== 'completed') {
      try { const registry = await store.get('instant-dispatch/v1', { type: 'json' }); registered = Boolean(registry?.jobs?.some(item => item.jobId === job.jobId)); } catch { /* unknown, not queued */ }
    }
    // Global diagnostics may be from a different Period/Instant Job. Prefer this Job's
    // durable outputs, never borrow another Job's decision or recompute its thresholds.
    if (!diagnostic && checkpoint?.outputs?.length && checkpoint.outputs.length <= 128) {
      const saved = [];
      try {
        for (const ref of checkpoint.outputs) {
          const output = await dependencies.readArtifact(ref, readOptions);
          saved.push(...(output?.traces || []));
        }
        diagnostic = { jobId: job.jobId, mode: 'instant', startDate: job.startDate, endDate: job.endDate,
          completedAt: job.state === 'completed' ? job.completedAt : null, items: saved };
        traces = new Map(saved.map(item => [normalize(item.normalizedKeyword || item.keyword), item]));
        membership = new Map([...traces].filter(([, item]) => item.selectedForAnalysis === true).map(([key], index) => [key, index + 1]));
        complete = total > 0 && membership.size === total;
        basis = 'same-job-checkpoint-traces';
      } catch { diagnostic = null; traces = new Map(); membership = new Map(); complete = false; }
    }
    if (!complete && input?.parts?.length && input.parts.length <= 40) {
      const selected = new Map();
      try {
        for (const ref of input.parts) for (const entry of await dependencies.readArtifact(ref, readOptions)) {
          const key = normalize(entry.candidate?.keyword); if (key) selected.set(key, selected.size + 1);
        }
        membership = selected; complete = selected.size === Number(input.totalCount) && selected.size === total;
        basis = 'frozen-job-candidates';
      } catch { /* partial evidence cannot establish non-membership */ complete = false; }
    }
  }
  const queue = new Map((input?.queue || []).map((item, index) => [normalize(item.keyword), index]));
  const results = new Map((job?.results || []).map(row => [normalize(row.keyword), row]));
  return { jobId: job?.jobId || null, targetDataDate: job?.targetDataDate || null,
    resolve(keyword, overrides = {}) {
      const key = normalize(keyword);
      return resolveNaverObservationStatus({ key, job, input, checkpoint, diagnostic, diagnosticItem: traces.get(key), result: results.get(key),
        selectionEvidence: { jobId: job?.jobId, selected: membership.has(key), complete, rank: membership.get(key), basis },
        queueKnown: Boolean(input && Array.isArray(input.queue)), queueIndex: queue.get(key) ?? -1, registered,
        entry: entries.get(key), cacheReadFailed: failedShards.has(series.shardFor(key)), now: options.now, ...overrides });
    } };
}
function previousDate(value) {
  if (!date(value)) return null;
  return new Date(Date.parse(value + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
}
function projectEarlyNaverStatus(cache, context) {
  return { ...cache, items: (cache?.items || []).map(item => {
    const target = previousDate(item.earlySignalDate || cache.signalDate);
    return { ...item, previousDayNaverStatus: target ? context.resolve(item.keyword, { targetDataDate: target }) : null };
  }) };
}
module.exports = { connect, loadNaverObservationContext, projectEarlyNaverStatus, previousDate };
