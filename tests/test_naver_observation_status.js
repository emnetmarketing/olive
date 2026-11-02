const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { resolveNaverObservationStatus: resolve, normalize } = require('../netlify/functions/naver-observation-status');
const { loadNaverObservationContext: load, projectEarlyNaverStatus } = require('../netlify/functions/naver-observation-context');
const { shardFor } = require('../netlify/functions/trend-series-cache');
const { readArtifact } = require('../netlify/functions/instant-continuation');

const NOW = '2026-11-02T03:00:00Z';
const KEYWORD = '나이아신아마이드 20';
const KEY = normalize(KEYWORD);
function job(extra = {}) {
  return { jobId: 'instant-fixed', mode: 'instant', state: 'completed', publicationState: 'published',
    startDate: '2026-10-04', endDate: '2026-11-02', queryStartDate: '2026-10-03',
    targetDataDate: '2026-11-01', completedAt: '2026-11-02T02:00:00Z', analyzedCandidateCount: 1,
    results: [], ...extra };
}
function identity(value = job()) {
  return { jobId: value.jobId, selectedStartDate: value.startDate, selectedEndDate: value.endDate,
    queryStartDate: value.queryStartDate, requiredWindow: `${value.queryStartDate}:${value.endDate}` };
}
function record(points = [{ period: '2026-11-01', ratio: 10 }], extra = {}) {
  return { version: 1, normalizationVersion: 'keyword-v1', timeUnit: 'date',
    requestStartDate: '2026-10-03', requestEndDate: '2026-11-02', fetchedAt: '2026-11-02T01:00:00Z',
    rawRatioSeries: points, ...extra };
}
function trace(extra = {}) {
  return { keyword: KEYWORD, normalizedKeyword: KEY, selectedForAnalysis: true,
    latestDataDate: '2026-11-01', searchTrendStatus: 'valid', ...extra };
}
function diagnostic(items = [trace()], extra = {}) {
  const base = job();
  return { jobId: base.jobId, mode: base.mode, startDate: base.startDate, endDate: base.endDate,
    queryStartDate: base.queryStartDate, targetDataDate: base.targetDataDate,
    completedAt: base.completedAt, items, ...extra };
}
function pure(extra = {}) {
  return resolve({ keyword: KEYWORD, job: job(), now: NOW, entry: { search: record() }, ...extra });
}
function memoryStore(initial = []) {
  const values = new Map(initial), reads = [], writes = [];
  const forbid = name => async (...args) => { writes.push([name, ...args]); throw new Error('Status reads must not write'); };
  return { values, reads, writes,
    async get(key, options) { reads.push({ key, options }); return structuredClone(values.get(key) ?? null); },
    setJSON: forbid('setJSON'), set: forbid('set'), delete: forbid('delete'),
    getWithMetadata: forbid('getWithMetadata'), list: forbid('list') };
}
function dependencies(extra = {}) {
  const store = memoryStore(), calls = [];
  return { store, calls, values: {
    readLatest: async mode => { calls.push(['readLatest', mode]); return null; },
    readJob: async id => { calls.push(['readJob', id]); return null; },
    readDiagnostic: async () => { calls.push(['readDiagnostic']); return null; },
    store: () => { calls.push(['store']); return store; },
    seriesStore: () => store,
    readInputs: async () => { calls.push(['readInputs']); return null; },
    readState: async () => { calls.push(['readState']); return null; },
    readArtifact: async () => { calls.push(['readArtifact']); return null; },
    ...extra } };
}
function cache(entries = [[KEY, { search: record() }]]) { return { entries: new Map(entries) }; }
function immutable(store, jobId, label, value) {
  const artifact = { version: 1, jobId, label, value };
  const hash = crypto.createHash('sha256').update(JSON.stringify(artifact)).digest('hex');
  const key = `jobs/${encodeURIComponent(jobId)}/instant-v1/${label}/${hash}`;
  store.values.set(key, structuredClone(artifact));
  return { version: 1, jobId, label, key, hash };
}
function active(extra = {}) {
  return job({ state: 'running', publicationState: undefined,
    continuationDispatch: { ticket: 'ticket-1', state: 'pending', readyAt: NOW }, ...extra });
}
function collecting(value = active(), extra = {}) {
  return { ...identity(value), stage: 'collection', cursor: 0, ...extra };
}
function queued(value = active(), extra = {}) {
  return pure({ job: value, input: { ...identity(value), queue: [{ keyword: KEYWORD }] },
    checkpoint: collecting(value), registered: true, ...extra });
}

