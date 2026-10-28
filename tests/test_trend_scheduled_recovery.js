const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../netlify/functions/trend-scheduled-runner');
const policy = require('../netlify/functions/trend-scheduled-recovery');
const NOW = '2026-10-27T23:00:00.000Z', TARGET = '2026-10-27';
const completed = (extra = {}) => ({ jobId: 'completed-current', mode: 'instant', state: 'completed', publicationState: 'published', targetDataDate: TARGET, results: [{ keyword: 'saved' }], ...extra });
function fixture({ current = null, previous = null, collection = null, resumed = null } = {}) {
  const calls = [], updates = []; let recoveries = 0, currentReads = 0;
  return { calls, updates, get recoveries() { return recoveries; }, get currentReads() { return currentReads; }, deps: {
    skipConnect: true, now: () => new Date(NOW), begin: async source => ({ executionId: 'execution', source }),
    update: async (record, patch) => { updates.push(patch); return { ...record, ...patch }; },
    readRecoveryContext: async () => ({ current, completed: previous }), readLatestCollection: async () => collection,
    readCurrentJob: async () => { currentReads++; return null; }, recoverWaiting: async () => { recoveries++; return resumed; },
    handle: async (event, options) => { calls.push({ body: JSON.parse(event.body), options }); return { statusCode: 202, body: JSON.stringify({ jobId: 'new-check' }) }; }
  } };
}
function fingerprint() { return { version: 1, targetDataDate: TARGET, startDate: '2026-09-29', endDate: '2026-10-28', queryStartDate: '2026-09-28', surgeThreshold: 300, matchThreshold: 40, calculationVersion: 'fixture-v1', candidatesHash: '1'.repeat(64), productHash: '2'.repeat(64), sourceHash: '3'.repeat(64), evidenceHash: '4'.repeat(64) }; }
test('waiting same-target preflight remains one Job beyond ordinary twelve-minute stale overlay', async () => {
  const f = fixture({ current: { jobId: 'waiting', mode: 'instant', state: 'running', targetDataDate: TARGET, updatedAt: '2026-10-27T21:05:00Z', targetDatePreflight: { targetDataDate: TARGET, status: 'waiting', attempts: 1, maxAttempts: 3, nextCheckAt: '2026-10-27T23:05:00Z' } } });
  const result = await run({ body: '{}' }, 'scheduled-recovery', f.deps);
  assert.equal(result.statusCode, 202); assert.equal(JSON.parse(result.body).jobId, 'waiting');
  assert.equal(f.calls.length, 0); assert.equal(f.currentReads, 0); assert.equal(f.updates.at(-1).stage, 'waiting-for-source');
});
test('exhausted deferred preflight never creates a second same-target collection', async () => {
  const f = fixture({ current: { jobId: 'deferred', mode: 'instant', state: 'deferred', targetDataDate: TARGET, targetDatePreflight: { targetDataDate: TARGET, status: 'sample-target-unconfirmed', attempts: 3, maxAttempts: 3, nextCheckAt: null } } });
  const result = await run({ body: '{}' }, 'scheduled-recovery', f.deps);
  assert.equal(result.statusCode, 200); assert.equal(f.calls.length, 0); assert.equal(f.recoveries, 0); assert.equal(f.updates.at(-1).stage, 'source-check-deferred');
});
test('a previous-day deferred Job does not block the new target day', async () => {
  const f = fixture({ current: { jobId: 'old', mode: 'instant', state: 'deferred', targetDataDate: '2026-10-26', targetDatePreflight: { targetDataDate: '2026-10-26', status: 'sample-target-unconfirmed' } } });
  await run({ body: '{}' }, 'scheduled-recovery', f.deps); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.targetDatePreflight, true);
});
test('08:00 passes latest completed analysis as a trusted option, never a client body field', async () => {
  const f = fixture({ previous: completed({ jobId: 'newest-113' }) });
  await run({ body: JSON.stringify({ recoveryOfJobId: 'injected', targetDatePreflight: false }) }, 'scheduled-recovery', f.deps);
  assert.equal(f.calls[0].options.recoveryOfJobId, 'newest-113'); assert.equal(f.calls[0].options.targetDatePreflight, true);
  assert.equal(Object.hasOwn(f.calls[0].body, 'recoveryOfJobId'), false); assert.equal(Object.hasOwn(f.calls[0].body, 'targetDatePreflight'), false);
});
test('completed collection still verifies changed recovery inputs instead of unconditional already-collected skip', async () => {
  const f = fixture({ previous: completed(), collection: { collectedAt: NOW, latestDataDate: TARGET } });
  await run({ body: '{}' }, 'scheduled-recovery', f.deps); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.recoveryOfJobId, 'completed-current');
});
test('primary uses preflight without a prior recovery calculation hint', async () => {
  const f = fixture({ previous: completed() }); await run({ body: '{}' }, 'scheduled-primary', f.deps);
  assert.equal(f.calls[0].options.targetDatePreflight, true); assert.equal(f.calls[0].options.recoveryOfJobId, undefined);
});
test('publication-only resume preserves original Job without creating calculation', async () => {
  const f = fixture({ resumed: completed({ jobId: 'publish-only', state: 'publication_failed', schedulerExecutionId: 'original-execution' }) });
  const result = await run({ body: '{}' }, 'scheduled-recovery', f.deps);
  assert.equal(f.calls.length, 0); assert.equal(JSON.parse(result.body).jobId, 'publish-only'); assert.equal(f.updates.at(-1).stage, 'existing-publication-queued');
});
test('checkpoint resume is distinguished from publication-only completion', async () => {
  const f = fixture({ resumed: { jobId: 'checkpoint', mode: 'instant', state: 'running', instantStage: 'numeric' } });
  await run({ body: '{}' }, 'scheduled-recovery', f.deps); assert.equal(f.calls.length, 0); assert.equal(f.updates.at(-1).stage, 'existing-checkpoint-queued');
});
test('only fully verified identical frozen fingerprints may skip calculation', () => {
  const original = fingerprint(); assert.equal(policy.compareRecoveryInputs(original, structuredClone(original)).unchanged, true);
  for (const field of Object.keys(original).filter(k => k !== 'version')) {
    const changed = { ...original, [field]: field.endsWith('Hash') ? 'a'.repeat(64) : 'different' };
    assert.equal(policy.compareRecoveryInputs(original, changed).unchanged, false, field);
    const missing = { ...original }; delete missing[field]; assert.equal(policy.compareRecoveryInputs(original, missing).unchanged, false, field);
  }
  assert.equal(policy.compareRecoveryInputs(null, original).reason, 'missing-fingerprint');
  assert.equal(policy.compareRecoveryInputs(original, { ...original, version: 2 }).unchanged, false);
});
test('recovery hints reject Period, failed, missing results and older targets', () => {
  for (const value of [completed({ mode: 'period' }), completed({ state: 'failed' }), completed({ results: null }), completed({ targetDataDate: '2026-10-26' })])
    assert.equal(policy.completedRecoveryReference(value, TARGET), null);
});
test('context reads latest-analysis not latest-valid and deduplicates Job reads', async () => {
  const reads = [], saved = completed();
  const store = { get: async key => { reads.push(key); return key === 'current-job/v1' ? { jobId: saved.jobId } : saved; } };
  const snapshotStore = { get: async key => { assert.equal(key, 'latest-analysis-v1/instant'); return { jobId: saved.jobId }; } };
  const context = await policy.readRecoveryContext({ store, snapshotStore });
  assert.equal(context.completed.jobId, saved.jobId); assert.equal(reads.filter(k => k.startsWith('jobs/')).length, 1);
});
test('context follows a bounded publication pointer chain without scans', async () => {
  let pointer = null; for (let i = 0; i < 10; i++) pointer = { jobId: `pending-${i}`, previous: pointer };
  let reads = 0; const store = { get: async key => { if (key === 'current-job/v1') return null; reads++; return { mode: 'instant', state: 'publishing' }; } };
  const result = await policy.readRecoveryContext({ store, snapshotStore: { get: async () => pointer } });
  assert.equal(reads, 4); assert.equal(result.completed, null);
});
test('unreadable authoritative recovery state fails closed without starting work', async () => {
  const f = fixture(); f.deps.readRecoveryContext = async () => { throw new Error('fixture read unavailable'); };
  const result = await run({ body: '{}' }, 'scheduled-recovery', f.deps); assert.equal(result.statusCode, 500); assert.equal(f.calls.length, 0); assert.equal(f.updates.at(-1).stage, 'scheduler-exception');
});
