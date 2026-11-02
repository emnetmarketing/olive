/* Exercise the unmodified, isolated final ZIPs on captured production inputs.
   No production credentials or network access in any Lambda subprocess.
   With Node 22: --archives=DIR --source=CAPTURE --report=PATH. Use
   --reference for the old worker chain, --fault for the new isolated cron.
   Gate both with --check-report=NEW --reference-report=OLD --gate-report=OUT.
   The copied manifest contains immutable local source hashes, not credentials. */
'use strict';
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), crypto=require('node:crypto'), assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process'),{Writable}=require('node:stream'),{pathToFileURL}=require('node:url');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8')), json=(p,x)=>fs.writeFileSync(p,JSON.stringify(x));
const sha=x=>crypto.createHash('sha256').update(x).digest('hex'), id='bbbbbbbb-1234-4234-8234-123456789abc', d='trend-instant-dispatch-scheduled',w='trend-analysis-background';
const argv=k=>process.argv.find(s=>s.startsWith('--'+k+'='))?.slice(k.length+3);
const CREATED='2026-11-02T09:04:00.000Z';
function child(dir,role,index) {
 return (async()=>{
  assert.ok(process.execArgv.includes('--no-global-search-paths')); assert.equal(process.env.NODE_PATH,undefined);
  for(let at=dir;;at=path.dirname(at)){assert.equal(fs.existsSync(path.join(at,'node_modules')),false);if(at===path.dirname(at))break;}
  const cfg=read(path.join(dir,'fixture.json')),map=Object.fromEntries(cfg.manifest.rows.filter(r=>!r.missing).map(r=>[r.store+'/'+r.key,r.file]));
  const begin=performance.now(),epoch=read(path.join(dir,'clock.json')),RealDate=Date;global.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[epoch+performance.now()-begin]));}static now(){return epoch+performance.now()-begin;}};
  process.env.URL='https://isolated.netlify.app';delete process.env.NETLIFY_BLOBS_CONTEXT;delete globalThis.netlifyBlobsContext;
  for(const type of ['node:http','node:https']){const item=require(type);item.get=item.request=()=>{throw Error('Outside HTTP denied');};}
  const events=[],trace=(o)=>{fs.appendFileSync(path.join(dir,'events.ndjson'),JSON.stringify({role,index,ms:Math.round(performance.now()-begin),rss:process.memoryUsage().rss,heap:process.memoryUsage().heapUsed,...o})+'\n');};
  const fields=['event','stage','cursor','calculationCursor','ratioCursor','evidenceCursor','processedCount','totalCount','continuation','reason','errorCode','bytes','elapsedMs','parts','label','component','step'];
  console.log=value=>{try{const obj=typeof value==='string'?JSON.parse(value):value;if(obj?.event){events.push(obj.event);trace(Object.fromEntries(fields.filter(k=>obj[k]!=null).map(k=>[k,obj[k]])));}}catch{}};
  const src=k=>{const changed=path.join(dir,'writes',sha(k));return fs.existsSync(changed)?changed:map[k]?path.join(cfg.source,map[k]):null;};
  const perform=(s,k,value)=>{const p=path.join(dir,'writes',sha(s+'/'+k));fs.writeFileSync(p,value);return p;};
  let gets=0,puts=0,selfPosts=0,sourceAttempts=0,entryResult,crashEligible=false;
  global.fetch=async (input,options={})=>{
   const req=input instanceof Request?input:new Request(input,options),u=new URL(req.url);
   if(u.origin===process.env.URL&&u.pathname==='/.netlify/functions/'+w){
    if(role!==d){selfPosts++;if(!cfg.baseline)throw Error('Worker self-call not allowed');}
    const body=await req.json();assert.equal(body.jobId,id);json(path.join(dir,'ticket.json'),body);trace({event:'post-accepted',from:role});return new Response(null,{status:202});
   }
   if(!['https://edge.invalid','https://strong.invalid'].includes(u.origin)){sourceAttempts++;trace({event:'forbidden-external-request',host:u.hostname});throw Error('SOURCE_REQUEST_BLOCKED');}
   const m=decodeURIComponent(u.pathname).match(/^\/fixture-site\/site:([^/]+)\/(.+)$/);assert.ok(m,'unexpected fixture SDK URL '+u.pathname);const [,store,key]=m,k=store+'/'+key,p=src(k);const tag=p?'"'+(fs.existsSync(p+'.etag')?fs.readFileSync(p+'.etag','utf8'):sha(k+'-source'))+'"':null;
   if(['HEAD','GET'].includes(req.method)){gets++;if(!p)return new Response(null,{status:404});const size=fs.statSync(p).size;
    if(store==='trend-analysis'&&key.startsWith('jobs/'+id+'/'))trace({event:'artifact-read',key:key.replace(id,'JOB').slice(0,74),bytes:size});
    return new Response(req.method==='HEAD'?null:require('node:stream').Readable.toWeb(fs.createReadStream(p)),{headers:{etag:tag,'content-length':String(size)}});
   }
   const allowed=req.method==='PUT'&&(store==='trend-period-publications'||store==='trend-analysis'&&(key==='jobs/'+id||key.startsWith('jobs/'+id+'/')||key==='instant-dispatch/v1'||key==='current-job/v1'||cfg.baseline&&key==='diagnostics/latest-v1'));
   if(!allowed){trace({event:'forbidden-storage-write',store,key});throw Error('Unexpected write '+store+'/'+key);}
   if((req.headers.get('if-none-match')==='*'&&p)||(req.headers.has('if-match')&&req.headers.get('if-match')!==tag))return new Response(null,{status:412});
   const bytes=Buffer.from(await req.arrayBuffer()),newTag=crypto.randomUUID();const dest=perform(store,key,bytes);fs.writeFileSync(dest+'.etag',newTag);puts++;
   if(!fs.existsSync(dest+'.key'))json(dest+'.key',{store,key});
   if(store==='trend-analysis'&&key==='jobs/'+id){const j=JSON.parse(bytes);trace({event:'job-saved',stage:j.currentStage,progress:j.progress,cursor:j.calculationCursor??null,reference:!!j.calculationCheckpointKey,inputs:!!j.periodInputsKey});
    if(cfg.fault&&j.calculationCursor>0&&j.calculationCheckpointKey&&j.workerLease?.token&&!fs.existsSync(path.join(dir,'crash.json'))){crashEligible=true;json(path.join(dir,'crash.json'),{cursor:j.calculationCursor,checkpoint:j.calculationCheckpointKey,invocation:index,at:new Date().toISOString(),size:bytes.length});}}
   else if(store==='trend-analysis'&&key.startsWith('jobs/'+id+'/'))trace({event:'artifact-stored',key:key.replace(id,'JOB').slice(0,74),bytes:bytes.length});
   if(crashEligible){trace({event:'simulated-abrupt-stop-after-durable-checkpoint',peakRss:process.resourceUsage().maxRSS*1024});process.exit(86);}
   return new Response(null,{status:200,headers:{etag:'"'+newTag+'"'}});
  };
  global.awslambda={streamifyResponse:fn=>async(event,context)=>{const chunks=[],stream=new Writable({write(c,_,done){chunks.push(c);done();}});await fn(event,stream,context);return {status:stream.metadata?.statusCode||200,bytes:Buffer.concat(chunks)};},HttpResponseStream:{from(s,m){s.metadata=m;return s;}}};
  const entry=await import(pathToFileURL(path.join(dir,role,'___netlify-entry-point.mjs')).href);
  const ticket=role===w&&!cfg.baseline?read(path.join(dir,'active-ticket.json')):{jobId:id};
  const statusReader=role==='trend-analysis-status';
  const event={httpMethod:statusReader?'GET':'POST',rawUrl:process.env.URL+'/.netlify/functions/'+role+(statusReader?'?jobId='+id:''),headers:{'x-nf-site-id':'fixture-site','x-nf-deploy-id':'fixture-deploy',host:'isolated.netlify.app'},body:statusReader?undefined:JSON.stringify(role===d?{next_run:new Date(Date.now()+120000).toISOString()}:ticket),isBase64Encoded:false,blobs:Buffer.from(JSON.stringify({url:'https://edge.invalid',url_uncached:'https://strong.invalid',token:'fixture-only'})).toString('base64')};
  const res=await entry.handler(event,{awsRequestId:'independent-'+role+'-'+index,getRemainingTimeInMillis:()=>900000-(performance.now()-begin)});
  if(statusReader){const data=JSON.parse(res.bytes);assert.equal(data.jobId,id);assert.equal(data.state,'completed');entryResult={jobId:data.jobId,rows:data.results.length,sha256:sha(JSON.stringify(data.results)),latestDataDate:data.latestDataDate};}
  trace({event:'invocation-returned',status:res.status,peakRss:process.resourceUsage().maxRSS*1024,sourceAttempts,selfPosts,gets,puts,entryResult}); assert.equal(sourceAttempts,0);
  if(!cfg.baseline)assert.equal(selfPosts,0);
 })();
}
async function parent(){
 const archive=path.resolve(argv('archives')),source=path.resolve(argv('source')),out=path.resolve(argv('report'));
 const artifacts={},manifest=read(path.join(source,'manifest.json')),dir=fs.mkdtempSync(path.join(os.tmpdir(),'netlify-period-scaletest-')),reference=process.argv.includes('--reference'),baseline=process.argv.includes('--baseline')||reference,fault=process.argv.includes('--fault');
 console.log(JSON.stringify({isolatedDirectory:dir,sourceObjects:manifest.rows.length}));
 const extract=require('./verify-packaged-functions.cjs').zipEntries;
 for(const role of [w,d,'trend-analysis-status']){const bytes=fs.readFileSync(path.join(archive,role+'.zip'));artifacts[role]=sha(bytes);for(const entry of extract(bytes)){const dest=path.resolve(dir,role,entry.name);assert.ok(dest.startsWith(path.join(dir,role)+path.sep));assert.notEqual(entry.mode&0xf000,0xa000);if(entry.name.endsWith('/')){fs.mkdirSync(dest,{recursive:true});continue;}fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,entry.bytes);}}
 for(const r of manifest.rows.filter(r=>!r.missing))assert.equal(sha(fs.readFileSync(path.join(source,r.file))),r.sha256);
 const cfg={source,manifest,baseline,fault};json(path.join(dir,'fixture.json'),cfg);fs.copyFileSync(__filename,path.join(dir,'fixture.cjs'));fs.mkdirSync(path.join(dir,'writes'));
 const write=(s,k,x)=>json(path.join(dir,'writes',sha(s+'/'+k)),x),get=(s,k)=>read(path.join(dir,'writes',sha(s+'/'+k)));
 const orig=read(path.join(source,'trend-analysis/jobs/6e181a88-8c63-42d5-918e-47861c83fc47.json'));
 const j={jobId:id,mode:'period',state:'running',fastPath:true,historicalCollection:false,createdAt:CREATED,updatedAt:CREATED,
  startDate:orig.startDate,endDate:orig.endDate,queryStartDate:orig.queryStartDate,surgeThreshold:orig.surgeThreshold,matchThreshold:orig.matchThreshold,
  progress:1,currentStage:'preparing',processedCount:0,totalCount:0,triggerSource:'cache-only-recovery',cacheOnlyRecovery:true,recoveryOfJobId:orig.jobId};
 const ticket=crypto.randomUUID();if(!baseline)Object.assign(j,{periodDispatchVersion:1,continuationDispatch:{ticket,state:'pending',number:0,requestedAt:CREATED,readyAt:CREATED,attemptCount:0,expectedInputsHash:null,minimumCursor:0}});
 write('trend-analysis','jobs/'+id,j);if(!baseline)write('trend-analysis','instant-dispatch/v1',{version:1,jobs:[{jobId:id,mode:'period',createdAt:CREATED}]});
 const env={...process.env};for(const k of Object.keys(env))if(/TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|NODE_PATH|NODE_OPTIONS|NAVER|YOUTUBE|SEARCH_AD/i.test(k))delete env[k];let epoch=Date.parse(CREATED),sequence=0,error=null;
 const invoke=role=>{json(path.join(dir,'clock.json'),epoch);const p=spawnSync(process.execPath,['--no-global-search-paths',path.join(dir,'fixture.cjs'),'--child',dir,role,String(++sequence)],{cwd:dir,env,encoding:'utf8',timeout:600000,maxBuffer:1e6});epoch+=120000;const after=get('trend-analysis','jobs/'+id);console.log(JSON.stringify({sequence,role,code:p.status,stage:after.currentStage,cur:after.calculationCursor,state:after.state,err:p.stderr?.slice(-650)}));if(p.status===86){assert.ok(fault);epoch+=13*60000;return;}if(p.status!==0)throw Error('Isolated child exit: '+p.status+' '+(p.error?.message||p.stderr?.slice(-800)));};
 try{if(baseline){invoke(w);if(reference){for(let t=0;t<30&&get('trend-analysis','jobs/'+id).state!=='completed';t++){assert.ok(fs.existsSync(path.join(dir,'ticket.json')),'Reference worker did not schedule continuation');fs.unlinkSync(path.join(dir,'ticket.json'));invoke(w);}assert.equal(get('trend-analysis','jobs/'+id).state,'completed');invoke('trend-analysis-status');}}else{for(let t=0;t<48;t++){invoke(d);if(fs.existsSync(path.join(dir,'ticket.json'))){fs.copyFileSync(path.join(dir,'ticket.json'),path.join(dir,'active-ticket.json'));fs.unlinkSync(path.join(dir,'ticket.json'));invoke(w);}const job=get('trend-analysis','jobs/'+id);if(job.state==='completed')break;if(['failed','interrupted','continuation_failed'].includes(job.state))throw Error('Incomplete '+job.state+':'+job.message);}
  const after=get('trend-analysis','jobs/'+id);assert.equal(after.state,'completed');assert.ok(after.results.length);assert.equal(after.mode,'period');assert.equal(after.startDate,j.startDate);assert.equal(after.endDate,j.endDate);
  const commitment=get('trend-period-publications','published-jobs/'+id);assert.equal(commitment.jobId,id);const body=get('trend-period-publications',commitment.bodyKey),snap=get('trend-period-publications',commitment.snapshotKey);assert.deepEqual(body.results,after.results);assert.deepEqual(snap.items.map(r=>r.keyword),after.results.map(r=>r.keyword));assert.equal(get('trend-period-publications','latest-v1').jobId,id);invoke('trend-analysis-status');
  if(fault){const record=read(path.join(dir,'crash.json'));assert.ok(record.cursor>0);const tx=fs.readFileSync(path.join(dir,'events.ndjson'),'utf8').trim().split('\n').map(JSON.parse);assert.ok(tx.some(e=>e.index>record.invocation&&e.role===w&&e.event==='invocation-entered'&&e.cursor===record.cursor),'No actual continuation entering saved cursor');}}}catch(e){error=e.message;}
 const raw=get('trend-analysis','jobs/'+id),events=fs.existsSync(path.join(dir,'events.ndjson'))?fs.readFileSync(path.join(dir,'events.ndjson'),'utf8').trim().split('\n').map(JSON.parse):[];
 if(!baseline&&!error)saveGateFacts(dir,out);
 const report={dir,artifacts,manifestSha:sha(fs.readFileSync(path.join(source,'manifest.json'))),mode:baseline?'old-package-first-invocation':'final-cache-only-period',fault,
   events,externalRequests:events.filter(e=>e.event==='forbidden-external-request').length,job:{id,stage:raw.currentStage,state:raw.state,inputs:raw.periodInputsKey,checkpoint:raw.calculationCheckpointKey,cursor:raw.calculationCursor,resultCount:raw.results?.length,resultHash:raw.results&&sha(JSON.stringify(raw.results)),actual:raw.latestDataDate,coverage:raw.trendCoveragePct,diagnosticCounts:raw.diagnostic?.funnel?.candidates},error};
 json(out,report);console.log(JSON.stringify({out,state:report.job.state,rows:report.job.resultCount,error}));if(error)process.exitCode=1;
}
function saveGateFacts(dir,out) {
 const get=(s,k)=>read(path.join(dir,'writes',sha(s+'/'+k))),job=get('trend-analysis','jobs/'+id);
 assert.equal(job.state,'completed');
 const cp=get('trend-analysis',job.calculationCheckpointKey),receipt=get('trend-period-publications','published-jobs/'+id);
 const fields=['analyzedCandidateCount','resultCount','actualDataStartDate','actualDataEndDate','trendAvailableCount','analyzablePeriodCandidateCount','emptySeriesCandidateCount','baselineOnlyCandidateCount','missingPeriodCacheCount','endDateObservedCandidateCount','startDate','endDate'];
 json(out+'.facts.json',{job:Object.fromEntries(fields.map(k=>[k,job[k]])),cp:{totalCount:cp.totalCount,calculationCursor:cp.calculationCursor,ratioCursor:cp.ratioCursor,evidenceCursor:cp.evidenceCursor},receipt,crash:fs.existsSync(path.join(dir,'crash.json'))?read(path.join(dir,'crash.json')):null,evidenceVerified:job.results.every(row=>row.periodMarketEvidence!=null&&Number.isFinite(row.periodMarketConfidenceScore)&&Array.isArray(row.periodMarketConfidenceReasons))});
}
// Release gate: compare *every ordered result object* against the old deployed
// engine on exactly the same captured store hashes. Separate cache coverage,
// in-period observations, and final rows; no synthetic padding dates.
async function checkReport() {
 const current=read(argv('check-report')), reference=read(argv('reference-report'));
 assert.equal(current.error,null);assert.equal(reference.error,null);assert.equal(current.manifestSha,reference.manifestSha);
 assert.equal(current.job.state,'completed');assert.equal(current.job.resultHash,reference.job.resultHash);
 assert.equal(current.job.resultCount,reference.job.resultCount);assert.equal(current.externalRequests,0);
 assert.ok(!current.events.some(e=>e.event==='forbidden-storage-write'));
 const {job:j,cp,receipt,crash,evidenceVerified}=read(argv('check-report')+'.facts.json');
 assert.equal(cp.totalCount,cp.calculationCursor);assert.equal(cp.calculationCursor+cp.ratioCursor,j.analyzedCandidateCount);
 assert.equal(j.analyzedCandidateCount,5000);assert.ok(cp.evidenceCursor<=j.resultCount&&j.resultCount-cp.evidenceCursor<50);
 assert.ok(evidenceVerified);
 assert.equal(j.analyzablePeriodCandidateCount+j.emptySeriesCandidateCount+j.baselineOnlyCandidateCount+j.missingPeriodCacheCount,5000);
 const reader=current.events.find(e=>e.role==='trend-analysis-status'&&e.entryResult)?.entryResult;
 const referenceReader=reference.events.find(e=>e.role==='trend-analysis-status'&&e.entryResult)?.entryResult;
 assert.ok(reader&&referenceReader,'Both ZIPs must execute the actual display-projection entry');assert.deepEqual(reader,referenceReader);
 assert.equal(reader.rows,j.resultCount);assert.equal(reader.jobId,id);
 const workers=current.events.filter(e=>e.role===w&&['invocation-returned','simulated-abrupt-stop-after-durable-checkpoint'].includes(e.event));
 // The loop starts saving at seven minutes. Measure the whole invocation,
 // including verification and lease release, with one minute for that tail.
 assert.ok(workers.length>=3);assert.ok(workers.every(e=>e.ms<480000&&e.peakRss<1024*1048576),'A packaged period worker exceeded the safe execution or maximum memory boundary');
 const events=current.events.filter(e=>e.role===w&&e.event==='invocation-entered').map(e=>({invocation:e.index,cursor:e.cursor}));
 assert.ok(events.some(e=>e.invocation>crash.invocation&&e.cursor===crash.cursor));
 const report={sourceManifestSha:current.manifestSha,archives:current.artifacts,sourceRequests:current.externalRequests,
  candidateCount:j.analyzedCandidateCount,numeric:cp.calculationCursor,ratio:cp.ratioCursor,evidence:j.resultCount,lastEvidenceCheckpoint:cp.evidenceCursor,
  start:j.startDate,end:j.endDate,actualStart:j.actualDataStartDate,actualEnd:j.actualDataEndDate,cacheHit:j.trendAvailableCount,
  usable:j.analyzablePeriodCandidateCount,empty:j.emptySeriesCandidateCount,past:j.baselineOnlyCandidateCount,miss:j.missingPeriodCacheCount,endDateObserved:j.endDateObservedCandidateCount,
  resultCount:j.resultCount,originalOrderedResultHash:reference.job.resultHash,recoveredOrderedResultHash:current.job.resultHash,receipt:{jobId:receipt.jobId,bodyHash:receipt.bodyHash,snapshotHash:receipt.snapshotHash},
  recovery:{crashCursor:crash.cursor,entries:events},originalPackagedStatus:referenceReader,packagedStatus:reader,
  workers:workers.map(e=>({invocation:e.index,elapsedMs:e.ms,heapMiB:Math.round(e.heap/1048576),peakRssMiB:Math.round(e.peakRss/1048576),outcome:e.event}))};
 if(argv('gate-report'))json(argv('gate-report'),report);console.log(JSON.stringify(report));
}
if(require.main===module)(process.argv[2]==='--child'?child(process.argv[3],process.argv[4],Number(process.argv[5])):argv('check-report')?checkReport():parent()).catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={saveGateFacts};
