const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { lastSuccessKeys, lastPartialKeys } = require("../netlify/functions/trend-analysis-cache");

test("last-success pointers are split by mode and include a shared latest pointer", () => {
  assert.deepEqual(lastSuccessKeys("instant"), { mode: "last-success/instant", latest: "last-success/latest" });
  assert.deepEqual(lastSuccessKeys("period"), { mode: "last-success/period", latest: "last-success/latest" });
});

test("partial results have separate pointers and cannot replace full success", () => {
  assert.deepEqual(lastPartialKeys("instant"), { mode: "last-partial/instant", latest: "last-partial/latest" });
  assert.deepEqual(lastPartialKeys("period"), { mode: "last-partial/period", latest: "last-partial/latest" });
  const source = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "trend-analysis-background.js"), "utf8");
  assert.match(source, /if \(partialAnalysis\) await writeLastPartial\(job\); else await writeLastSuccess\(job\)/);
});

test("background analysis publishes last-success only after completion", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "netlify", "functions", "trend-analysis-background.js"),
    "utf8",
  );
  const completed = source.indexOf('state: "completed"');
  const publish = source.indexOf("writeLastSuccess(job)");
  assert.ok(completed >= 0);
  assert.ok(publish > completed);
});

test("frontend restores the latest completed analysis on startup", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(html, /trend-analysis-latest\?mode=/);
  assert.match(html, /async function loadLastSuccessfulAnalysis/);
  assert.match(html, /displayCompletedAnalysis\(job, \{ restored: true \}\)/);
});