test('actual Job non-selection does not erase compatible target-date cache evidence', () => {
  const options = { selectionEvidence: { jobId: 'instant-fixed', complete: true, selected: false, basis: 'frozen-job-candidates' } };
  const before = JSON.stringify(options), status = pure(options);
  assert.equal(status.selection.state, 'not-selected');
  assert.equal(status.data.state, 'target-observed');
  assert.equal(status.data.targetObserved, true);
  assert.equal(status.collection.state, 'not-queued');
  assert.equal(status.assessment.state, 'unknown');
  assert.equal(JSON.stringify(options), before);
});

test('normal empty response, measured zero ratio, absent cache and invalid response remain distinct', () => {
  assert.equal(pure({ entry: { search: record([]) } }).data.state, 'empty');
  const zero = pure({ entry: { search: record([{ period: '2026-11-01', ratio: 0 }]) } });
  assert.equal(zero.data.state, 'target-observed');
  assert.equal(zero.data.emptyResponse, false);
  assert.equal(zero.assessment.state, 'unknown');
  assert.equal(pure({ entry: null }).data.state, 'missing');
  for (const ratio of [null, '', 'not-a-number'])
    assert.equal(pure({ entry: { search: record([{ period: '2026-11-01', ratio }]) } }).data.state, 'invalid');
  assert.equal(pure({ entry: { search: record([{ period: '2026-02-30', ratio: 1 }]) } }).data.state, 'invalid');
});

test('matching requested window and recent fetchedAt do not prove target-day observations', () => {
  const status = pure({ entry: { search: record([{ period: '2026-10-31', ratio: 22 }]) } });
  assert.equal(status.data.state, 'cached-before-target');
  assert.equal(status.data.windowCompatible, true);
  assert.equal(status.data.targetObserved, false);
  assert.equal(status.data.actualDataDate, '2026-10-31');
  assert.equal(status.data.fetchedAt, '2026-11-02T01:00:00Z');
});

test('target-day points and required-window compatibility are independent', () => {
  const status = pure({ entry: { search: record(undefined, { requestStartDate: '2026-10-04' }) } });
  assert.equal(status.data.state, 'window-unavailable');
  assert.equal(status.data.targetObserved, true);
  assert.equal(status.data.windowCompatible, false);
  assert.equal(status.assessment.state, 'unknown');
});

test('compatible saved historical window is preferred to a newer incompatible automatic record', () => {
  const entry = { search: record(undefined, { requestStartDate: '2026-10-20' }),
    searchWindows: { exact: record([{ period: '2026-10-31', ratio: 25 }], { fetchedAt: '2026-11-01T02:00:00Z' }) } };
  const before = JSON.stringify(entry), status = pure({ entry });
  assert.equal(status.data.source, 'historical-window-cache');
  assert.equal(status.data.actualDataDate, '2026-10-31');
  assert.equal(status.data.windowCompatible, true);
  assert.equal(JSON.stringify(entry), before);
});

test('another Period, Job, target date or window diagnostic cannot supply selection or surge verdict', () => {
  for (const override of [{ mode: 'period' }, { jobId: 'other-instant' }, { targetDataDate: '2026-10-31' },
    { startDate: '2026-10-01' }, { endDate: '2026-11-01' }, { queryStartDate: '2026-10-02' }]) {
    const status = pure({ diagnostic: diagnostic([trace({ absoluteSurgePassed: true })], override) });
    assert.equal(status.selection.state, 'unknown', JSON.stringify(override));
    assert.equal(status.assessment.state, 'unknown', JSON.stringify(override));
    assert.equal(status.data.state, 'target-observed');
  }
});

