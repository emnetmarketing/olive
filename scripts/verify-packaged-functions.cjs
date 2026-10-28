/* Offline ZIP artifact verification. Uses packaged entry/bootstrap/SDK code;
 * only Lambda's response stream and the HTTP transport are fixture adapters. */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { Writable } = require("node:stream");
const { spawnSync } = require("node:child_process");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
const within = (root, file) => file === root || file.startsWith(root + path.sep);
const EXPECTED_FUNCTION_COUNT = 32;
const EXPECTED_SCHEDULES = {
  "keyword-candidate-scheduled": "0 17 * * *",
  "market-discovery-scheduled": "0 */6 * * *",
  "trend-data-collection-recovery-scheduled": "0 23 * * *",
  "trend-data-collection-scheduled": "0 21 * * *",
  "trend-instant-dispatch-scheduled": "*/2 * * * *",
};

function zipEntries(bytes) {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, "ZIP end record missing");
  const entries = []; let cursor = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10), size = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16, local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(start, start + size);
    assert.ok(method === 0 || method === 8, "Unsupported ZIP compression");
    entries.push({ name, mode, bytes: method === 8 ? zlib.inflateRawSync(raw) : raw });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
function extractArchive(archive, destination) {
  fs.mkdirSync(destination, { recursive: true }); const links = [];
  for (const entry of zipEntries(fs.readFileSync(archive))) {
    const target = path.resolve(destination, entry.name); assert.ok(within(destination, target), "Unsafe ZIP path");
    if (entry.name.endsWith("/")) { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if ((entry.mode & 0xf000) === 0xa000) links.push({ target, source: entry.bytes.toString("utf8") });
    else fs.writeFileSync(target, entry.bytes);
  }
  const normalizedLinks = [];
  // Windows pnpm junction payloads are absolute. Never follow them into the
  // workspace: materialize only the matching path already present in this ZIP.
  for (const link of links) {
    const portable = link.source.replaceAll("\\", "/"); const index = portable.indexOf("/node_modules/.pnpm/");
    const target = index >= 0 ? path.resolve(destination, portable.slice(index + 1)) : path.resolve(path.dirname(link.target), portable);
    assert.ok(within(destination, target) && fs.existsSync(target), "ZIP dependency target is not self-contained");
    fs.cpSync(target, link.target, { recursive: true, dereference: true });
    normalizedLinks.push({ path: path.relative(destination, link.target), target: path.relative(destination, target) });
  }
  return normalizedLinks;
}
function workbookCells(files, name) {
  const decode = value => String(value || '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
  const strings = [...files.get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(match => [...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(text=>decode(text[1])).join(''));
  const sheets = [...files.get('xl/workbook.xml').matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)];
  const sheet = sheets.find(item=>decode(item[1])===name); assert.ok(sheet,name);
  const relationships = [...files.get('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]+)\/?\s*>/g)];
  const relation = relationships.find(item=>item[1].match(/\bId="([^"]+)"/)?.[1]===sheet[2]);
  const target=relation?.[1].match(/\bTarget="([^"]+)"/)?.[1]; assert.ok(target);
  const xml=files.get(target.startsWith('/')?target.slice(1):path.posix.normalize('xl/'+target));assert.ok(xml);
  return new Map([...xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(match=>{
    const address=match[1].match(/\br="([^"]+)"/)?.[1], value=match[2]?.match(/<v>(.*?)<\/v>/)?.[1];
    return [address,value===undefined?null:/\bt="s"/.test(match[1])?strings[Number(value)]:Number(value)];
  }));
}
function snapshot(job) {
  return { version: 1, jobId: job.jobId, mode: job.mode, startDate: job.startDate, endDate: job.endDate,
    queryStartDate: job.queryStartDate, createdAt: job.createdAt, generatedAt: job.completedAt,
    latestDataDate: job.latestDataDate, trendCoveragePct: job.trendCoveragePct, partialAnalysis: !!job.partialAnalysis,
    items: job.results };
}
function prepareData(input) {
  const saved = input ? JSON.parse(fs.readFileSync(input, "utf8")).finalJob : null;
  const results = saved?.results || Array.from({ length: 439 }, (_, i) => ({ keyword: `fixture-${439-i}`, resultType: "product_match",
    estimatedSurgeCount: 7031-i, peakRelativeLiftPct: 420-i/10, periodMarketConfidenceScore: 66,
    periodMarketConfidenceGrade: "medium", periodMarketConfidenceReasons: ["Fixture evidence"] }));
  assert.equal(results.length, 439);
  const target = { ...saved, jobId: "65451706-37ad-4a63-abbb-d09055acd1a5", mode: "period", state: "completed",
    currentStage: "completed", startDate: "2026-10-01", endDate: "2026-10-16", queryStartDate: "2026-09-16",
    createdAt: "2026-10-16T05:22:24.238Z", calculatedAt: "2026-10-16T08:00:00.000Z", completedAt: "2026-10-16T08:00:00.000Z",
    latestDataDate: "2026-10-14", trendCoveragePct: 100, resultCount: 439, partialAnalysis: false, results };
  const morning = { ...target, jobId: "3e995803-b13e-4c8b-bdc5-8188966457e6", createdAt: "2026-10-16T00:55:00.000Z",
    completedAt: "2026-10-16T01:13:45.000Z", calculatedAt: "2026-10-16T01:13:45.000Z", trendCoveragePct: 99.32 };
  const instant = { ...target, jobId: "instant-legacy-fixture-59", mode: "instant", results: results.slice(0,59).map(row => ({ ...row,
    keyword: `instant-fixture-${row.keyword}` })), resultCount: 59, latestDataDate: "2026-10-11" };
  return { target, morning, instant, evidenceKind: saved ? "recovered local read-only calculation rows; other identities/counts are explicit fixtures" : "synthetic fixtures" };
}
async function childMain(base, mode) {
  assert.equal(process.env.NODE_PATH, undefined); assert.ok(process.execArgv.includes("--no-global-search-paths"));
  for (let ancestor=base;;ancestor=path.dirname(ancestor)) {
    assert.equal(fs.existsSync(path.join(ancestor,"node_modules")),false,"Ancestor node_modules fallback is forbidden");
    if(path.dirname(ancestor)===ancestor)break;
  }
  for (const name of Object.keys(process.env)) if (/TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY/i.test(name)) delete process.env[name];
  delete process.env.NETLIFY_BLOBS_CONTEXT; delete globalThis.netlifyBlobsContext;
  const sources = JSON.parse(fs.readFileSync(path.join(base, "fixtures.json"), "utf8"));
  const directories = JSON.parse(fs.readFileSync(path.join(base, "archives.json"), "utf8"));
  const records = new Map(), calls = [], writes = [], pending = []; let revision = 0, requestId = 0;
  const address = (store,key) => `${store}/${key}`;
  const seed = (store,key,data) => records.set(address(store,key), { bytes: Buffer.from(JSON.stringify(data)), etag: `"${++revision}"` });
  for (const mod of [require("node:http"), require("node:https")]) {
    mod.request = mod.get = () => { throw new Error("Real HTTP access forbidden in packaged artifact verification"); };
  }
  global.fetch = async (input, options = {}) => {
    const request = input instanceof Request ? input : new Request(input, options); const url = new URL(request.url);
    if (url.origin === "https://fixture-site.netlify.app" && url.pathname === "/.netlify/functions/runtime-storage-verification-background") {
      assert.equal(request.method,"POST"); pending.push({ body: await request.json(), authorization: request.headers.get("authorization") });
      calls.push({ transport:"continuation", method:"POST" }); return new Response(null,{status:202});
    }
    assert.ok(["https://fixture-edge.invalid","https://fixture-strong.invalid"].includes(url.origin), `Forbidden external transport: ${url.hostname}`);
    const match = decodeURIComponent(url.pathname).match(/^\/fixture-site\/site:([^/]+)\/(.+)$/); assert.ok(match,"Unexpected SDK Blob route");
    const [,store,key] = match; const method = request.method; const entry = records.get(address(store,key));
    calls.push({ store,key,method,strong:url.hostname === "fixture-strong.invalid" });
    if (method === "GET" || method === "HEAD") return entry ? new Response(method === "HEAD" ? null : entry.bytes,{status:200,headers:{etag:entry.etag}}) : new Response(null,{status:404});
    assert.equal(method,"PUT","Destructive Blob methods forbidden");
    assert.ok(store === "analysis-downloads" || store === "trend-runtime-verification" && key.startsWith("runs/"), `Forbidden fixture business write: ${store}`);
    if (request.headers.get("if-none-match") === "*" && entry || request.headers.has("if-match") && request.headers.get("if-match") !== entry?.etag)
      return new Response(null,{status:412});
    const etag = `"${++revision}"`; records.set(address(store,key),{bytes:Buffer.from(await request.arrayBuffer()),etag}); writes.push({store,key});
    return new Response(null,{status:200,headers:{etag}});
  };
  global.awslambda = {
    streamifyResponse(fn) { return async(event, context) => {
      const chunks = []; const stream = new Writable({write(chunk,encoding,done){chunks.push(Buffer.from(chunk));done();}});
      await fn(event,stream,context); return {statusCode:stream.metadata?.statusCode || 200,headers:stream.metadata?.multiValueHeaders || {},bytes:Buffer.concat(chunks)};
    } },
    HttpResponseStream:{from(stream,metadata){stream.metadata=metadata;return stream;}}
  };
  process.env.URL = "https://fixture-site.netlify.app";
  const loaded = new Map();
  async function load(name) {
    const directory = path.join(base,directories[name]); assert.ok(within(base,directory));
    if (!loaded.has(name)) loaded.set(name,await import(pathToFileURL(path.join(directory,"___netlify-entry-point.mjs")).href));
    return loaded.get(name);
  }
  async function invoke(name,method="GET",query={},body,authorization) {
    const handler = (await load(name)).handler;
    const headers={"x-nf-site-id":"fixture-site","x-nf-deploy-id":"fixture-deploy",host:"fixture-site.netlify.app",...(authorization?{authorization}:{})};
    const rawUrl=`https://fixture-site.netlify.app/.netlify/functions/${name}?${new URLSearchParams(query)}`;
    const event={httpMethod:method,rawUrl,headers,body:body===undefined?undefined:JSON.stringify(body),isBase64Encoded:false,
      blobs:Buffer.from(JSON.stringify({url:"https://fixture-edge.invalid",url_uncached:"https://fixture-strong.invalid",token:"synthetic-runtime-token"})).toString("base64")};
    const result=await handler(event,{awsRequestId:`zip-fixture-${++requestId}`,getRemainingTimeInMillis:()=>900000});
    return {...result,json:()=>JSON.parse(result.bytes.toString("utf8"))};
  }
  if (mode === "imports") {
    const schedules = {};
    for (const [name,relative] of Object.entries(directories)) {
      await load(name);
      const module = await import(pathToFileURL(path.join(base,relative,"netlify/entries",`${name}.mjs`)).href);
      assert.equal(typeof module.default,"function");
      if (module.config?.schedule) schedules[name] = module.config.schedule;
    }
    assert.equal(loaded.size,EXPECTED_FUNCTION_COUNT);
    assert.deepEqual(schedules,EXPECTED_SCHEDULES);
    assert.equal(calls.length,0); console.log(JSON.stringify({mode,imported:loaded.size,schedules,externalCalls:0})); return;
  }
  // Exercise the actual packaged scheduled entry, native bootstrap and SDK.
  // No registry exists: an idle tick must be one strong read and no writes,
  // provider calls, worker dispatches, or synthetic analysis creation.
  const beforeIdleCalls = calls.length, beforeIdleWrites = writes.length, beforeIdleDispatches = pending.length;
  const idle = await invoke("trend-instant-dispatch-scheduled","POST",{}, {next_run:"2026-10-27T00:02:00.000Z"});
  assert.equal(idle.statusCode,200); assert.equal(idle.json().status,"idle");
  assert.equal(idle.json().dispatched,false);
  const idleCalls = calls.slice(beforeIdleCalls);
  assert.equal(idleCalls.length,1); assert.equal(idleCalls[0].method,"GET"); assert.equal(idleCalls[0].strong,true);
  assert.equal(writes.length,beforeIdleWrites); assert.equal(pending.length,beforeIdleDispatches);
  const {instant,morning,target}=sources;
  for (const job of [instant,morning]) {
    seed("trend-analysis",`jobs/${job.jobId}`,job); seed("trend-analysis",`last-success/${job.mode}`,{jobId:job.jobId});
    seed("trend-signal-snapshots",`latest-valid-v1/${job.mode}`,{jobId:job.jobId});
    seed("trend-signal-snapshots",`snapshots/${job.jobId}`,snapshot(job));
  }
  seed("today-early-signals","current-v1",{items:[],history:[]});
  const legacyInstant=await invoke("trend-analysis-latest","GET",{mode:"instant"}); assert.equal(legacyInstant.statusCode,200);
  assert.equal(legacyInstant.json().results.length,59);
  const legacyPeriod=await invoke("trend-analysis-latest","GET",{mode:"period"}); assert.equal(legacyPeriod.statusCode,200);
  assert.equal(legacyPeriod.json().jobId,morning.jobId); assert.equal(legacyPeriod.json().results.length,439);
  const body={...target,state:"calculated",publicationState:"prepared"}, snap=snapshot(target);
  const commit={version:1,jobId:target.jobId,mode:"period",state:"published",partialAnalysis:false,generation:Date.parse(target.createdAt),publishedAt:target.completedAt,
    bodyKey:"prepared/fixture/body",snapshotKey:"prepared/fixture/snapshot",bodyHash:digest(body),snapshotHash:digest(snap),startDate:target.startDate,endDate:target.endDate,queryStartDate:target.queryStartDate};
  seed("trend-analysis",`jobs/${target.jobId}`,{...target,state:"interrupted",results:[]});
  seed("trend-period-publications",commit.bodyKey,body);seed("trend-period-publications",commit.snapshotKey,snap);
  seed("trend-period-publications","latest-v1",commit);seed("trend-period-publications",`published-jobs/${target.jobId}`,commit);
  const latest=await invoke("trend-analysis-latest","GET",{mode:"period"}), status=await invoke("trend-analysis-status","GET",{jobId:target.jobId}), signal=await invoke("signal-snapshot-latest","GET",{mode:"period"});
  for (const result of [latest,status,signal]) {assert.equal(result.statusCode,200);assert.equal(result.json().jobId,target.jobId);}
  assert.equal(digest(latest.json().results),digest(target.results));assert.equal(digest(status.json().results),digest(target.results));
  assert.equal(signal.json().items.length,439);assert.equal(writes.length,0,"Read APIs must not mutate any fixture");
  const exported=await invoke("download-history","POST",{}, {downloadType:"unified_results",periodJobId:target.jobId,periodStartDate:target.startDate,periodEndDate:target.endDate});
  assert.equal(exported.statusCode,201);assert.equal(exported.json().periodJobId,target.jobId);assert.equal(exported.json().sourceJobId,instant.jobId);
  const xlsx=new Map(zipEntries(Buffer.from(exported.json().contentBase64,"base64")).map(entry=>[entry.name,entry.bytes.toString("utf8")]));
  assert.match(xlsx.get("xl/workbook.xml"),/07_선택기간분석/);assert.match(xlsx.get("xl/workbook.xml"),/00_요약/);
  const xml=xlsx.get("xl/worksheets/sheet8.xml");assert.equal((xml.match(/<row /g)||[]).length-10,439);
  const strings=[...(xlsx.get("xl/sharedStrings.xml")||"").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(match=>[...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(item=>item[1]).join("").replaceAll("&amp;","&").replaceAll("&lt;","<").replaceAll("&gt;",">").replaceAll("&quot;",'"').replaceAll("&apos;","'"));
  const keywordCells=[...xml.matchAll(/<c r="C(\d+)"[^>]*t="s"[^>]*><v>(\d+)<\/v><\/c>/g)].filter(match=>Number(match[1])>=12).map(match=>strings[Number(match[2])]);
  assert.deepEqual(keywordCells,target.results.map(row=>row.keyword));
  const runId="11111111-1111-4111-8111-111111111111",token="offline-probe-token-000000000000000000000000";
  seed("trend-runtime-verification",`authorization/${runId}`,{jobId:`runtime-fixture-${runId}`,tokenHash:hash(token),expiresAt:new Date(Date.now()+3600000).toISOString()});
  const started=await invoke("runtime-storage-verification","POST",{},{runId},`Bearer ${token}`);assert.equal(started.statusCode,202);
  const phases=[];while(pending.length){assert.ok(phases.length<2);const next=pending.shift();phases.push(next.body.phase);
    const continued=await invoke("runtime-storage-verification-background","POST",{},next.body,next.authorization);assert.equal(continued.statusCode,200,continued.bytes.toString());}
  assert.deepEqual(phases,[1,2]);
  const verified=await invoke("runtime-storage-verification","GET",{runId},undefined,`Bearer ${token}`);assert.equal(verified.statusCode,200);
  const report=verified.json();assert.equal(report.stage,"completed");assert.equal(report.invocations.length,2);
  assert.ok(report.invocations.every(value=>value.nativeStrongEndpointPresent && value.sdkVersion === "10.7.12"));
  for(const key of ["publicationFailureProtected","publicationRetrySucceeded","normalWorkerClaimVerified","normalWorkerFrozenInputsVerified","normalWorkerCheckpointResumeVerified"])assert.equal(report.report[key],true,key);
  assert.ok(calls.some(call=>call.strong&&call.method==="GET"));assert.ok(calls.some(call=>call.strong&&call.method==="PUT"));
  assert.equal((await invoke("trend-analysis-latest","GET",{mode:"instant"})).json().results.length,59);
  let quality = null;
  const qualityFile = path.join(base, 'quality-fixtures.json');
  if (fs.existsSync(qualityFile)) {
    const captured = JSON.parse(fs.readFileSync(qualityFile, 'utf8'));
    const beforeWrites = writes.length;
    const qInstant = captured.instant, qPeriod = captured.period;
    seed('trend-analysis', `jobs/${qInstant.jobId}`, qInstant);
    seed('trend-analysis', 'last-success/instant', { jobId: qInstant.jobId });
    seed('trend-signal-snapshots', 'latest-valid-v1/instant', { jobId: qInstant.jobId });
    seed('trend-signal-snapshots', `snapshots/${qInstant.jobId}`, captured.snapshot || snapshot(qInstant));
    const qBody = { ...qPeriod, state: 'calculated', publicationState: 'prepared' }, qSnapshot = snapshot(qPeriod);
    const qCommit = { ...commit, jobId: qPeriod.jobId, generation: Date.parse(qPeriod.createdAt),
      bodyHash: digest(qBody), snapshotHash: digest(qSnapshot), startDate: qPeriod.startDate, endDate: qPeriod.endDate, queryStartDate: qPeriod.queryStartDate };
    seed('trend-period-publications', qCommit.bodyKey, qBody); seed('trend-period-publications', qCommit.snapshotKey, qSnapshot);
    seed('trend-period-publications', 'latest-v1', qCommit); seed('trend-period-publications', `published-jobs/${qPeriod.jobId}`, qCommit);
    seed('today-early-signals', 'current-v1', captured.today);
    const reads = {};
    for (const [key, endpoint, query] of [['instant','trend-analysis-latest',{mode:'instant'}], ['period','trend-analysis-latest',{mode:'period'}],
      ['status','trend-analysis-status',{jobId:qInstant.jobId}], ['snapshot','signal-snapshot-latest',{mode:'instant'}], ['early','today-early-signals',{}]]) {
      const response = await invoke(endpoint, 'GET', query); assert.equal(response.statusCode, 200, key); reads[key] = response.json();
    }
    for (const [name, original] of [['instant', qInstant], ['period', qPeriod]]) {
      assert.equal(reads[name].jobId, original.jobId); assert.equal(reads[name].results.length, original.results.length);
      assert.deepEqual(reads[name].results.map(r=>[r.keyword,r.estimatedSurgeCount,r.peakBaseline,r.latestDataDate,r.trendSeries]),
        original.results.map(r=>[r.keyword,r.estimatedSurgeCount,r.peakBaseline,r.latestDataDate,r.trendSeries]), 'Source/order/date unchanged');
      const nail = reads[name].results.find(row=>row.keyword==='네일');
      assert.ok(nail); assert.ok(nail.relatedSignal.referenceProducts.length > 0);
      assert.ok(nail.relatedSignal.referenceProducts.every(item=>!item.product.includes('스네일')));
      const zero = reads[name].results.find(row=>row.keyword==='나이아신아마이드20');
      assert.equal(zero.peakBaseline,0); assert.equal(zero.peakRelativeLiftPct,null); assert.equal(zero.riseRate,null);
    }
    assert.equal(reads.snapshot.jobId, reads.instant.jobId);
    assert.deepEqual(reads.snapshot.items.map(row=>[row.keyword,row.resultType,row.marketConfidenceScore,row.qualityProjection?.projectedResultHash]),
      reads.instant.results.map(row=>[row.keyword,row.resultType,row.marketConfidenceScore,row.qualityProjection?.projectedResultHash]),
      'Compact snapshot and full result share the same quality values');
    assert.deepEqual(reads.status.results, reads.instant.results);
    for (const key of ['아이유산균','맛있는영양제','워터선크림']) {
      const row = reads.early.items.find(item=>item.keyword===key); assert.ok(row,key);
      assert.equal(row.relatedBrand,''); assert.equal(row.todayEarlySignalScore,40); assert.equal(row.brandContextStatus,'unverified');
    }
    assert.equal(writes.length,beforeWrites,'Quality GETs never mutate source/pointers');
    const download = await invoke('download-history','POST',{}, {downloadType:'unified_results',periodJobId:qPeriod.jobId,
      periodStartDate:qPeriod.startDate,periodEndDate:qPeriod.endDate});
    assert.equal(download.statusCode,201); assert.equal(download.json().sourceJobId,qInstant.jobId); assert.equal(download.json().periodJobId,qPeriod.jobId);
    const entries=new Map(zipEntries(Buffer.from(download.json().contentBase64,'base64')).map(entry=>[entry.name,entry.bytes.toString('utf8')]));
    assert.match(entries.get('xl/sharedStrings.xml'), /비교 불가 · 기준값 0/);
    assert.match(entries.get('xl/sharedStrings.xml'), /브랜드 미확인/);
    const instantCells=workbookCells(entries,'02_어제 급등 확인'), periodCells=workbookCells(entries,'07_선택기간분석'),earlyCells=workbookCells(entries,'01_오늘 급상승 신호');
    reads.instant.results.forEach((row,index)=>{
      const line=index+2;assert.equal(instantCells.get(`A${line}`),row.keyword);
      assert.equal(instantCells.get(`C${line}`),Number(row.estimatedSurgeCount || 0)); // Existing Instant export numeric convention, including ratio-only rows.
      assert.equal(instantCells.get(`I${line}`)??null,row.marketConfidenceScore??null);
      assert.equal(instantCells.get(`L${line}`),Number(row.match?.score||0)/100);
      if(row.peakBaseline===0)assert.equal(instantCells.get(`D${line}`)??null,null);
    });
    reads.period.results.forEach((row,index)=>{
      const line=index+12;assert.equal(periodCells.get(`C${line}`),row.keyword);
      assert.equal(periodCells.get(`D${line}`)??null,row.estimatedSurgeCount??null);
      assert.equal(periodCells.get(`F${line}`)??null,row.periodMarketConfidenceScore??null);
      if(row.peakBaseline===0)assert.equal(periodCells.get(`E${line}`)??null,null);
    });
    reads.early.items.forEach((row,index)=>{
      assert.equal(earlyCells.get(`A${index+2}`),row.keyword);assert.equal(earlyCells.get(`C${index+2}`)??null,row.todayEarlySignalScore??null);
    });
    // The resulting workbook is a local fixture download, not a Production history write.
    fs.writeFileSync(path.join(base,'quality-fixture.xlsx'),Buffer.from(download.json().contentBase64,'base64'));
    fs.writeFileSync(path.join(base,'quality-api.json'),JSON.stringify(reads));
    quality={instantJob:qInstant.jobId,instantRows:reads.instant.results.length,periodJob:qPeriod.jobId,periodRows:reads.period.results.length,
      earlyRows:reads.early.count,nailReferences:reads.instant.results.find(row=>row.keyword==='네일').relatedSignal.referenceProducts.map(item=>item.product),
      sourceSeriesDatesAmountsOrderPreserved:true,readWrites:0,apiStatusSnapshotIdentical:true,excelSameJobs:true,zeroBaselineComparable:false,
      genericBrandContextPointsRemoved:true,excelAllRowsOrderAmountsConfidenceMatch:true,fixtureExcel:path.join(base,'quality-fixture.xlsx')};
  }
  console.log(JSON.stringify({mode,bootstrapExecuted:true,nativeContext:true,legacyInstantRows:59,legacyMorningPeriodRows:439,canonicalPeriodRows:439,
    latestStatusSnapshotJobMatch:true,excelPeriodRows:439,excelJobId:exported.json().periodJobId,probePhases:phases,probeReport:report.report,
    scheduledDispatcherVerified:true,scheduledDispatcherIdleWrites:0,scheduledDispatcherIdleSourceCalls:0,
    sdkVersions:[...new Set(report.invocations.map(value=>value.sdkVersion))],fixtureBlobReads:calls.filter(x=>x.method==="GET").length,
    fixtureBlobWrites:writes.length,sourceApiCalls:0,productionCalls:0,sourceRowsDigest:digest(target.results),quality}));
}
async function main() {
  if(process.argv[2]==="--child")return childMain(path.resolve(process.argv[3]),process.argv[4]);
  const archives=path.resolve(process.argv[2]||"data/build-smoke/native-functions-portable");
  const input=process.argv[3]&&!process.argv[3].startsWith('--')?path.resolve(process.argv[3]):null;
  const qualityDirectory=process.argv.find(value=>value.startsWith('--quality-fixtures='))?.slice('--quality-fixtures='.length);
  const reportOutput=path.resolve(process.argv.find(value=>value.startsWith("--report="))?.slice(9)||path.join(archives,"execution-report.json"));
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"netlify-zip-execution-"));
  const only=process.argv.find(value=>value.startsWith("--only="))?.slice(7);
  const negative=process.argv.includes("--expect-missing-sdk");
  const names=fs.readdirSync(archives).filter(name=>name.endsWith(".zip")&&(!only||name===`${only}.zip`)); const directories={},evidence=[];
  if(!only && !negative)assert.equal(names.length,EXPECTED_FUNCTION_COUNT,"Final artifact gate requires all 32 native endpoints");
  for(const name of names){const route=name.slice(0,-4);directories[route]=route;
    const archive=path.join(archives,name);const normalizedLinks=extractArchive(archive,path.join(base,route));
    evidence.push({name:route,sha256:hash(fs.readFileSync(archive)),normalizedLinks});}
  if(!process.argv.includes("--allow-link-normalization"))assert.ok(evidence.every(item=>item.normalizedLinks.length===0),"Final artifact gate forbids ZIP symlink normalization");
  fs.writeFileSync(path.join(base,"archives.json"),JSON.stringify(directories));fs.writeFileSync(path.join(base,"fixtures.json"),JSON.stringify(prepareData(input)));
  if (qualityDirectory) {
    const read = name => JSON.parse(fs.readFileSync(path.join(path.resolve(qualityDirectory),`${name}.json`),'utf8'));
    const today = read('today');
    fs.writeFileSync(path.join(base,'quality-fixtures.json'),JSON.stringify({instant:read('instant'),period:read('period'),snapshot:read('snapshot'),
      today:{...today,history:today.items}})); // Current stored observations suffice; historical source remains untouched.
  }
  fs.copyFileSync(__filename,path.join(base,"verify.cjs"));
  const env={...process.env};delete env.NODE_PATH;delete env.NODE_OPTIONS;
  for(const key of Object.keys(env))if(/TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY/i.test(key))delete env[key];
  const results=[];
  for(const mode of ["imports","execution"]){const child=spawnSync(process.execPath,["--no-global-search-paths",path.join(base,"verify.cjs"),"--child",base,mode],{cwd:base,env,encoding:"utf8",timeout:90000,maxBuffer:2*1024*1024});
    if(child.status!==0){
      const failure={base,mode,status:child.status,error:child.error?.message,stdout:child.stdout,stderr:child.stderr};
      if(negative&&mode==="imports"&&/Cannot find (?:module|package) ['"]@netlify\/blobs['"]/.test(child.stderr)){
        const result={expectedFailureConfirmed:true,missingPackage:"@netlify/blobs",node:process.version,workspaceModuleFallback:false,artifacts:evidence,...failure};
        fs.writeFileSync(path.join(base,"negative-report.json"),JSON.stringify(result,null,2));fs.writeFileSync(reportOutput,JSON.stringify(result,null,2));
        console.log(JSON.stringify({report:reportOutput,...result}));return;
      }
      console.error(JSON.stringify(failure));process.exitCode=1;return;
    }
    const result=child.stdout.trim().split(/\r?\n/).filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean).at(-1);results.push(result);}
  const report={archives,isolatedDirectory:base,node:process.version,ancestorModulesDisabled:true,workspaceModuleFallback:false,zipEntryCount:names.length,artifacts:evidence,results};
  assert.equal(negative,false,"Expected missing SDK failure did not occur");
  fs.writeFileSync(path.join(base,"report.json"),JSON.stringify(report,null,2));
  fs.writeFileSync(reportOutput,JSON.stringify(report,null,2));
  console.log(JSON.stringify({report:reportOutput,...report,artifacts:evidence.map(item=>({name:item.name,sha256:item.sha256,normalizedLinks:item.normalizedLinks.length}))},null,2));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
