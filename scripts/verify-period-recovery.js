#!/usr/bin/env node
'use strict';
// GET/HEAD-only post-publication verification. Excel is built locally without
// creating a download history record or invoking an application write endpoint.
const fs=require('node:fs'),path=require('node:path');const assert=require('node:assert/strict');
const {getStore}=require('@netlify/blobs');const {buildWorkbook}=require('../netlify/functions/unified-excel');
const {digest}=require('../netlify/functions/period-publication');
const ROOT=path.resolve(__dirname,'..'),SITE='dc4e873a-5b98-40de-a2f8-9c36e9f7e8bc';
async function main(){const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i].slice(2)]=process.argv[i+1];
  const file=path.resolve(ROOT,args.input||'');assert.ok(file.startsWith(path.join(ROOT,'data')+path.sep));
  const input=JSON.parse(fs.readFileSync(file));const baselineFile=file+'.protected.json';
  const cfg=JSON.parse(fs.readFileSync(path.join(process.env.APPDATA,'netlify/Config/config.json')));
  const token=cfg.users[cfg.userId].auth.token;const native=fetch;
  const readFetch=(url,options={})=>{const u=new URL(url);assert.ok(['GET','HEAD'].includes(String(options.method||'GET').toUpperCase()));
    assert.ok(u.protocol==='https:'&&(u.hostname.endsWith('.netlify.com')||u.hostname.endsWith('.netlify.app')||u.hostname.endsWith('.netlifyblob.com')||u.hostname.endsWith('.amazonaws.com')));
    return native(url,{...options,redirect:'error',signal:AbortSignal.timeout(45000)});};
  const store=name=>getStore({name,siteID:SITE,token,consistency:'strong',fetch:readFetch});
  const keys=[['trend-analysis','current-job/v1'],['trend-analysis','last-success/instant'],['trend-analysis','last-partial/instant'],
    ['trend-analysis','signals/current'],['trend-signal-snapshots','latest-valid-v1/instant'],['trend-signal-snapshots','latest-collection-v1'],
    ['today-early-signals','current-v1'],['keyword-candidates','current-v5'],['search-ad-products','current'],['market-discovery','current-v1'],
    ['trend-api-quota','usage-v1'],['trend-series-cache','manifest-v1'],...Array.from({length:32},(_,i)=>['trend-series-cache',`shards/v1/${i}`])];
  const baseline=fs.existsSync(baselineFile)?JSON.parse(fs.readFileSync(baselineFile)):null;
  let protectedKeys=baseline?.keys||keys;
  if(!baseline){
    const [instant,period]=await Promise.all([readFetch('https://olive-trend-monitor.netlify.app/.netlify/functions/signal-snapshot-latest?mode=instant'),
      readFetch('https://olive-trend-monitor.netlify.app/.netlify/functions/signal-snapshot-latest?mode=period')]);
    assert.equal(instant.status,200);assert.equal(period.status,200);
    for(const snapshot of [await instant.json(),await period.json()])protectedKeys.push(['trend-analysis',`jobs/${snapshot.jobId}`],['trend-signal-snapshots',`snapshots/${snapshot.jobId}`]);
  }
  const etags={};for(const [name,key] of protectedKeys)etags[`${name}:${key}`]=(await store(name).getMetadata(key))?.etag||null;
  if(args.phase==='before'){assert.ok(!baseline,'Do not overwrite protection baseline');fs.writeFileSync(baselineFile,JSON.stringify({keys:protectedKeys,etags}),{flag:'wx'});
    console.log(JSON.stringify({protectedObjects:protectedKeys.length,sourceApiCalls:0,productionWrites:0}));return;}
  assert.ok(baseline,'Protection baseline required');
  const changes=Object.keys(etags).filter(k=>etags[k]!==baseline.etags[k]);
  const readEndpoint=async route=>{const r=await readFetch(`https://olive-trend-monitor.netlify.app/.netlify/functions/${route}`);assert.equal(r.status,200,route);return r.json();};
  const [job,latest,snapshot]=await Promise.all([readEndpoint(`trend-analysis-status?jobId=${input.job.jobId}`),
    readEndpoint('trend-analysis-latest?mode=period&result=full'),readEndpoint('signal-snapshot-latest?mode=period')]);
  for(const value of [job,latest,snapshot])assert.equal(value.jobId,input.job.jobId);
  assert.equal(job.state,'completed');assert.equal(job.startDate,input.job.startDate);assert.equal(job.endDate,input.job.endDate);
  assert.equal(job.results.length,snapshot.items.length);assert.equal(digest(job.results),digest(latest.results));
  const exact=await store('trend-period-publications').get(`published-jobs/${job.jobId}`,{type:'json'});
  assert.equal(exact.jobId,job.jobId);
  const workbook=await buildWorkbook({periodJob:job,periodRequest:{startDate:job.startDate,endDate:job.endDate},instantJob:{results:[]},early:{items:[]},discoveries:[]});
  const sheet=workbook.getWorksheet('07_선택기간분석');assert.ok(sheet);assert.equal(sheet.rowCount-11,job.results.length);
  job.results.forEach((row,i)=>assert.equal(sheet.getCell(i+12,3).value,row.keyword));
  const summary=workbook.getWorksheet('00_요약');const summaryRows=[];summary.eachRow(r=>summaryRows.push(r.values));
  assert.ok(summaryRows.some(r=>r[1]==='선택 기간 결과 건수'&&r[2]===job.results.length));
  const report={jobId:job.jobId,state:job.state,publicationState:job.publicationState,requested:[job.startDate,job.endDate],
    actualData:[job.actualDataStartDate,job.actualDataEndDate],cacheHits:job.cacheHitCount,validSeries:job.validSeriesCandidateCount,
    emptySeries:job.emptySeriesCandidateCount,results:job.results.length,publishedAt:job.publishedAt,
    snapshotPointerApiExcelMatch:true,protectedObjects:protectedKeys.length,changedProtectedObjects:changes,sourceApiCalls:0,productionWrites:0};
  fs.writeFileSync(file+'.verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  assert.equal(changes.length,0,'Protected data changed; inspect before claiming isolation');
}
main().catch(error=>{console.error('Verification failed: '+String(error.message).replace(/https?:\/\/\S+/g,'[URL omitted]'));process.exitCode=1;});
