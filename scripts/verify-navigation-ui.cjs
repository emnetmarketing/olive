// Real Chromium, real saved results, entirely offline. Only bootstrap/login is
// replaced; navigation, permissions, rendering, polling and save handlers run.
// No production settings, source API, analysis, or download-history writes.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."), out = path.join(root, "data/navigation-ui-20261106");
fs.mkdirSync(out, {recursive:true});
const fixture = JSON.parse(fs.readFileSync(process.env.DASHBOARD_FIXTURE || path.join(root,"data/naver-status-production-20261102/after.json"),"utf8"));
const baselinePath=path.join(out,"before.json");
const settingsFixture=fs.existsSync(baselinePath)?JSON.parse(fs.readFileSync(baselinePath,"utf8")).operatingSettings:{surgeThreshold:fixture.job.surgeThreshold,matchThreshold:fixture.job.matchThreshold,source:"fixture"};
let pw;
try { pw=require(process.env.PLAYWRIGHT_PATH || "playwright"); } catch {pw=require(path.join(os.homedir(),".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));}
const executablePath=process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const origin="https://navigation-fixture.invalid";
const html=fs.readFileSync(path.join(root,"index.html"),"utf8").replace(/^(\s*)initializeApp\(\);\s*$/m,"$1/* offline responses replace app startup only */");
assert(!/^\s*initializeApp\(\);\s*$/m.test(html),"startup must not invoke live paths");
const hash = s=>crypto.createHash("sha256").update(s).digest("hex");
async function check(browser,viewport,role){
  const step=text=>console.log(role,viewport.width,text);
  step("시작");
  const context=await browser.newContext({viewport,locale:"ko-KR",timezoneId:"Asia/Seoul",serviceWorkers:"block",reducedMotion:"reduce"});
  const reads=[],writes=[],mockReuseRequests=[],blocked=[],errors=[],dialogs=[];
  let pendingStatus=null,releaseStatus=null;
  await context.route("**/*",async route=>{
    const request=route.request(),url=new URL(request.url()),pathname=url.pathname,method=request.method();
    const json=o=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(o)});
    if(url.origin!==origin){blocked.push(method+" "+url.host+pathname);return route.abort();}
    if(method==="GET"){
      if(pathname==="/")return route.fulfill({status:200,contentType:"text/html; charset=utf-8",body:html});
      if(/^\/shared\/[a-z-]+\.js$/.test(pathname))return route.fulfill({status:200,contentType:"text/javascript",body:fs.readFileSync(path.join(root,pathname.slice(1)),"utf8")});
      if(pathname==="/favicon.ico")return route.fulfill({status:204});
      reads.push(pathname);
      if(pathname==="/.netlify/functions/market-discovery-list")return json(fixture.discoveries);
      if(pathname==="/.netlify/functions/today-early-signals")return json(fixture.earlyApi);
      if(pathname==="/.netlify/functions/operating-settings")return json({ok:true,settings:settingsFixture});
      if(pathname==="/.netlify/functions/trend-analysis-status"&&pendingStatus){
        if(url.searchParams.get("jobId")===fixture.job.jobId)return json(fixture.job);
        await new Promise(resolve=>{releaseStatus=resolve;});return json(pendingStatus);
      }
    }
    if(method==="POST"&&pathname==="/.netlify/functions/operating-settings"){
      const body=request.postDataJSON();writes.push({pathname,body});
      return json({ok:true,settings:{...body,savedAt:"2026-11-06T00:30:00Z",source:"fixture"}});
    }
    if(method==="POST"&&pathname==="/.netlify/functions/trend-analysis-start"){
      mockReuseRequests.push(request.postDataJSON());
      return json({jobId:fixture.job.jobId,mode:"instant",cachedSnapshot:true});
    }
    blocked.push(method+" "+pathname);return route.abort("blockedbyclient");
  });
  const page=await context.newPage();page.on("pageerror",e=>errors.push(e.message));
  await page.addInitScript(()=>{
    window.__storageWrites=[];const original=Storage.prototype.setItem;
    Storage.prototype.setItem=function(key,value){window.__storageWrites.push(key);return original.call(this,key,value);};
  });
  page.on("dialog",async d=>{dialogs.push({type:d.type(),message:d.message()});await d.accept();});
  await page.goto(origin,{waitUntil:"load"});
  await page.evaluate(async ({fixture,role})=>{
    state.currentUser={email:"qa@fixture.invalid",name:"화면 검증",role,status:"approved"};
    applyAuthState();await loadOperatingSettings();
    $("collectionStart").value=fixture.period.startDate;$("collectionEnd").value=fixture.period.endDate;
    displayCompletedAnalysis(fixture.job,{restored:true});displayCompletedAnalysis(fixture.period,{restored:true});
    await Promise.all([loadTodayEarlySignals(),loadMarketDiscoveryNewList()]);
    await document.fonts.ready;
    window.__originalKeywordNode=$("shellKeywordView");window.__originalSettingsNode=$("surgeThreshold");
  },{fixture:{job:fixture.job,period:fixture.period},role});
  const kw=page.locator("#shellKeywordNav"),video=page.locator("#shellVideoNav"),settings=page.locator("#shellSettingsBtn"),dialog=page.locator("#shellSettingsDialog");
  assert(await page.locator("#shellKeywordView").isVisible());assert(!(await page.locator("#shellVideoView").isVisible()));
  assert(await settings.isVisible());
  const controls=await page.locator("[data-shell-keyword-control]").count();assert(controls>0);
  const main=()=>page.evaluate(()=>({
    instantJob:state.currentAnalysisJob?.jobId,periodJob:state.currentPeriodAnalysisJob?.jobId,
    results:JSON.stringify(state.currentAnalysisJob?.results),periodResults:JSON.stringify(state.currentPeriodAnalysisJob?.results),
    dates:[$("collectionStart").value,$("collectionEnd").value],query:$("periodResultSearch").value,
    rows:[...$("resultBody").querySelectorAll("tr[data-cmp-keyword]")].map(r=>r.dataset.cmpKeyword),
    periodRows:[...$("periodAnalysisBody").querySelectorAll("tr[data-cmp-keyword]")].map(r=>r.dataset.cmpKeyword),
    density:document.documentElement.dataset.cmpDensity,
    tableScroll:$("resultBody").closest(".table-wrap").scrollTop,
    windowScroll:scrollY, expanded:$("periodAllResultsDetails").open,
    sameNodes:window.__originalKeywordNode===$("shellKeywordView")&&window.__originalSettingsNode===$("surgeThreshold")
  }));
  const original=await main();
  step("저장 결과 렌더링");
  assert.equal(original.instantJob,fixture.job.jobId);assert.equal(original.periodJob,fixture.period.jobId);
  await page.locator("#periodAllResultsDetails").evaluate(el=>el.open=true);
  await page.locator("#periodResultSearch").fill(fixture.period.results[0].keyword);
  await page.locator("[data-cmp-density='relaxed']").first().click();
  await page.locator("#resultBody").evaluate(el=>el.closest(".table-wrap").scrollTop=180);
  const retained=await main();
  for(let i=0;i<3;i++){
    await video.click();assert(await page.locator("#shellVideoView").isVisible());
    assert(!(await page.locator("#shellKeywordView").isVisible()));
    assert.equal(await page.locator("[data-shell-keyword-control]:visible").count(),0);
    assert.equal(await page.locator("#shellVideoView tr[data-cmp-keyword]").count(),0);
    await kw.click();
    const again=await main();delete again.windowScroll;const old={...retained};delete old.windowScroll;
    assert.deepEqual(again,old,"menu toggle must preserve current rendered result, query, dates, table scroll and density");
  }
  step("반복 전환 유지");
  // Delayed running response arrives while the other menu is visible. It may
  // update the existing hidden keyword DOM, but never replace the video pane.
  pendingStatus={...fixture.job,jobId:"offline-running-job",state:"running",stage:"calculation-matching",currentStage:"calculation-matching",
    stageCurrent:1250,stageTotal:5000,mode:"instant",progress:65,processedCount:1250,totalCount:5000,completedAt:null,publishedAt:null,updatedAt:new Date().toISOString()};
  await page.evaluate(()=>{
    const c=beginAnalysisRequest("instant");c.jobId="offline-running-job";
    window.__pollPromise=pollAnalysis(c.jobId,null,c);
  });
  for(let i=0;i<60&&!releaseStatus;i++)await new Promise(r=>setTimeout(r,25));
  assert(releaseStatus,"poll request must be held");
  await video.click();releaseStatus();await page.evaluate(()=>window.__pollPromise);
  assert(await page.locator("#shellVideoView").isVisible());assert(!(await page.locator("#analysisProgressPanel").isVisible()));
  const afterPoll=await page.evaluate(()=>({job:activeAnalysisJobId,timer:analysisPollTimer,context:JSON.stringify(analysisContext),progress:$("analysisProgressText").textContent,stored:state.currentAnalysisJob?.jobId}));
  assert.equal(afterPoll.job,"offline-running-job");assert(afterPoll.timer);assert.equal(afterPoll.stored,fixture.job.jobId);
  await kw.click();
  assert(await page.locator("#analysisProgressPanel").isVisible());
  const continued=await page.evaluate(()=>({job:activeAnalysisJobId,timer:analysisPollTimer,context:JSON.stringify(analysisContext),progress:$("analysisProgressText").textContent,stored:state.currentAnalysisJob?.jobId}));
  assert.deepEqual(continued,afterPoll,"menu switch cannot reset a current poll");
  step("지연 응답과 polling 유지");
  await page.evaluate(()=>{clearTimeout(analysisPollTimer);analysisPollTimer=null;finishAnalysisControls(analysisContext);});
  // Cancel/close has no server or browser-settings write side effects.
  const storage=()=>page.evaluate(()=>JSON.stringify(Object.fromEntries(Object.keys(localStorage).sort().map(k=>[k,localStorage.getItem(k)]))));
  const settingsBefore=await storage();const writeBefore=writes.length,localWritesBefore=await page.evaluate(()=>window.__storageWrites.length);
  await settings.focus();await page.keyboard.press("Enter");await dialog.waitFor({state:"visible"});
  assert(await page.locator("#surgeThreshold").isVisible());
  if(role==="master"&&(viewport.width===1440||viewport.width===390)){
    await page.screenshot({path:path.join(out,"settings-"+viewport.width+".png"),animations:"disabled"});
    await page.locator("#apiTabBtn").click();
    await page.screenshot({path:path.join(out,"settings-api-"+viewport.width+".png"),animations:"disabled"});
    await page.locator("#monitorTabBtn").click();
  }
  await page.keyboard.press("Escape");await dialog.waitFor({state:"hidden"});
  assert.equal(writes.length,writeBefore);assert.equal(await page.evaluate(()=>window.__storageWrites.length),localWritesBefore);
  await settings.click();
  if(role==="master"){
    assert(!(await page.locator("#surgeThreshold").isDisabled()));
    await page.locator("#surgeThreshold").fill("333");
    await page.keyboard.press("Escape");await dialog.waitFor({state:"hidden"});
    assert.equal(writes.length,writeBefore);assert.equal(await storage(),settingsBefore);
    assert(await settings.evaluate(el=>document.activeElement===el));
    await page.evaluate(()=>analyze("instant"));
    assert.deepEqual(mockReuseRequests,[{mode:"instant",startDate:fixture.period.startDate,endDate:fixture.period.endDate}],"unsaved thresholds must not leak into analysis request");
    assert.equal(await page.evaluate(()=>state.operatingSettings.surgeThreshold),300);
    await settings.click();await page.locator("#surgeThreshold").fill("333");await page.locator("#operatingSettingsSaveBtn").click();
    await page.waitForFunction(()=>state.operatingSettings?.surgeThreshold===333);
    assert.equal(writes.length,writeBefore+1);assert.deepEqual(writes.at(-1).body,{surgeThreshold:333,matchThreshold:40});
    await page.locator("#apiTabBtn").click();assert(await page.locator("#apiPanel").isVisible());
    const beforeAuto=await page.evaluate(()=>window.__storageWrites.length);
    await page.locator("#emailRecipients").fill("fixture@example.invalid");
    await page.waitForFunction(before=>window.__storageWrites.length>before,beforeAuto);
    const autoKeys=await page.evaluate(before=>window.__storageWrites.slice(before),beforeAuto);
    assert.equal(autoKeys.length,2,"existing debounced auto-save writes only primary and backup");
    await page.locator("#saveBtn").click();
    assert.equal(writes.length,writeBefore+1,"API settings save must not fetch source data");
    assert.notEqual(await storage(),settingsBefore);
    await page.locator("#monitorTabBtn").click();
  }else{
    assert(await page.locator("#surgeThreshold").isDisabled());assert(await page.locator("#apiTabBtn").isDisabled());
    assert(!(await page.locator("#operatingSettingsSaveBtn").isVisible()));assert.equal(writes.length,0);
  }
  step("권한과 저장 동작");
  const bounded=await dialog.evaluate(el=>{const b=el.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:innerWidth,height:innerHeight}});
  assert(bounded.left>=-.5&&bounded.right<=bounded.width+.5&&bounded.top>=-.5&&bounded.bottom<=bounded.height+.5,"drawer must fit viewport");
  // Tab remains within a native modal; close returns to the settings trigger.
  const focusWalk=[];
  for(let i=0;i<12;i++){
    await page.keyboard.press("Tab");
    const active=await dialog.evaluate(el=>({inside:el.contains(document.activeElement),tag:document.activeElement.tagName,id:document.activeElement.id}));
    focusWalk.push(active);assert(active.inside||active.tag==="BODY","native modal focus escaped to a background control: "+JSON.stringify(active));
  }
  await page.locator("#shellSettingsClose").click();assert(await settings.evaluate(el=>document.activeElement===el));
  assert.equal(await page.locator("#surgeThreshold").count(),1);
  await page.evaluate(()=>{displayCompletedAnalysis(state.currentAnalysisJob,{restored:true});window.scrollTo(0,0);});
  await page.locator("[data-cmp-density='compact']").first().click();await page.evaluate(()=>window.scrollTo(0,0));
  if(role==="master"){
    await page.screenshot({path:path.join(out,"keyword-"+viewport.width+".png"),animations:"disabled"});
    await video.click();await page.screenshot({path:path.join(out,"video-"+viewport.width+".png"),animations:"disabled"});
    await kw.click();
  }
  const final=await main();assert.equal(final.results,original.results);assert.equal(final.periodResults,original.periodResults);assert(final.sameNodes);
  await settings.click();await dialog.waitFor({state:"visible"});
  await page.evaluate(()=>{state.currentUser=null;applyAuthState();});
  await dialog.waitFor({state:"hidden"});
  await page.evaluate(()=>$("shellSettingsBtn").click());
  assert(!(await dialog.isVisible()),"logged-out user must not reopen settings");
  assert(await page.locator("#authScreen").isVisible());
  assert.deepEqual(blocked,[],"unapproved requests must remain absent");assert.deepEqual(errors,[],"browser console errors");
  const report={viewport,role,instantJob:final.instantJob,instantRows:fixture.job.results.length,periodJob:final.periodJob,periodRows:fixture.period.results.length,
    resultHashes:{instant:hash(final.results),period:hash(final.periodResults)},menuControls:controls,
    checks:{repeatToggleState:true,sameDom:true,delayedResponseHidden:true,samePollTimer:true,readOnlyOpenClose:true,
      explicitSaveOnly:role==="master",permissions:true,focusRestored:true,modalTabTrap:true,viewportBounds:true,logoutClosesAndGuards:true},
    localMockReads:reads.length,localMockServerWrites:writes,cachedSnapshotMockRequests:mockReuseRequests,focusWalk,sourceApiCalls:0,productionWrites:0,blocked,errors};
  fs.writeFileSync(path.join(out,role+"-"+viewport.width+".json"),JSON.stringify(report,null,2));console.log(role,viewport.width,JSON.stringify(report.checks));await context.close();
}
(async()=>{
 const browser=await pw.chromium.launch({executablePath,headless:true,args:["--disable-background-networking","--disable-component-update","--disable-extensions","--host-resolver-rules=MAP * ~NOTFOUND"]});
 try{for(const viewport of [{width:1440,height:900},{width:1920,height:1080},{width:390,height:844}])await check(browser,viewport,"master");await check(browser,{width:1440,height:900},"operator");}
 finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