test('same completed Job needs all three explicit false flags and numerical exclusion to say criteria unmet', () => {
  const negative = trace({ absoluteSurgePassed: false, relativeSurgePassed: false, lowIntensityTrendPassed: false,
    finalIncluded: false, exclusionReason: '급등 수치 조건 미달' });
  assert.equal(pure({ diagnostic: diagnostic([negative]) }).assessment.state, 'criteria-not-met');
  for (const omitted of ['absoluteSurgePassed', 'relativeSurgePassed', 'lowIntensityTrendPassed']) {
    const incomplete = { ...negative }; delete incomplete[omitted];
    assert.equal(pure({ diagnostic: diagnostic([incomplete]) }).assessment.state, 'unknown');
  }
  assert.equal(pure({ diagnostic: diagnostic([{ ...negative, latestDataDate: '2026-10-31' }]) }).assessment.state, 'unknown');
  assert.equal(pure({ diagnostic: diagnostic([negative], { completedAt: null }) }).assessment.state, 'unknown');
});

test('not in final results due to product matching is not a numerical surge failure', () => {
  const row = trace({ absoluteSurgePassed: true, relativeSurgePassed: false, lowIntensityTrendPassed: false,
    finalIncluded: false, exclusionReason: '상품 매칭 기준 미달' });
  const assessment = pure({ diagnostic: diagnostic([row]) }).assessment;
  assert.equal(assessment.state, 'surge-confirmed');
  assert.equal(assessment.finalIncluded, false);
  assert.equal(assessment.exclusionReason, row.exclusionReason);
  assert.equal(pure({ diagnostic: diagnostic([trace({ absoluteSurgePassed: false, relativeSurgePassed: false,
    lowIntensityTrendPassed: false, finalIncluded: false, exclusionReason: '상품 매칭 기준 미달' })]) }).assessment.state, 'unknown');
});

test('low intensity is a leading signal, while ratio-only historical peak is not target-day surge confirmation', () => {
  assert.equal(pure({ diagnostic: diagnostic([trace({ absoluteSurgePassed: false, relativeSurgePassed: false,
    lowIntensityTrendPassed: true, finalIncluded: true })]) }).assessment.state, 'leading-signal');
  const ratio = trace({ ratioOnly: true, peakDate: '2026-10-20', ratioPeak: 100, relativeRatioLift: 300,
    absoluteSurgePassed: false, relativeSurgePassed: false, lowIntensityTrendPassed: false,
    finalIncluded: true, exclusionReason: '급등 수치 조건 미달' });
  assert.equal(pure({ diagnostic: diagnostic([ratio]), result: { ...ratio, resultType: 'ratio_only' } }).assessment.state, 'unknown');
  assert.equal(pure({ result: { keyword: KEYWORD, latestDataDate: '2026-11-01', peakDate: '2026-10-20', resultType: 'ratio_only' } }).assessment.state, 'unknown');
});

test('an unfinished/unpublished Job or previous-day override cannot borrow a different date assessment', () => {
  const source = diagnostic([trace({ absoluteSurgePassed: true })]);
  for (const value of [job({ state: 'running' }), job({ publicationState: 'publishing' })])
    assert.equal(pure({ job: value, diagnostic: source }).assessment.state, 'unknown');
  const previous = pure({ diagnostic: source, targetDataDate: '2026-10-31' });
  assert.equal(previous.assessment.state, 'unknown');
  assert.equal(previous.jobTargetDataDate, '2026-11-01');
  assert.equal(previous.targetDataDate, '2026-10-31');
});

test('collection queue needs a registered Job plus valid pending ticket, not a candidate plan alone', () => {
  assert.equal(queued().collection.state, 'queued');
  assert.equal(queued(active(), { registered: false }).collection.state, 'unknown');
  assert.equal(queued(active({ continuationDispatch: { state: 'pending' } })).collection.state, 'unknown');
  assert.equal(queued(active({ continuationDispatch: { ticket: 'ticket-1', state: 'failed' } })).collection.state, 'unknown');
  assert.equal(queued(active({ continuationDispatch: { ticket: 'ticket-1', state: 'pending', attemptsExhausted: true } })).collection.state, 'unknown');
  assert.equal(queued(active(), { input: { ...identity(), queue: [] } }).collection.state, 'not-queued');
});

