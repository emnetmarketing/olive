const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync("index.html", "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1]).filter((script) => script.trim());

scripts.forEach((script) => new Function(script));
assert.equal(html.includes("sampleInstagram"), false);
assert.equal(html.includes("sampleNaver"), false);
assert.match(html, /fetch\("\/\.netlify\/functions\/trend-analysis-start"/);
assert.match(html, /operatingSettingsSaveBtn/);
assert.match(html, /fetch\("\/\.netlify\/functions\/operating-settings"/);
assert.match(html, /min="1" max="10000000" step="1" value="300"/);
assert.match(html, /id="matchThreshold"[^>]+value="40"/);
assert.equal(html.includes('id="excelUpload"'), false);
assert.equal(html.includes('id="naverData"'), false);
assert.equal(html.includes("handleExcelUpload"), false);
assert.equal(html.includes("XLSX"), false);
assert.match(html, /requireEdit\("Search Ad 상품 새로고침"\)/);
assert.match(html, /requireEdit\("검색어 후보 새로고침"\)/);
assert.match(html, /requireEdit\("자동 수집 설정 열기"\)/);
assert.match(html, /apiTabBtn"\)\.disabled = !editable/);
assert.match(html, /\["runBtn", "instantRunBtn", "excelDownloadBtn", "downloadHistoryBtn", "teamsBtn"\]/);
assert.match(html, /analyze\("instant"\)/);
assert.match(html, /formatSurgeHistory/);
assert.match(html, /급등 이력/);
assert.match(html, /검색어 후보 새로고침/);
assert.match(html, /Search Ad 상품 새로고침/);
assert.match(html, /fetch\("\/\.netlify\/functions\/search-ad-refresh"/);
assert.match(html, /fetch\("\/\.netlify\/functions\/search-ad-cache-status"/);
assert.equal(html.includes('id="naverClientSecret"'), false);
assert.equal(html.includes('id="naverSecretKey1"'), false);
assert.equal(html.includes("clientId, clientSecret, category"), false);
console.log(`index.html inline JavaScript OK (${scripts.length} script)`);
