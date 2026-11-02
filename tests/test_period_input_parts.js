const test = require('node:test');
const assert = require('node:assert/strict');
const { FORMAT, writeParts, readParts } = require('../netlify/functions/period-input-parts');
const { freezePeriodCalculationInputs } = require('../netlify/functions/period-frozen-input');
const { lookup } = require('../netlify/functions/trend-series-cache');
const { digest } = require('../netlify/functions/period-publication');
function store() {
  const records = new Map();
  return { records, async setJSON(k, v, opts) {
    assert.deepEqual(opts, { onlyIfNew: true });
    if (!records.has(k)) records.set(k, JSON.stringify(v));
    return { modified: true };
  }, async get(k) { return records.has(k) ? JSON.parse(records.get(k)) : null; } };
}
test('frozen Period manifest references immutable verified bounded parts, preserves JSON order and detects corruption', async () => {
  const s = store(), input = { nullValue: null, version: 1, selection: { selected: Array.from({ length: 1000 }, (_, i) =>
    ({ keyword: '검색어' + i, n: i, source: ['ad'], optional: undefined })), ratioOnly: [], diagnostics: { note: undefined } } };
  const saved = await writeParts(s, 'test', input, { maxBytes: 777 });
  assert.equal(saved.format, FORMAT);
  assert.ok(saved.partCount > 20);
  for (const record of s.records.values()) assert.ok(Buffer.byteLength(JSON.parse(record).text) <= 777);
  const reconstructed = await readParts(s, 'test', saved);
  assert.deepEqual(reconstructed, JSON.parse(JSON.stringify(input)));
  assert.equal(digest(reconstructed), digest(input));
  await assert.rejects(readParts(s, 'other-job', saved), { code: 'PERIOD_ARTIFACT_INTEGRITY' });
  const first = [...s.records.keys()][0];
  s.records.set(first, JSON.stringify({ text: '[]' }));
  await assert.rejects(readParts(s, 'test', saved), { code: 'PERIOD_ARTIFACT_INTEGRITY' });
  await assert.rejects(writeParts(s, 'test', input, { maxBytes: 777 }), { code: 'PERIOD_ARTIFACT_INTEGRITY' });
});
test('partial part failure leaves no readable manifest; same Job may safely reuse previously verified parts', async () => {
  const s = store(), input = { parts: Array.from({ length: 81 }, (_, n) => ({ n, word: '가'.repeat(20) })) };
  const original = s.setJSON; let count = 0;
  s.setJSON = async (...args) => { if (++count === 3) throw Error('store unavailable'); return original(...args); };
  await assert.rejects(writeParts(s, 'test', input, { maxBytes: 200 }), /unavailable/);
  assert.equal(s.records.size, 2);
  s.setJSON = original;
  const complete = await writeParts(s, 'test', input, { maxBytes: 200 });
  assert.deepEqual(await readParts(s, 'test', complete), input);
});
test('a legacy single-Blob input still reads with its original hash; incomplete new parts never become the Job input', async () => {
  const api = require('../netlify/functions/trend-analysis-cache');
  const old = { selection: { selected: [{ keyword: '기존' }] }, calculationVersion: 1 };
  const s = store(), id = 'old', raw = { jobId:id, mode:'period', state:'running',
    workerLease:{token:'local-test-owner',fence:1,expiresAt:Date.now()+900000} };
  const local = { store:s, recoveryStore:{get:async()=>null} };
  await s.setJSON('old-ref',old,{onlyIfNew:true});
  assert.deepEqual(await api.readPeriodInputs({jobId:id,periodInputsKey:'old-ref',periodInputsHash:digest(old)},local),old);
  await s.setJSON('jobs/'+id,raw,{onlyIfNew:true});
  const underlying = s.get; s.get = async k => k.includes('/input-parts/') ? null : underlying(k);
  const lease = { jobId:id,...raw.workerLease };
  await assert.rejects(api.writePeriodInputs(lease,{array:Array.from({length:20},(_,i)=>i)},local),{code:'PERIOD_ARTIFACT_INTEGRITY'});
  assert.deepEqual(await s.get('jobs/'+id),raw);
  assert.equal([...s.records.keys()].some(k=>k.includes('/inputs/')),false);
});
test('frozen Period inputs preserve selected order, prior signals, actual matching window, empty/missing and product version', () => {
  const period = '2026-11-01', startDate = '2026-11-01', endDate = '2026-11-02', queryStartDate='2026-10-03';
  const record = (end, fetchedAt, rawRatioSeries) => ({ timeUnit:'date', version:1, normalizationVersion:'keyword-v1',
    requestStartDate:queryStartDate,requestEndDate:end,fetchedAt,rawRatioSeries });
  const source = new Map([['가', { search:record('2026-11-01','2026-11-02T05:10:00Z',[]), searchWindows:{
    older:record(endDate,'2026-11-02T04:00:00Z',[{ period,ratio:11 }]),
    usable:record(endDate,'2026-11-02T05:00:00Z',[{ period,ratio:44 }]) }}],
    ['나', {search:record(endDate,'2026-11-02T05:00:00Z',[])}]]);
  const job = { startDate, endDate, queryStartDate }, selection = { selected: [{keyword:'가'}, {keyword:'나'}], ratioOnly:[{keyword:'다'}] };
  const priorSignals = new Map([['가',{estimatedSurgeCount:321}], ['제외',{estimatedSurgeCount:999}]]);
  const history = [{earlySignalDate:period, normalizedKeyword:'가'}], productCache = {version:17,refreshedAt:'as-saved',items:[]};
  const result = freezePeriodCalculationInputs({ job, calculationVersion:1, productCache, candidateCache:{refreshedAt:'previous-day', candidates:[]},
    marketCache:{items:[{},{}]},selection, priorSignals, earlyCache:{history}, surgeHistoryCache:{manifest:{},records:new Map()}, seriesCache:{entries:source,manifest:{}},
    collectionSummary:{ apiMetrics:{},trendCollectedAt:null } });
  assert.equal(result.sourceMetadata.productRefreshedAt, productCache.refreshedAt);
  assert.equal(result.sourceMetadata.productVersion, 17);
  assert.equal(result.marketCache.frozenItemCount, 2); assert.deepEqual(result.earlyCache.history,history);
  assert.equal(result.selection,selection); assert.deepEqual(result.priorSignalCache.items,[{keyword:'가',estimatedSurgeCount:321}]);
  for (const k of ['가','나','다']) {
    const args = [k,'search','beauty',queryStartDate,endDate,new Date('2026-11-03')];
    assert.deepEqual(lookup(new Map(result.seriesCache.entries), ...args), lookup(source, ...args));
  }
});