test('live inflight collection requires entered ticket matching the current worker lease owner and fence', () => {
  const value = active({ instantWorker: { token: 'lease-fixture', owner: 'invocation-2', fence: 2,
    expiresAt: Date.parse(NOW) + 60_000 }, continuationDispatch: { ticket: 'ticket-2', state: 'entered',
    invocationId: 'invocation-2', workerFence: 2 } });
  const checkpoint = collecting(value, { inflight: { items: [{ keyword: KEYWORD }], startedAt: '2026-11-02T02:59:00Z' } });
  assert.equal(queued(value, { checkpoint }).collection.state, 'running');
  for (const change of [{ workerFence: 1 }, { invocationId: 'old-invocation' }, { state: 'accepted' }])
    assert.equal(queued({ ...value, continuationDispatch: { ...value.continuationDispatch, ...change } }, { checkpoint }).collection.state, 'unknown');
  assert.equal(queued({ ...value, instantWorker: { ...value.instantWorker, expiresAt: Date.parse(NOW) - 1 } }, { checkpoint }).collection.state, 'unknown');
});

test('completed or interrupted Jobs are never shown as live queue entries even if stale tickets remain', () => {
  assert.equal(queued(active({ state: 'completed' })).collection.state, 'not-queued');
  assert.equal(queued(active({ state: 'deferred' })).collection.state, 'not-queued');
  assert.equal(queued(active({ state: 'interrupted' })).collection.state, 'interrupted');
  assert.equal(queued(active({ stale: true })).collection.state, 'interrupted');
  const processed = queued(active(), { checkpoint: collecting(active(), { cursor: 1 }) });
  assert.equal(processed.collection.state, 'processed');
});

test('date preflight waiting, budget restriction and errors carry evidence rather than generic cache waiting', () => {
  const waiting = queued(active(), { checkpoint: collecting(active(), { targetDatePreflight: { status: 'waiting', nextCheckAt: '2026-11-02T05:00:00Z' } }) });
  assert.equal(waiting.collection.state, 'waiting-target-date');
  assert.equal(waiting.collection.nextCheckAt, '2026-11-02T05:00:00Z');
  const quota = pure({ diagnostic: diagnostic([trace({ collectionError: 'QUOTA_BUDGET_EXHAUSTED' })]) }).collection;
  assert.equal(quota.state, 'budget-held');
  assert.match(quota.label, /일\/월 구분 기록 없음/);
  assert.equal(pure({ diagnostic: diagnostic([trace({ collectionError: 'HTTP_429' })]) }).collection.state, 'error');
  assert.equal(pure({ diagnostic: diagnostic([trace({ trendWaitReason: 'daily_budget_exhausted' })]) }).collection.state, 'budget-held');
});

test('failed cache GET reports unknown ownership rather than asserting absent data', () => {
  const status = pure({ cacheReadFailed: true });
  assert.equal(status.data.state, 'unknown');
  assert.equal(status.data.targetObserved, null);
  assert.equal(status.data.windowCompatible, null);
  assert.match(status.data.label, /조회 실패/);
});

test('full completed same-Job 5,000-candidate diagnostic needs no frozen artifact or dispatcher reads', async () => {
  const rows = Array.from({ length: 5000 }, (_, index) => trace({ keyword: `후보 ${index}`, normalizedKeyword: normalize(`후보 ${index}`) }));
  const deps = dependencies();
  const context = await load({ job: job({ analyzedCandidateCount: 5000 }), diagnostic: diagnostic(rows),
    trendCache: cache([]), dependencies: deps.values });
  assert.equal(context.resolve('후보 4999').selection.state, 'selected');
  assert.equal(context.resolve('목록 밖 후보').selection.state, 'not-selected');
  assert.deepEqual(deps.calls, []);
  assert.deepEqual(deps.store.reads, []);
  assert.deepEqual(deps.store.writes, []);
});

