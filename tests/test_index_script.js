const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync("index.html", "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1]).filter((script) => script.trim());

scripts.forEach((script) => new Function(script));
assert.equal(html.includes("sampleInstagram"), false);
assert.equal(html.includes("sampleNaver"), false);
assert.match(html, /fetch\("\/\.netlify\/functions\/naver-analysis"/);
assert.equal(html.includes('id="naverClientSecret"'), false);
assert.equal(html.includes('id="naverSecretKey1"'), false);
assert.equal(html.includes("clientId, clientSecret, category"), false);
console.log(`index.html inline JavaScript OK (${scripts.length} script)`);
