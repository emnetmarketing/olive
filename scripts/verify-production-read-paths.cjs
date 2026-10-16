#!/usr/bin/env node
"use strict";
// Read-only application verification; the only mutation is the authorized
// restore of the known healthy deployment if a critical read check fails.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const assert = require("node:assert/strict");
const ROOT = path.resolve(__dirname, ".."), SITE = "dc4e873a-5b98-40de-a2f8-9c36e9f7e8bc";
const ORIGIN = "https://olive-trend-monitor.netlify.app";
const TARGET = "65451706-37ad-4a63-abbb-d09055acd1a5", MORNING = "3e995803-b13e-4c8b-bdc5-8188966457e6";
const INSTANT = "c872eb9f-0a74-4503-9616-a4bba0f50f68", HEALTHY = "6a9a6ee0f88f8300080bc18f";
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === "object"
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
const digest = x => crypto.createHash("sha256").update(JSON.stringify(canonical(x))).digest("hex");
const bytesHash = x => crypto.createHash("sha256").update(x).digest("hex");
async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, "netlify/Config/config.json")));
  const token = config.users[config.userId].auth.token;
  const state = JSON.parse(fs.readFileSync(path.join(ROOT, "data/verified-functions-deploy-state.json")));
  assert.match(state.deployId, /^[a-f0-9]{24}$/);
  const report = { deployId: state.deployId, commit: state.commit, sourceApiCalls: 0, applicationWrites: 0, checks: [] };
  const api = async (route, method = "GET") => {
    const r = await fetch(`https://api.netlify.com/api/v1${route}`, { method, headers: { Authorization: `Bearer ${token}` },
      redirect: "error", signal: AbortSignal.timeout(45000) });
    assert.equal(r.status, 200, `Netlify ${method} ${route} status ${r.status}`); return r.json();
  };
  assert.equal((await api(`/sites/${SITE}`)).published_deploy.id, state.deployId);
  const out = path.join(ROOT, "data/production-package-verification"); fs.mkdirSync(out, { recursive: true });
  try {
    for (const [name, route, expectedJob, count] of [
      ["instant", "trend-analysis-latest?mode=instant&result=full", INSTANT, 59],
      ["period", "trend-analysis-latest?mode=period&result=full", TARGET, 439],
      ["target-status", `trend-analysis-status?jobId=${TARGET}`, TARGET, 439],
      ["morning", `trend-analysis-status?jobId=${MORNING}`, MORNING, 439],
      ["period-snapshot", "signal-snapshot-latest?mode=period", TARGET, 439],
      ["instant-snapshot", "signal-snapshot-latest?mode=instant", INSTANT, 59],
      ["current", "trend-analysis-current", null, null]
    ]) {
      const r = await fetch(`${ORIGIN}/.netlify/functions/${route}`, { redirect: "error", signal: AbortSignal.timeout(45000) });
      const text = await r.text(); let value; try { value = JSON.parse(text); } catch { value = null; }
      report.checks.push({ name, status: r.status, requestId: r.headers.get("x-nf-request-id"),
        jobId: value?.jobId, rows: value?.results?.length ?? value?.items?.length ?? null });
      assert.equal(r.status, 200, `${name} HTTP ${r.status}`); assert.ok(value, `${name} JSON response missing`);
      if (expectedJob) assert.equal(value.jobId, expectedJob, `${name} Job mismatch`);
      if (count !== null) assert.equal((value.results || value.items || []).length, count, `${name} row count`);
      fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(value));
    }
    const period = JSON.parse(fs.readFileSync(path.join(out, "period.json")));
    const status = JSON.parse(fs.readFileSync(path.join(out, "target-status.json")));
    const snapshot = JSON.parse(fs.readFileSync(path.join(out, "period-snapshot.json")));
    assert.equal(digest(period.results), digest(status.results));
    assert.equal(digest(period.results), "e4b13ed57533dd81c2811faa1a7e6349d17af313c28920e209cd1e3970f34d32");
    assert.deepEqual(snapshot.items.map(x => x.keyword), period.results.map(x => x.keyword));
    assert.equal(period.startDate, "2026-10-01"); assert.equal(period.endDate, "2026-10-16");
    assert.equal(period.actualDataStartDate, "2026-10-01"); assert.equal(period.actualDataEndDate, "2026-10-14");
    const html = await fetch(ORIGIN, { redirect: "error", signal: AbortSignal.timeout(30000) });
    assert.equal(html.status, 200); const bytes = Buffer.from(await html.arrayBuffer());
    assert.equal(bytesHash(bytes), bytesHash(fs.readFileSync(path.join(ROOT, "index.html"))));
    fs.writeFileSync(path.join(out, "index.html"), bytes);
    report.resultDigest = digest(period.results); report.actualData = [period.actualDataStartDate, period.actualDataEndDate];
    report.readsVerified = true; report.rollbackPerformed = false;
  } catch (error) {
    report.failure = String(error.message).replaceAll(token, "[REDACTED]");
    await api(`/sites/${SITE}/deploys/${HEALTHY}/restore`, "POST");
    assert.equal((await api(`/sites/${SITE}`)).published_deploy.id, HEALTHY);
    report.rollbackPerformed = true; report.restoredDeploy = HEALTHY;
    process.exitCode = 1;
  }
  fs.writeFileSync(path.join(out, "read-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(`Production read verification stopped: ${error.message}`); process.exitCode = 1; });