test('context follows the Instant snapshot to its raw same-Job record using only read dependencies', async () => {
  const deps = dependencies();
  deps.values.readLatest = async mode => { deps.calls.push(['readLatest', mode]); return { jobId: 'instant-fixed' }; };
  deps.values.readJob = async id => { deps.calls.push(['readJob', id]); return job(); };
  const context = await load({ diagnostic: diagnostic(), trendCache: cache(), dependencies: deps.values });
  assert.equal(context.jobId, 'instant-fixed');
  assert.equal(context.resolve(KEYWORD).selection.state, 'selected');
  assert.deepEqual(deps.calls, [['readLatest', 'instant'], ['readJob', 'instant-fixed']]);
  assert.deepEqual(deps.store.writes, []);
  deps.values.readJob = async () => job({ jobId: 'wrong-pointer-job' });
  const mismatch = await load({ diagnostic: diagnostic(), trendCache: cache(), dependencies: deps.values });
  assert.equal(mismatch.jobId, null);
  assert.equal(mismatch.resolve(KEYWORD).assessment.state, 'unknown');
});

test('frozen candidate parts establish membership without reselecting current Discovery candidates', async () => {
  const value = job({ analyzedCandidateCount: 2 });
  const deps = dependencies({ readInputs: async () => ({ ...identity(value), totalCount: 2, parts: ['part-a', 'part-b'], queue: [] }),
    readArtifact: async ref => [{ candidate: { keyword: ref === 'part-a' ? KEYWORD : '다른 후보' } }] });
  const context = await load({ job: value, diagnostic: diagnostic([], { jobId: 'different-job' }),
    trendCache: cache(), dependencies: deps.values });
  assert.equal(context.resolve(KEYWORD).selection.state, 'selected');
  assert.equal(context.resolve(KEYWORD).selection.basis, 'frozen-job-candidates');
  assert.equal(context.resolve('다른 후보').selection.rank, 2);
  assert.equal(context.resolve('새 Discovery 후보').selection.state, 'not-selected');
  assert.equal(context.resolve(KEYWORD).assessment.state, 'unknown');
  assert.deepEqual(deps.store.writes, []);
});

test('wrong-Job frozen inputs and checkpoint cannot establish membership or a live queue', async () => {
  const value = active();
  const deps = dependencies({ readInputs: async () => ({ ...identity(value), jobId: 'other-job', totalCount: 1, parts: ['bad'], queue: [{ keyword: KEYWORD }] }),
    readState: async () => ({ ...collecting(value), jobId: 'other-job' }),
    readArtifact: async () => { assert.fail('wrong-Job artifact must not be read'); } });
  deps.store.values.set('instant-dispatch/v1', { jobs: [{ jobId: value.jobId }] });
  const context = await load({ job: value, diagnostic: null, trendCache: cache(), dependencies: deps.values });
  assert.equal(context.resolve(KEYWORD).selection.state, 'unknown');
  assert.equal(context.resolve(KEYWORD).collection.state, 'unknown');
  assert.deepEqual(deps.store.writes, []);
});

test('hashed immutable input/part reads reject modified data and never replace it from current inputs', async () => {
  const value = job({ analyzedCandidateCount: 2 }), deps = dependencies();
  const first = immutable(deps.store, value.jobId, 'input-part-0', [{ candidate: { keyword: KEYWORD } }]);
  const second = immutable(deps.store, value.jobId, 'input-part-1', [{ candidate: { keyword: '두번째' } }]);
  const inputs = immutable(deps.store, value.jobId, 'inputs', { ...identity(value), totalCount: 2, parts: [first, second], queue: [] });
  value.instantInputsKey = inputs.key; value.instantInputsHash = inputs.hash;
  // Use the real immutable hash reader, not a mock that hides integrity failure.
  const artifacts = require('../netlify/functions/instant-continuation');
  deps.values.readInputs = artifacts.readInputs;
  deps.values.readArtifact = readArtifact;
  let context = await load({ job: value, diagnostic: null, trendCache: cache(), dependencies: deps.values });
  assert.equal(context.resolve('목록 밖').selection.state, 'not-selected');
  deps.store.values.get(second.key).value.push({ candidate: { keyword: '변조된 후보' } });
  context = await load({ job: value, diagnostic: null, trendCache: cache(), dependencies: deps.values });
  assert.equal(context.resolve('목록 밖').selection.state, 'unknown');
  assert.equal(context.resolve('변조된 후보').selection.state, 'unknown');
  assert.deepEqual(deps.store.writes, []);
  assert.ok(deps.store.reads.every(read => read.options.type === 'json'));
});

