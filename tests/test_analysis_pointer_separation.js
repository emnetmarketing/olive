const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const snapshots = require("../netlify/functions/signal-snapshot-cache");

test("snapshot pointer keys are explicitly split by analysis mode", () => {
  assert.equal(snapshots.modeKey(snapshots.LATEST_VALID_KEY, "instant"), "latest-valid-v1/instant");
  assert.equal(snapshots.modeKey(snapshots.LATEST_VALID_KEY, "period"), "latest-valid-v1/period");
  assert.equal(snapshots.modeKey(snapshots.LATEST_ANALYSIS_KEY, "instant"), "latest-analysis-v1/instant");
  assert.equal(snapshots.modeKey(snapshots.LATEST_ANALYSIS_KEY, "period"), "latest-analysis-v1/period");
});

test("period snapshots and extremely low coverage instant snapshots cannot become main latest", () => {
  const healthy = { mode: "instant", trendCoveragePct: 66.6, latestDataDate: "2026-09-01" };
  assert.equal(snapshots.shouldPromoteInstant({ mode: "period", trendCoveragePct: 80, latestDataDate: "2026-09-01" }, healthy), false);
  assert.equal(snapshots.shouldPromoteInstant({ mode: "instant", trendCoveragePct: 0.36, latestDataDate: "2026-09-01" }, healthy), false);
  assert.equal(snapshots.shouldPromoteInstant({ mode: "instant", trendCoveragePct: 20, latestDataDate: "2026-09-02" }, healthy), false);
});

test("meaningful partial instant snapshots can advance main latest without a severe coverage regression", () => {
  const healthy = { mode: "instant", trendCoveragePct: 66.6, latestDataDate: "2026-09-01" };
  assert.equal(snapshots.shouldPromoteInstant({ mode: "instant", trendCoveragePct: 66.6, latestDataDate: "2026-09-02" }, healthy), true);
  assert.equal(snapshots.shouldPromoteInstant({ mode: "instant", trendCoveragePct: 40, latestDataDate: "2026-09-02" }, healthy), true);
  assert.equal(snapshots.shouldPromoteInstant({ mode: "instant", trendCoveragePct: 10, latestDataDate: "2026-09-02" }, null), true);
});

test("dashboard restores instant and period independently and renders period into its own panel", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /loadLastSuccessfulAnalysis\("instant"\)/);
  assert.match(html, /loadLastSuccessfulAnalysis\("period"\)/);
  assert.match(html, /if \(job\.mode === "period"\) return displayPeriodAnalysis/);
  assert.match(html, /periodAnalysisPanel/);
  assert.match(html, /선택 기간 분석/);
  assert.match(html, /최신 결과 다시 계산/);
});

test("trend status and main snapshot APIs are pinned to instant mode", () => {
  const status = fs.readFileSync("netlify/functions/trend-cache-status.js", "utf8");
  const latest = fs.readFileSync("netlify/functions/signal-snapshot-latest.js", "utf8");
  assert.match(status, /readLastSuccess\("instant"\)/);
  assert.match(status, /readLastPartial\("instant"\)/);
  assert.match(status, /readLatestSnapshot\("instant"\)/);
  assert.match(latest, /mode = event\.queryStringParameters\?\.mode === "period" \? "period" : "instant"/);
});

test("period completion cannot write the legacy main valid pointer", () => {
  const source = fs.readFileSync("netlify/functions/signal-snapshot-cache.js", "utf8");
  assert.match(source, /if \(snapshot\.mode === "period"\)[\s\S]*modeKey\(LATEST_VALID_KEY, "period"\)/);
  assert.match(source, /else \{[\s\S]*LATEST_VALID_KEY, pointer/);
});

test("instant completion preserves the period latest analysis pointer", () => {
  const source = fs.readFileSync("netlify/functions/signal-snapshot-cache.js", "utf8");
  assert.match(source, /setJSON\(modeKey\(LATEST_ANALYSIS_KEY, snapshot\.mode\), pointer\)/);
  assert.doesNotMatch(source, /delete\(/);
});

test("period results display their own requested dates and cache coverage", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /분석 기간 \$\{job\.startDate/);
  assert.match(html, /Trend coverage \$\{available/);
  assert.match(html, /cache window 부족/);
});

test("main yesterday metadata is updated only by the instant renderer", () => {
  const html = fs.readFileSync("index.html", "utf8");
  const periodStart = html.indexOf("function displayPeriodAnalysis");
  const instantStart = html.indexOf("function displayCompletedAnalysis");
  assert.ok(periodStart >= 0 && instantStart > periodStart);
  assert.doesNotMatch(html.slice(periodStart, instantStart), /yesterdaySurgeMeta/);
  assert.match(html.slice(instantStart), /yesterdaySurgeMeta/);
});

test("period analysis does not clear the main automatic results", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /if \(mode === "instant"\) clearAnalysisUI/);
  assert.doesNotMatch(html, /if \(mode === "period"\) clearAnalysisUI/);
});

test("period polling cannot replace the main current analysis state", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /if \(job\.mode === "period"\) state\.currentPeriodAnalysisJob = job;[\s\S]*else state\.currentAnalysisJob = job/);
});

test("instant analysis does not clear the period result panel", () => {
  const html = fs.readFileSync("index.html", "utf8");
  const analyze = html.slice(html.indexOf("async function analyze"), html.indexOf("function finishAnalysisControls"));
  assert.match(analyze, /if \(mode === "instant"\) clearAnalysisUI[\s\S]*else \{[\s\S]*periodAnalysisBody/);
});

test("today Early Signal remains backed by its independent cache endpoint", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /today-early-signals/);
  assert.doesNotMatch(fs.readFileSync("netlify/functions/signal-snapshot-cache.js", "utf8"), /today-early-signal-cache/);
});

test("market confidence fields remain in both snapshot modes", () => {
  const item = snapshots.compactItem({ keyword: "신뢰도", marketConfidenceScore: 72, marketConfidenceGrade: "strong", marketConfidenceReasons: ["NAVER 급등 확인"] });
  assert.equal(item.marketConfidenceScore, 72);
  assert.equal(item.marketConfidenceGrade, "strong");
});

test("button help explicitly states external API and main-pointer behavior", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /외부 API를 호출하지 않습니다/);
  assert.match(html, /메인 최신 결과에는 영향을 주지 않습니다/);
});

test("Fast Path start remains the only user analysis entrypoint", () => {
  const html = fs.readFileSync("index.html", "utf8");
  const analyze = html.slice(html.indexOf("async function analyze"), html.indexOf("function finishAnalysisControls"));
  assert.match(analyze, /trend-analysis-start/);
  assert.doesNotMatch(analyze, /openapi|datalab|keywordstool|youtube/i);
});
