#!/usr/bin/env node
'use strict';
// Explicit operator recovery, not an analysis/collection entrypoint. Each child
// is one bounded cache-only invocation, with durable checkpoints between them.
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');const {getStore}=require('@netlify/blobs');
const core=require('../netlify/functions/period-recovery-core');
const stateStore=require('../netlify/functions/period-recovery-state');
const publication=require('../netlify/functions/period-publication');
const ROOT=path.resolve(__dirname,'..');const SITE='dc4e873a-5b98-40de-a2f8-9c36e9f7e8bc';
function argsFor(argv){const args={};for(let i=0;i<argv.length;i+=2)args[argv[i].replace(/^--/,'')]=argv[i+1];
  if(!['dry','production'].includes(args.mode))throw Error('--mode dry|production required');
  const file=path.resolve(ROOT,args.input||'');if(!file.startsWith(path.join(ROOT,'data')+path.sep))throw Error('Only pinned ignored data input allowed');
  return {...args,input:file};}
function guardNetwork(){const original=global.fetch;const audit={sourceCalls:0,blocked:0,storageRequests:0};
  global.fetch=async(input,options={})=>{const url=new URL(input);const method=String(options.method||'GET').toUpperCase();
    if(url.protocol!=='https:'||!['GET','HEAD','PUT'].includes(method)
      ||!(url.hostname==='api.netlify.com'||url.hostname.endsWith('.netlify.com')||url.hostname.endsWith('.netlifyblob.com')||url.hostname.endsWith('.amazonaws.com'))
      ||url.pathname.includes('/.netlify/functions/')){audit.blocked++;throw Error('RECOVERY_NETWORK_DENIED');}
    audit.storageRequests++;return original(input,{...options,redirect:'error',signal:options.signal||AbortSignal.timeout(60000)});};return audit;}
function stores(){const cfg=JSON.parse(fs.readFileSync(path.join(process.env.APPDATA,'netlify/Config/config.json'),'utf8'));
  const token=cfg.users[cfg.userId].auth.token;const make=name=>getStore({name,siteID:SITE,token,consistency:'strong',fetch:global.fetch});
  return {recovery:make(stateStore.STORE_NAME),publication:make(publication.STORE_NAME),analysis:make('trend-analysis'),token};}
const brief=(state,extra={})=>({stage:state.stage,cursor:state.calculationCursor,ratio:state.ratioCursor,evidence:state.evidenceCursor,
  resultCount:state.rows?.length,continuation:state.continuationCount,...extra});
async function main(){const args=argsFor(process.argv.slice(2));
  const input=JSON.parse(fs.readFileSync(args.input,'utf8'));input.generation=Date.parse(input.capturedAt);
  if(!Number.isSafeInteger(input.generation))throw Error('CAPTURE_GENERATION_MISSING');core.validate(input);
  const jobId=input.job.jobId;const generation=String(input.generation);const dryFile=args.input+'.dry-state.json';
  if(args.mode==='dry')global.fetch=async()=>{throw Error('DRY_NETWORK_DENIED');};
  const network=args.mode==='production'?guardNetwork():{sourceCalls:0,storageRequests:0};
  const prod=args.mode==='production'?stores():null;
  const deps=prod?{store:prod.recovery,frozen:input}:null;
  if(args.worker==='yes'){
    const invocationId=crypto.randomUUID();
    let lease;
    try{
      const current=prod?await stateStore.claim(jobId,{invocationId,generation},deps):{state:JSON.parse(fs.readFileSync(dryFile,'utf8'))};
      lease=current.lease;let next;
      if(current.state.stage==='publishing'){
        if(prod){
          const published=await publication.publishPeriod({job:current.state.finalJob,snapshot:current.state.snapshot,
            generation:input.generation,leaseToken:lease.token},{store:prod.publication,
            assertLease:()=>stateStore.assertLease(jobId,generation,lease.token,deps)});
          const latest=await publication.readLatest({store:prod.publication});
          if(published.job.jobId!==jobId||published.snapshot.items.length!==current.state.rows.length
            ||!published.publishedAsLatest||latest?.job.jobId!==jobId)throw Error('PUBLICATION_VERIFICATION_FAILED');
        }
        next={...current.state,stage:'completed',publicationVerified:true};
      }else next=core.advance(input,current.state);
      if(prod){const saved=await stateStore.checkpoint(jobId,lease,next,deps);lease=saved.lease;
        if(lease){await stateStore.appendTrace(jobId,lease,{event:'next-invocation-ready',continuationNumber:next.continuationCount+1},deps);
          await stateStore.release(jobId,lease,{},deps);}}
      else fs.writeFileSync(dryFile,JSON.stringify(next));
      console.log(JSON.stringify(brief(next,{jobId,invocationId,sourceApiCalls:0,storageRequests:network.storageRequests})));
    }catch(error){if(prod&&lease)await stateStore.markFailure(jobId,lease,error,deps).catch(()=>null);throw error;}
    return;
  }
  if(prod){
    if(!/^[0-9a-f]{40}$/.test(args['expect-commit']||''))throw Error('--expect-commit is required for Production');
    const response=await fetch(`https://api.netlify.com/api/v1/sites/${SITE}`,{headers:{Authorization:`Bearer ${prod.token}`}});
    if(!response.ok)throw Error(`DEPLOY_READ_${response.status}`);const site=await response.json();
    if(site.published_deploy?.commit_ref!==args['expect-commit']||site.published_deploy?.state!=='ready')throw Error('PRODUCTION_COMMIT_NOT_READY');
    const raw=await prod.analysis.get(`jobs/${jobId}`,{type:'json'});
    const cp=await prod.analysis.get(input.job.checkpointKey,{type:'json'});
    if(!raw||raw.mode!=='period'||raw.jobId!==jobId||raw.surgeThreshold!==input.job.surgeThreshold||raw.matchThreshold!==input.job.matchThreshold
      ||raw.startDate!==input.job.startDate||raw.endDate!==input.job.endDate||raw.queryStartDate!==input.job.queryStartDate
      ||publication.digest(cp)!==publication.digest(input.checkpoint))throw Error('ORIGINAL_CHECKPOINT_CHANGED');
    if(raw.state==='running'&&Date.now()-Date.parse(raw.updatedAt)<12*60000)throw Error('ORIGINAL_WORKER_RECENTLY_ACTIVE');
    const initial=core.initialState(input);initial.generation=generation;initial.inputHash=stateStore.hashValue(input);
    await stateStore.initialize(jobId,input,initial,deps);
  }else if(!fs.existsSync(dryFile))fs.writeFileSync(dryFile,JSON.stringify(core.initialState(input)),{flag:'wx'});
  for(let invocation=0;invocation<60;invocation++){
    const current=prod?(await stateStore.read(jobId,deps)).state:JSON.parse(fs.readFileSync(dryFile,'utf8'));
    if(current.stage==='completed'){console.log(JSON.stringify(brief(current,{completed:true,jobId,sourceApiCalls:0})));return;}
    execFileSync(process.execPath,[__filename,'--mode',args.mode,'--input',args.input,'--worker','yes'],
      {cwd:ROOT,stdio:'inherit',timeout:270000,windowsHide:true});
  }
  throw Error('RECOVERY_INVOCATION_LIMIT');
}
if(require.main===module)main().catch(error=>{console.error(`Recovery stopped safely: ${String(error.code||error.message).replace(/https?:\/\/\S+/g,'[URL omitted]')}`);process.exitCode=1;});
module.exports={argsFor,guardNetwork};