test('same-Job checkpoint traces replace incompatible global Period diagnostic without mutating either', async () => {
  const value = job();
  const output = { traces: [trace({ absoluteSurgePassed: true, finalIncluded: false, exclusionReason: '상품 매칭 기준 미달' })] };
  const checkpoint = { ...identity(value), stage: 'finalize', outputs: ['numeric-output-0'] };
  const globalPeriod = diagnostic([trace({ absoluteSurgePassed: false })], { mode: 'period', jobId: 'period-job' });
  const before = JSON.stringify({ value, output, checkpoint, globalPeriod });
  const deps = dependencies({ readState: async () => checkpoint, readArtifact: async () => output });
  const context = await load({ job: value, diagnostic: globalPeriod, trendCache: cache(), dependencies: deps.values });
  const status = context.resolve(KEYWORD);
  assert.equal(status.selection.basis, 'same-job-checkpoint-traces');
  assert.equal(status.assessment.state, 'surge-confirmed');
  assert.equal(status.assessment.finalIncluded, false);
  assert.equal(JSON.stringify({ value, output, checkpoint, globalPeriod }), before);
  assert.deepEqual(deps.store.writes, []);
});

test('a checkpoint artifact read error leaves assessment unknown without borrowing global or partial decisions', async () => {
  const value = job({ analyzedCandidateCount: 2 });
  const deps = dependencies({ readState: async () => ({ ...identity(value), stage: 'finalize', outputs: ['first', 'missing'] }),
    readArtifact: async ref => { if (ref === 'missing') throw new Error('INSTANT_ARTIFACT_INTEGRITY');
      return { traces: [trace({ absoluteSurgePassed: true })] }; } });
  const context = await load({ job: value, diagnostic: diagnostic([], { jobId: 'different' }), trendCache: cache(), dependencies: deps.values });
  assert.equal(context.resolve(KEYWORD).assessment.state, 'unknown');
  assert.equal(context.resolve('목록 밖').selection.state, 'unknown');
  assert.deepEqual(deps.store.writes, []);
});

test('only requested cache shards are read and a failed shard is unknown, not missing', async () => {
  const deps = dependencies();
  deps.values.seriesStore = () => ({ get: async (key, options) => { deps.store.reads.push({ key, options }); throw new Error('unavailable'); },
    setJSON: deps.store.setJSON, delete: deps.store.delete });
  const context = await load({ job: job(), diagnostic: diagnostic(), keys: [KEYWORD, KEYWORD], dependencies: deps.values });
  assert.equal(context.resolve(KEYWORD).data.state, 'unknown');
  assert.deepEqual(deps.store.reads.map(read => read.key), [`shards/v1/${shardFor(KEY)}`]);
  assert.deepEqual(deps.store.writes, []);
});

test('loader ties queue evidence to the actual registry and does not repair a stale registry on GET', async () => {
  const value = active();
  const deps = dependencies({ readInputs: async () => ({ ...identity(value), totalCount: 1, parts: [], queue: [{ keyword: KEYWORD }] }),
    readState: async () => collecting(value) });
  deps.store.values.set('instant-dispatch/v1', { jobs: [{ jobId: 'different-job' }] });
  let context = await load({ job: value, diagnostic: null, trendCache: cache(), dependencies: deps.values });
  assert.equal(context.resolve(KEYWORD).collection.state, 'unknown');
  deps.store.values.set('instant-dispatch/v1', { jobs: [{ jobId: value.jobId }] });
  context = await load({ job: value, diagnostic: null, trendCache: cache(), dependencies: deps.values });
  assert.equal(context.resolve(KEYWORD).collection.state, 'queued');
  assert.deepEqual(deps.store.writes, []);
  assert.ok(deps.store.reads.every(read => read.key === 'instant-dispatch/v1'));
});

