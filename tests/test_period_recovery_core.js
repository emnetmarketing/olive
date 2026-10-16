const test=require('node:test'); const assert=require('node:assert/strict');
const core=require('../netlify/functions/period-recovery-core');
const {calculatePeriodMarketConfidence,buildPeriodMarketEvidence}=require('../netlify/functions/period-market-evidence');
function fixture() {
  const numericCandidates=Array.from({length:4850},(_,i)=>({keyword:`candidate${i}`,sources:[]}));
  const ratioCandidates=Array.from({length:150},(_,i)=>({keyword:`ratio${i}`,sources:[]}));
  const all=[...numericCandidates,...ratioCandidates];
  return {generation:123,job:{jobId:'test',mode:'period',startDate:'2026-10-01',endDate:'2026-10-16',queryStartDate:'2026-09-16',surgeThreshold:300,matchThreshold:40},
    checkpoint:{jobId:'test',selectedStartDate:'2026-10-01',selectedEndDate:'2026-10-16',queryStartDate:'2026-09-16',requiredWindow:'2026-09-16:2026-10-16',
      eligibleKeywords:numericCandidates.map(c=>c.keyword),calculationCursor:4000,rows:[],calculated:[],analysisTrace:[],funnel:{},matchedDiagnostics:[],boundaryRelated:[]},
    numericCandidates,ratioCandidates,trendEntries:Object.fromEntries(all.map(c=>[c.keyword,{series:[{period:'2026-10-14',ratio:100}]}])),
    productCache:{items:[]},earlyCache:{history:[]},priorSignals:{},shoppingEntries:{}};
}
test('resume cursor4000 processes only remaining850 plus150 ratio in bounded invocations',()=>{
  const input=fixture();let state=core.initialState(input);const seen=[];
  const calculate=(candidate)=>seen.push(candidate.keyword);
  let invocations=0;
  while(['numeric','ratio'].includes(state.stage)){state=core.advance(input,state,{calculate}); invocations++;}
  assert.equal(invocations,5);assert.equal(seen.length,1000);assert.equal(new Set(seen).size,1000);
  assert.equal(seen[0],'candidate4000');assert.equal(state.calculationCursor,4850);assert.equal(state.ratioCursor,150);
});
test('original saved checkpoint is immutable and failing candidate does not commit a cursor',()=>{
  const input=fixture(),state=core.initialState(input),before=JSON.stringify(state);
  assert.throws(()=>core.advance(input,state,{calculate(){throw Error('interrupt');}}),/interrupt/);
  assert.equal(JSON.stringify(state),before);assert.equal(input.checkpoint.calculationCursor,4000);
});
test('safe time stops numeric chunk well before runtime hard limit',()=>{
  const input=fixture(),state=core.initialState(input);let clock=0;
  const next=core.advance(input,state,{now:()=>clock+=100000,calculate(){}});
  assert.equal(next.calculationCursor,4001);assert.ok(core.SAFE_EXECUTION_MS<7*60000);
});
test('cache missing or changed frozen inputs abort instead of provider fallback',()=>{
  const input=fixture(),state=core.initialState(input); delete input.trendEntries.candidate4001;
  assert.throws(()=>core.advance(input,state),/RECOVERY_CACHE_MISSING/);
  input.trendEntries.candidate4001={series:[]};assert.throws(()=>core.advance(input,state),/RECOVERY_INPUT_CHANGED/);
});
test('postprocessing resumes independently and retains exact existing confidence calculation',()=>{
  const input=fixture();const state=core.initialState(input);state.stage='evidence';
  state.rows=[{keyword:'candidate1',resultType:'product_match',estimatedSurgeCount:900,peakRelativeLiftPct:180,match:{score:80},sources:[]}];
  const expected=calculatePeriodMarketConfidence(state.rows[0],buildPeriodMarketEvidence('candidate1',input.job.startDate,input.job.endDate,[]),300);
  const next=core.advance(input,state);
  assert.equal(next.stage,'finalize');assert.equal(next.rows[0].periodMarketConfidenceScore,expected.periodMarketConfidenceScore);
  assert.equal(next.rows[0].estimatedSurgeCount,900);assert.equal(state.rows[0].periodMarketConfidenceScore,undefined);
});
test('final result honestly separates cache availability and actual data end',()=>{
  const input=fixture();input.trendEntries.candidate0={series:[]};
  const state=core.initialState(input);state.stage='finalize';state.rows=[{keyword:'a',estimatedSurgeCount:100},{keyword:'b',estimatedSurgeCount:300}];
  const next=core.advance(input,state);
  assert.equal(next.stage,'publishing');assert.equal(next.finalJob.state,'calculated');
  assert.equal(next.finalJob.trendCoveragePct,100);assert.equal(next.finalJob.emptySeriesCandidateCount,1);
  assert.equal(next.finalJob.validSeriesCandidateCount,4999);assert.equal(next.finalJob.actualDataEndDate,'2026-10-14');
  assert.equal(next.finalJob.endDate,'2026-10-16');assert.equal(next.snapshot.items[0].keyword,'b');
});
test('cache-only recovery module has no provider calls or Instant writes',()=>{
  const source=require('node:fs').readFileSync('netlify/functions/period-recovery-core.js','utf8');
  assert.doesNotMatch(source,/fetch\(|await api\(|writeSnapshot\(|writeDirty|writeSurgeHistory/);
});
test('actual record request window and digest are checked, not nonexistent date fields',()=>{
  const input=fixture();input.trendEntries.candidate4000={series:[],record:{source:'search',requestStartDate:'2026-10-01',requestEndDate:'2026-10-16',rawRatioSeries:[]}};
  assert.throws(()=>core.validate(input),/RECOVERY_CACHE_WINDOW_CHANGED/);
  input.trendEntries.candidate4000.record.requestStartDate='2026-09-16';
  assert.throws(()=>core.validate(input),/RECOVERY_CACHE_RECORD_CHANGED/);
});
