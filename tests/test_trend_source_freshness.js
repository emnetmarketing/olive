const test = require('node:test');
const assert = require('node:assert/strict');
const cache = require('../netlify/functions/trend-series-cache');
const now = new Date('2026-10-16T09:30:00Z');
const make = (series, fetchedAt='2026-10-15T21:12:00Z', endDate='2026-10-16') => {
  const entries = new Map(); cache.upsert(entries,{keyword:'fixture',source:'search',startDate:'2026-09-16',endDate,series,fetchedAt});
  return entries.values().next().value.search;
};
test('same-day window hit does not prove target-date freshness: Production regression',()=>{
  const record=make([{period:'2026-10-14',ratio:30}]);
  assert.equal(cache.validSeriesRecord(record,'2026-09-16','2026-10-16',now),true);
  const fresh=cache.assessSearchFreshness(record,'2026-09-16','2026-10-16',now);
  assert.equal(fresh.targetDataDate,'2026-10-15');assert.equal(fresh.actualDataDate,'2026-10-14');assert.equal(fresh.needsRefresh,true);
});
test('actual target observation reuses current cache without collection',()=>{
  const result=cache.assessSearchFreshness(make([{period:'2026-10-15',ratio:10}]),'2026-09-16','2026-10-16',now);
  assert.equal(result.state,'target-current');assert.equal(result.needsRefresh,false);
});
test('recent delayed response has bounded cooldown and does not loop',()=>{
  const record=make([{period:'2026-10-14',ratio:10}],now.toISOString());
  assert.equal(cache.assessSearchFreshness(record,'2026-09-16','2026-10-16',now).needsRefresh,false);
  assert.equal(cache.assessSearchFreshness(record,'2026-09-16','2026-10-16',new Date(now.getTime()+2*3600000)).needsRefresh,true);
});
test('empty upstream series remains reusable and never becomes fabricated target data',()=>{
  const record=make([],now.toISOString());const result=cache.assessSearchFreshness(record,'2026-09-16','2026-10-16',now);
  assert.equal(result.state,'empty-response');assert.equal(result.needsRefresh,false);assert.equal(result.actualDataDate,null);
});
test('settled exact historical sparse/empty windows remain reusable',()=>{
  for(const series of [[],[{period:'2026-09-28',ratio:20}]]){
    const record=make(series,'2026-10-05T00:00:00Z','2026-09-30');
    assert.equal(cache.assessSearchFreshness(record,'2026-09-16','2026-09-30',now).needsRefresh,false);
    assert.equal(cache.validSeriesRecord(record,'2026-09-16','2026-09-30',now),true);
  }
});
test('recent incomplete response does not become permanently complete just by aging',()=>{
  const record=make([{period:'2026-09-28',ratio:10}],'2026-09-30T00:00:00Z','2026-09-30');
  assert.equal(cache.assessSearchFreshness(record,'2026-09-16','2026-09-30',now).needsRefresh,true);
});
test('cache coverage and actual target observation coverage are separate; ratios untouched',()=>{
  const series=new Map([['a',[{period:'2026-10-15',ratio:4}]],['b',[{period:'2026-10-14',ratio:9}]],['c',[]]]);
  const before=JSON.stringify([...series]);const result=cache.summarizeDateCoverage(series,'2026-10-16',3,now);
  assert.equal(result.cacheAvailableCount,3);assert.equal(result.validSeriesCount,2);assert.equal(result.emptySeriesCount,1);
  assert.equal(result.targetDataCandidateCount,1);assert.equal(result.targetDataCoveragePct,33.33);
  assert.equal(result.actualDataDate,'2026-10-15');assert.equal(JSON.stringify([...series]),before);
});
test('Instant collector stops before hard limit and preserves Period collection policy',()=>{
  const {collectionTimeExceeded}=require('../netlify/functions/trend-analysis-background')._test;
  assert.equal(collectionTimeExceeded('instant',1000,180999),false);
  assert.equal(collectionTimeExceeded('instant',1000,181000),true);
  assert.equal(collectionTimeExceeded('period',1000,500000),false);
});
test('08:00 recovery does not mistake delayed 06:00 collection for target-date completion',()=>{
  const {collectedToday}=require('../netlify/functions/trend-scheduled-runner');
  const time=new Date('2026-10-16T00:00:00Z');
  const collection={collectedAt:'2026-10-15T21:05:00Z',latestDataDate:'2026-10-14'};
  assert.equal(collectedToday(collection,time),false);
  collection.latestDataDate='2026-10-15';assert.equal(collectedToday(collection,time),true);
  collection.sourceFreshness={refreshPendingCount:100};assert.equal(collectedToday(collection,time),false);
});