test('today signal previous-day assessment is bound to signalDate minus one, never everSurged history', async () => {
  const context = await load({ job: job(), diagnostic: diagnostic([trace({ absoluteSurgePassed: true })]),
    trendCache: cache(), dependencies: dependencies().values });
  const source = { signalDate: '2026-11-02', items: [
    { keyword: KEYWORD, previousNaverState: { everSurged: false } },
    { keyword: KEYWORD, earlySignalDate: '2026-11-01', previousNaverState: { everSurged: true } },
    { keyword: KEYWORD, earlySignalDate: 'invalid', previousNaverState: { everSurged: true } }] };
  const before = JSON.stringify(source), projected = projectEarlyNaverStatus(source, context);
  assert.equal(projected.items[0].previousDayNaverStatus.targetDataDate, '2026-11-01');
  assert.equal(projected.items[0].previousDayNaverStatus.assessment.state, 'surge-confirmed');
  assert.equal(projected.items[1].previousDayNaverStatus.targetDataDate, '2026-10-31');
  assert.equal(projected.items[1].previousDayNaverStatus.assessment.state, 'unknown');
  assert.equal(projected.items[2].previousDayNaverStatus, null);
  assert.equal(JSON.stringify(source), before);
});

test('budget messages distinguish an unknown quota scope from a dated daily exhaustion record', () => {
  const statusFor = (fields, now = NOW) => pure({ now, diagnostic: diagnostic([trace(fields)]) }).collection;
  const unknownScope = statusFor({ collectionError: 'QUOTA_BUDGET_EXHAUSTED' });
  assert.equal(unknownScope.state, 'budget-held');
  assert.match(unknownScope.label, /일\/월 구분 기록 없음/);
  assert.doesNotMatch(unknownScope.label, /오늘.*소진/);
  // Both timestamps fall on 11/02 in KST, although the source's UTC date is 11/01.
  const sameKstDay = statusFor({ trendWaitReason: 'daily_budget_exhausted', trendFetchedAt: '2026-11-01T16:00:00Z' });
  assert.equal(sameKstDay.label, '오늘 수집 예산 소진');
  for (const stamp of ['2026-11-01T14:59:59Z', '2026-11-01T23:59:59+09:00', '2026-11-02 08:00:00', 'invalid']) {
    const oldOrUnknown = statusFor({ trendWaitReason: 'daily_budget_exhausted', trendFetchedAt: stamp });
    assert.match(oldOrUnknown.label, /해당 Job 내부 예산 보류/);
    assert.doesNotMatch(oldOrUnknown.label, /오늘.*소진/);
  }
  const internal = statusFor({ trendWaitReason: 'internal_budget_wait', trendFetchedAt: '2026-11-02T02:00:00Z' });
  assert.equal(internal.state, 'budget-held');
  assert.equal(internal.errorCode, 'internal_budget_wait');
  assert.match(internal.label, /현재 잔여 예산은 별도 확인/);
  assert.doesNotMatch(internal.label, /오늘.*소진/);
});

test('collection error presentation exposes a bounded HTTP code, never raw credentials or response content', () => {
  const secret = 'fixturePrivateToken42NeverExpose';
  const regular = pure({ diagnostic: diagnostic([trace({ collectionError: 'HTTP_429',
    responseBody: { token: secret }, authorization: `Bearer ${secret}`, errorMessage: `secret=${secret}` })]) }).collection;
  assert.equal(regular.state, 'error');
  assert.equal(regular.errorCode, 'HTTP_429');
  assert.match(regular.label, /HTTP_429/);
  assert.equal(JSON.stringify(regular).includes(secret), false);
  // A contaminated legacy error field must not be treated as a safe code merely
  // because punctuation was stripped; alphanumeric credentials would survive.
  const contaminated = pure({ diagnostic: diagnostic([trace({ collectionError: `HTTP_429 Authorization: Bearer ${secret}` })]) }).collection;
  assert.equal(contaminated.state, 'error');
  assert.equal(contaminated.errorCode, 'HTTP_429');
  assert.equal(JSON.stringify(contaminated).includes(secret), false);
});

test('empty historical response outside the required window remains window-unavailable with empty evidence', () => {
  const data = pure({ entry: { search: record([], { requestStartDate: '2026-10-20', requestEndDate: '2026-10-31' }) } }).data;
  assert.equal(data.state, 'window-unavailable');
  assert.equal(data.emptyResponse, true);
  assert.equal(data.windowCompatible, false);
  assert.equal(data.targetObserved, false);
  assert.equal(data.actualStartDate, null);
  assert.equal(data.actualDataDate, null);
  assert.match(data.label, /분석 기간 데이터 부족/);
  assert.match(data.label, /기존 조회는 빈 응답/);
});
