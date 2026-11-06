const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { extractFunction } = require("../scripts/verify-deployed-period-display.cjs");
const html = fs.readFileSync("index.html","utf8");
const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,"").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,"");

test("navigation retains one instance of every settings and result element", () => {
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(ids.length,new Set(ids).size,"static IDs must be unique");
  const drawer = markup.slice(markup.indexOf('<dialog id="shellSettingsDialog"'),markup.indexOf('<dialog id="cmpDetailDialog"'));
  const nav = markup.slice(markup.indexOf('<aside class="shell-sidebar"'),markup.indexOf("</aside>",markup.indexOf('<aside class="shell-sidebar"')));
  for (const id of ["monitorTabBtn","apiTabBtn","monitorPanel","apiPanel","surgeThreshold","matchThreshold","operatingSettingsSaveBtn","operatingSettingsStatus","saveBtn","apiBtn","apiSaveStatus"]) {
    assert.ok(drawer.includes('id="'+id+'"'),id+" stays in the settings drawer");
    assert.ok(!nav.includes('id="'+id+'"'));
  }
  for(const id of ["shellKeywordNav","shellVideoNav","shellSettingsBtn","shellKeywordView","shellVideoView"])assert.ok(ids.includes(id));
});

test("video is explicitly a placeholder without collection controls or player", () => {
  const video = markup.slice(markup.indexOf('<div id="shellVideoView"'),markup.indexOf("</main>"));
  assert.match(video,/hidden/);
  for(const label of ["트렌드 영상","영상 콘텐츠 모니터링 기능을 준비 중입니다.","현재 트렌드 검색어 기능은 기존과 동일하게 이용할 수 있습니다."])assert.ok(video.includes(label));
  assert.doesNotMatch(video,/<(?:button|iframe|video|audio|input)\b/i);
  assert.match(markup,/id="teamsBtn"[^>]+data-shell-keyword-control/);
  assert.match(markup,/header-analysis-controls" data-shell-keyword-control/);
});

test("view switches are local visibility changes, never re-initialize or mutate jobs", () => {
  const fn = extractFunction(html,"initShellNavigation");
  assert.match(fn,/keyword\.hidden = view !== "keyword"/);
  assert.match(fn,/video\.hidden = view !== "video"/);
  assert.match(fn,/if \(!keyword \|\| !video \|\| !dialog \|\| keyword\.dataset\.shellBound\) return/);
  assert.doesNotMatch(fn,/fetch\(|\.innerHTML\s*=|initializeApp\(|setInterval\(|clearInterval\(|saveSettings\(|saveOperatingSettings\(|analyze\(/);
  assert.match(fn,/state\.currentUser \|\| dialog\.open/);
  assert.match(fn,/settings\.focus\(\{ preventScroll:true \}\)/);
});

test("opening settings preserves editor guard and committed analysis settings", () => {
  const permissions = extractFunction(html,"applyPermissions");
  assert.ok(permissions.includes('$("apiTabBtn").disabled = !editable'));
  assert.ok(extractFunction(html,"saveOperatingSettings").includes('requireEdit("운영 설정 저장")'));
  const analysis = extractFunction(html,"analyze");
  assert.doesNotMatch(analysis, /\$\("(?:surgeThreshold|matchThreshold)"\)\.value/);
  assert.ok(analysis.includes("state.operatingSettings"));
});
