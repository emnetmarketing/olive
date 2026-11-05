// Offline visual comparison: the real dashboard and its saved read responses.
// Usage: node scripts/verify-dashboard-readability.cjs [--before-only] [--after-only]
// Set DASHBOARD_FIXTURE, DASHBOARD_BRAND_FIXTURE, BASELINE_REF, PLAYWRIGHT_PATH or CHROME_PATH for a different installation.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const fixture = JSON.parse(fs.readFileSync(process.env.DASHBOARD_FIXTURE ||
  path.join(root, "data/naver-status-production-20261102/after.json"), "utf8"));
const ref = process.env.BASELINE_REF || "dc8d2d00fd78bf52234793994ea92c69876db260";
const out = path.join(root, "data/dashboard-readability-20261105");
const origin = "https://dashboard-fixture.invalid";
const rows = {discovery: "marketDiscoveryNewBody", direct: "resultBody", early: "todayEarlySignalBody",
  period: "periodAnalysisBody", top: "periodAnalysisTopBody", low: "lowIntensitySignalBody", ratio: "ratioOnlySignalBody", domain: "domainSignalBody", brand: "brandSignalBody"};
const args = new Set(process.argv.slice(2));
fs.mkdirSync(out, { recursive: true });
const chrome = process.env.CHROME_PATH || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined);
let pw;
try { pw = require(process.env.PLAYWRIGHT_PATH || "playwright"); }
catch { pw = require(path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const output = async (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2));
const frontend = (v, file) => v === "before" ? cp.execFileSync("git", ["show", ref + ":" + file], {cwd:root, encoding:"utf8", maxBuffer:16*1024*1024}) : fs.readFileSync(path.join(root, file), "utf8");
async function render(browser,v, size) {
  const ctx = await browser.newContext({viewport:size, locale:"ko-KR", timezoneId:"Asia/Seoul", serviceWorkers:"block", reducedMotion:"reduce"});
  const reads = [], forbidden = [], errors = [];
  const html = frontend(v,"index.html").replace(/^(\s*)initializeApp\(\);\s*$/m, "$1/* offline fixture replaces login/network startup only */");
  assert(!/^\s*initializeApp\(\);\s*$/m.test(html));
  await ctx.route("**/*", async route => {
    const r = route.request(), u = new URL(r.url());
    const reply = (type,body) => route.fulfill({status:200,contentType:type,body});
    if(u.origin === origin && r.method() === "GET") {
      if(u.pathname === "/") return reply("text/html; charset=utf-8",html);
      if (/^\/(?:shared|assets)\/[a-z0-9-]+\.(?:css|js)$/.test(u.pathname)) return reply(u.pathname.endsWith(".css")?"text/css":"text/javascript",frontend(v,u.pathname.slice(1)));
      const key = {"/.netlify/functions/market-discovery-list":"discoveries","/.netlify/functions/today-early-signals":"earlyApi"}[u.pathname];
      if(key) { reads.push(key);return reply("application/json; charset=utf-8",JSON.stringify(fixture[key])); }
      if(u.pathname === "/favicon.ico") return route.fulfill({status:204});
    }
    forbidden.push(r.method() + " " + u.pathname); return route.abort("blockedbyclient");
  });
  const p = await ctx.newPage();
  p.on("pageerror",e=>errors.push(e.message));
  async function seed(){
    await p.goto(origin + "/", {waitUntil:"load"});
    await p.evaluate(async ({instant,period})=>{
      state.currentUser={name:"검증",email:"qa@fixture.invalid",role:"operator",status:"approved"};
      applyAuthState();
      $("collectionStart").value=period.startDate; $("collectionEnd").value=period.endDate;
      displayCompletedAnalysis(instant,{restored:true});
      displayCompletedAnalysis(period,{restored:true});
      await Promise.all([loadMarketDiscoveryNewList(),loadTodayEarlySignals()]);
      await document.fonts.ready;
    }, {instant:fixture.job,period:fixture.period});
  }
  await seed();
  async function locate(id) {
    await p.locator("#" + id).evaluate(b=>{
      for(let a=b.parentElement;a;a=a.parentElement) if(a.tagName === "DETAILS") a.open=true;
      const w=b.closest(".table-wrap"); w.scrollTo(0,0);
      window.scrollTo({top:window.scrollY+w.getBoundingClientRect().top-80,behavior:"instant"});
    });
  }
  async function measure(id){
    return p.locator("#"+id).evaluate(b=>{
      const w=b.closest(".table-wrap"), wr=w.getBoundingClientRect(), header=w.querySelector("thead tr");
      const rs=[...b.rows].map(r=>r.getBoundingClientRect()), hs=rs.map(r=>Math.round(r.height));
      const headerBottom=Math.max(...[...header.cells].map(th=>th.getBoundingClientRect().bottom));
      const visible=rs.filter(r=>r.top>=Math.max(0,headerBottom)-.5 && r.bottom<=Math.min(wr.top+w.clientHeight+1,innerHeight)+.5);
      const first=b.rows[0]; const pos=el=>{const r=el?.getBoundingClientRect();return r && {left:Math.round(r.left),right:Math.round(r.right),top:Math.round(r.top),bottom:Math.round(r.bottom)};};
      const key=first.querySelector("strong")||first.cells[0], detail=first.querySelector("[data-cmp-open]");
      return {count:rs.length, visible:visible.length, heights:{first:hs[0],min:Math.min(...hs),max:Math.max(...hs)}, viewport: {width:w.clientWidth,height:w.clientHeight,scrollWidth:w.scrollWidth}, first: first.innerText.replace(/\n+/g," · ").slice(0,520), keyword:pos(key), detail:pos(detail)};
    });
  }
  const report = {variant:v,viewport:size, tables:{}, checks:{}};
  for(const [name,id] of Object.entries(rows)){
    await locate(id);
    report.tables[name]=await measure(id);
    if((name==="direct"||name==="discovery") && (size.width!==390 || v==="after")){
      const clip=await p.locator("#"+id).evaluate(b=>{
        const w=b.closest(".table-wrap").getBoundingClientRect(), l=Math.max(0,Math.floor(w.left-8)), t=Math.max(0,Math.floor(w.top-68));
        return {x:l,y:t,width:Math.max(1,Math.min(innerWidth-l,Math.ceil(w.right+8-l))),height:Math.max(1,Math.min(innerHeight-t,Math.ceil(w.bottom+10-t)))};
      });
      await p.screenshot({path:path.join(out,v+"-"+name+"-"+size.width+".png"),clip,animations:"disabled"});
    }
  }
  if (v === "after") {
    console.log(size.width,["discovery","direct"].map(k=>k+": "+report.tables[k].visible+" rows, "+JSON.stringify(report.tables[k].heights)).join("; "));
    assert.deepEqual(await p.locator("#resultBody tr").evaluateAll(rs=>rs.map(r=>r.querySelector("strong")?.textContent.trim())),fixture.job.results.filter(r=>r.resultType === "product_match").map(r=>r.keyword));
    const checkedGroups=[
      [rows.discovery,fixture.discoveries.items],[rows.early,fixture.earlyApi.items],[rows.period,fixture.period.results],[rows.top,fixture.period.results.slice(0,10)],
      [rows.domain,fixture.job.results.filter(r=>["domain_related_signal","unverified_context_signal"].includes(r.resultType))],
      [rows.ratio,fixture.job.results.filter(r=>r.resultType==="ratio_only_market_signal")],[rows.low,fixture.job.results.filter(r=>r.resultType==="low_intensity_early_signal")]
    ];
    for(const [id,expectedRows] of checkedGroups)assert.deepEqual(await p.locator("#"+id+" tr[data-cmp-keyword]").evaluateAll(rs=>rs.map(r=>r.dataset.cmpKeyword)),expectedRows.map(r=>r.keyword),id+" order");
    // Clamp only presentation nodes; verify that even the genuinely clipped product
    // remains intact in the same row's detail template, not a shortened string.
    const clamps=await p.locator("#resultBody tr").evaluateAll(rs=>rs.flatMap(r=>{
      const el=r.querySelector(".cmp-product");
      if(!el || el.scrollHeight<=el.clientHeight+1)return [];
      const css=getComputedStyle(el), content=r.querySelector("template").content.textContent;
      return [{keyword:r.dataset.cmpKeyword, product:el.textContent,lines:css.webkitLineClamp,
        visibleHeight:el.clientHeight,lineHeight:parseFloat(css.lineHeight),fullInDetail:content.includes(el.textContent)}];
    }));
    assert(clamps.length>0,"fixture should exercise real text overflow");
    for(const c of clamps)assert(c.fullInDetail && c.lines==="2" && c.visibleHeight<=2*c.lineHeight+1,"long text clipped in detail or more than 2 lines: "+c.keyword);
    report.clampedProducts=clamps;
    for(const [id,original,amount,date] of [[rows.direct,fixture.job.results.filter(r=>r.resultType==="product_match"),1,6],[rows.period,fixture.period.results,2,6]]) {
      const values=await p.locator("#"+id+" tr").evaluateAll((rs,[a,d])=>rs.map(r=>[r.cells[a].innerText,r.cells[d].innerText]),[amount,date]);
      original.forEach((r,i)=>{
        if(r.estimatedSurgeCount!=null)assert(values[i][0].includes(Number(r.estimatedSurgeCount).toLocaleString("ko-KR")),r.keyword+" amount");
        if(r.latestDataDate) assert(values[i][1].includes(r.latestDataDate),r.keyword+" date");
      });
    }
    assert.equal(report.tables.discovery.count,fixture.discoveries.items.length);
    assert.equal(report.tables.period.count,fixture.period.results.length);
    assert.equal(report.tables.early.count,fixture.earlyApi.items.length);
    if(size.width>=1024) for(const name of ["direct","discovery"]) assert(report.tables[name].visible>=7,name+" visible "+report.tables[name].visible);
    for (const id of [rows.direct,rows.discovery,rows.early]) {
      await locate(id);
      const pinned=await p.locator("#"+id).evaluate(b=>{
        const w=b.closest(".table-wrap"), head=w.querySelector("thead th"), kw=b.querySelector(".cmp-key"), detail=b.querySelector("[data-cmp-open]"), edges=w.getBoundingClientRect();
        w.scrollTop=160; w.scrollLeft=w.scrollWidth;
        const h=head.getBoundingClientRect(), k=kw.getBoundingClientRect(), d=detail.getBoundingClientRect();
        w.scrollTop=0;w.scrollLeft=0;
        return {header:Math.abs(h.top-edges.top)<4, key:k.left>=edges.left-1 && k.right<=edges.right+1,
          detail:d.left>=edges.left-1 && d.right<=edges.right+1, detailHeight:d.height, x:edges.x,width:edges.width,
          keywordBounds:[k.left,k.right],detailBounds:[d.left,d.right]};
      });
      assert(pinned.header,"sticky header in "+id+": "+JSON.stringify(pinned));
      if(size.width===390) {
        assert(pinned.key && pinned.detail,"narrow pins in "+id+": "+JSON.stringify(pinned));
        assert(pinned.x>=0 && pinned.x+pinned.width<=391,"narrow viewport overflow in "+id+": "+JSON.stringify(pinned));
      }
    }
    const first=p.locator("#resultBody tr").filter({hasText:"알티지오메가3"}).first(), open=first.locator("[data-cmp-open]").first(), dialog=p.locator("#cmpDetailDialog");
    await locate(rows.direct); await open.focus();
    const scrollPos=()=>open.evaluate(el=>({page:scrollY,list:el.closest(".table-wrap").scrollTop}));
    const start=await scrollPos();await p.keyboard.press("Enter");
    await dialog.waitFor({state:"visible"});
    const body=await dialog.innerText(), row=fixture.job.results.find(r=>r.keyword==="알티지오메가3");
    for(const product of [row.match.item.product,...row.match.additionalMatches.map(m=>m.item.product)]) assert(body.includes(product),"missing "+product);
    assert(body.includes(row.latestDataDate));assert(body.includes(fixture.job.jobId));
    if(size.width===1440)await p.screenshot({path:path.join(out,"after-detail-1440.png"),animations:"disabled"});
    await p.keyboard.press("Escape");await dialog.waitFor({state:"hidden"});
    assert.deepEqual(await scrollPos(), start,"scroll position"); assert(await open.evaluate(el=>el===document.activeElement));
    await first.locator("[data-cmp-history]").click();await dialog.waitFor({state:"visible"});
    const history=await dialog.innerText();
    for(const sample of row.surgeHistoryState.recentHistory)assert(history.includes(sample.date)||history.includes(sample.date.slice(5)),"missing history "+sample.date);
    await p.keyboard.press("Escape");await dialog.waitFor({state:"hidden"});
    const next=p.locator("#resultBody tr").filter({hasText:"필립스5000X"}).first().locator("[data-cmp-open]").first();
    await next.click();assert((await dialog.innerText()).includes("필립스5000X"));assert(!(await dialog.innerText()).includes(row.match.item.product));
    await p.locator("#cmpDetailClose").click();
    const search=p.locator("#periodResultSearch"), needle=fixture.period.results[0].keyword;
    await search.fill(needle);
    const expected=fixture.period.results.filter(r=>r.keyword.toLowerCase().includes(needle.toLowerCase()));
    assert.equal(await p.locator("#periodAnalysisBody tr").count(),expected.length);
    await p.locator("#periodAnalysisBody [data-cmp-open]").first().click();await p.keyboard.press("Escape");assert.equal(await search.inputValue(),needle);
    report.checks={keyboard:true,focusAndScrollRestored:true,additionalProducts:row.match.additionalMatches.length,historyPoints:row.surgeHistoryState.recentHistory.length,detailNotMixed:true,searchValue:needle,filteredCount:expected.length};
    await p.locator("[data-cmp-density='relaxed']").first().click();assert.equal(await p.evaluate(()=>document.documentElement.dataset.cmpDensity),"relaxed");
    await locate(rows.discovery);report.relaxed=await measure(rows.discovery);
    await seed(); assert.equal(await p.evaluate(()=>document.documentElement.dataset.cmpDensity),"relaxed");
    await p.locator("[data-cmp-density='compact']").first().click();assert.equal(await p.evaluate(()=>document.documentElement.dataset.cmpDensity),"compact");
    report.checks.densityPersists=true;
    if(size.width===1440) {
      const archive = process.env.DASHBOARD_BRAND_FIXTURE || path.join(root,"data/live-instant-final/instant.json");
      const job = JSON.parse(fs.readFileSync(archive,"utf8")), matches=job.results.filter(r=>r.resultType==="brand_or_category_signal");
      assert(matches.length>0);
      await p.evaluate(job=>displayCompletedAnalysis(job,{restored:true}),job);
      assert.deepEqual(await p.locator("#brandSignalBody tr").evaluateAll(rs=>rs.map(r=>r.dataset.cmpKeyword)),matches.map(r=>r.keyword));
      await p.locator("#brandSignalBody [data-cmp-open]").first().click(); assert((await dialog.innerText()).includes(matches[0].keyword));assert((await dialog.innerText()).includes(job.jobId));
      report.checks.archivedBrandRows=matches.length;
    }
  }
  assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);report.localFixtureReads=reads;report.externalCalls=forbidden.length;
  await ctx.close();
  await output(v+"-"+size.width+".json",report);
  console.log(v,size.width,...["discovery","direct"].map(k=>k+" "+report.tables[k].visible+"/"+report.tables[k].count+" ("+JSON.stringify(report.tables[k].heights)+" px)"));
}
(async()=>{
  const browser=await pw.chromium.launch({executablePath:chrome,headless:true,args:["--disable-background-networking","--disable-component-update","--disable-extensions","--host-resolver-rules=MAP * ~NOTFOUND"]});
  try {
    for(const v of ["before","after"]) {
      if((args.has("--before-only") && v!=="before") || (args.has("--after-only") && v!=="after"))continue;
      for(const size of [{width:1440,height:900},{width:1920,height:1080},{width:390,height:844}])await render(browser,v,size);
    }
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
