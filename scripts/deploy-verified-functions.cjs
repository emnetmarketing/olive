#!/usr/bin/env node
"use strict";

// Exact-artifact upload, following Netlify CLI src/utils/deploy/{hash-fns,
// deploy-site,upload-files}. No build, source API, Blob or application call.
// `plan` is read-only remotely; `upload` creates at most ONE deploy.
// Draft is the default. --production true explicitly opts into ONE direct
// Production upload; never unlock site publishing or create a replacement.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");
const SITE = "dc4e873a-5b98-40de-a2f8-9c36e9f7e8bc";
const HEALTHY = "6a9a6ee0f88f8300080bc18f";
const API = "https://api.netlify.com/api/v1";
const SCHEDULES = {
  "keyword-candidate-scheduled": "0 17 * * *",
  "market-discovery-scheduled": "0 */6 * * *",
  "trend-data-collection-recovery-scheduled": "0 23 * * *",
  "trend-data-collection-scheduled": "0 21 * * *",
};
const sha = (bytes, algorithm = "sha256") => crypto.createHash(algorithm).update(bytes).digest("hex");
const json = file => JSON.parse(fs.readFileSync(file, "utf8"));
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === "object"
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
const digest = x => sha(JSON.stringify(canonical(x)));
const within = (base, target) => target.startsWith(base + path.sep);
const git = args => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function parseArgs(argv) {
  const mode = argv[0] || "plan";
  assert.ok(["plan", "upload", "publish"].includes(mode), "Use plan, upload, or publish");
  const args = { mode };
  for (let i = 1; i < argv.length; i += 2) {
    assert.ok(/^--[a-z-]+$/.test(argv[i]) && argv[i + 1], "Every flag requires a value");
    assert.ok(["--artifacts", "--state", "--commit", "--expected-published", "--confirm-publish", "--production"].includes(argv[i]), "Unknown option");
    args[argv[i].slice(2)] = argv[i + 1];
  }
  args.artifacts = path.resolve(ROOT, args.artifacts || "data/build-smoke/native-functions-portable");
  args.state = path.resolve(ROOT, args.state || "data/verified-functions-deploy-state.json");
  assert.ok(within(path.join(ROOT, "data"), args.state), "State must remain under ignored data/");
  assert.ok(git(["check-ignore", args.state]), "State must be Git-ignored");
  args.expectedPublished = args["expected-published"] || HEALTHY;
  assert.match(args.expectedPublished, /^[a-f0-9]{24}$/);
  args.commit = args.commit || git(["rev-parse", "HEAD"]);
  assert.match(args.commit, /^[a-f0-9]{40}$/);
  assert.ok(args.production === undefined || args.production === "true" || args.production === "false", "--production must be true or false");
  args.production = args.production === "true";
  return args;
}

function loadVerifiedArtifacts(dir) {
  const manifest = json(path.join(dir, "manifest.json"));
  const evidence = json(path.join(dir, "build-evidence.json"));
  const report = json(path.join(dir, "execution-report.json"));
  assert.equal(evidence.version, "16.3.0");
  assert.equal(evidence.hostNode, "v22.23.3");
  assert.equal(evidence.symlinkCount, 0);
  assert.equal(evidence.entryCount, 31);
  assert.equal(report.node, "v22.23.3");
  assert.equal(report.ancestorModulesDisabled, true);
  assert.equal(report.workspaceModuleFallback, false);
  assert.equal(report.zipEntryCount, 31);
  assert.equal(manifest.functions.length, 31);
  assert.equal(report.artifacts.length, 31);
  const imported = report.results.find(r => r.mode === "imports");
  const execution = report.results.find(r => r.mode === "execution");
  assert.equal(imported?.imported, 31);
  assert.equal(imported?.externalCalls, 0);
  for (const key of ["bootstrapExecuted", "nativeContext", "latestStatusSnapshotJobMatch"]) assert.equal(execution?.[key], true, key);
  assert.equal(execution?.sourceApiCalls, 0);
  assert.equal(execution?.productionCalls, 0);
  assert.equal(execution?.canonicalPeriodRows, execution?.excelPeriodRows);
  assert.deepEqual(execution?.probePhases, [1, 2]);
  for (const key of ["duplicateBlocked", "staleBlocked", "publicationFailureProtected", "publicationRetrySucceeded",
    "instantPublicationVerified", "instantPreviousProtected", "normalWorkerClaimVerified", "normalWorkerFrozenInputsVerified",
    "normalWorkerCheckpointResumeVerified"]) assert.equal(execution?.probeReport?.[key], true, key);
  assert.deepEqual(execution.sdkVersions, ["10.7.12"]);
  for (const [relative, expected] of Object.entries(evidence.inputs)) {
    const file = path.resolve(ROOT, relative);
    assert.ok(within(ROOT, file), "Input outside repository");
    assert.equal(sha(fs.readFileSync(file)), expected, `Build input changed: ${relative}`);
  }
  const functions = {}, functionsConfig = {}, uploads = new Map(), schedules = [];
  for (const fn of manifest.functions) {
    assert.match(fn.name, /^[a-z0-9-]+$/);
    assert.ok(!functions[fn.name], "Duplicate function");
    const file = path.join(dir, `${fn.name}.zip`), bytes = fs.readFileSync(file), hash = sha(bytes);
    assert.equal(path.resolve(fn.path), path.resolve(file));
    const built = evidence.functions.find(f => f.name === fn.name);
    const tested = report.artifacts.find(f => f.name === fn.name);
    assert.equal(hash, built?.sha256, `ZIP build mismatch: ${fn.name}`);
    assert.equal(hash, tested?.sha256, `ZIP execution mismatch: ${fn.name}`);
    assert.equal(tested.normalizedLinks.length, 0);
    assert.equal(built.errors.length, 0);
    assert.equal(fn.runtimeVersion, "nodejs22.x");
    assert.equal(fn.buildData?.runtimeAPIVersion, 2);
    assert.equal(fn.buildData?.bootstrapVersion, "2.24.0");
    assert.equal(fn.invocationMode, fn.name.endsWith("-background") ? "background" : "stream");
    functions[fn.name] = hash;
    functionsConfig[fn.name] = Object.fromEntries(Object.entries({
      display_name: fn.displayName, excluded_routes: fn.excludedRoutes, generator: fn.generator,
      memory: fn.memory, region: fn.region, routes: fn.routes, build_data: fn.buildData,
      priority: fn.priority, vcpu: fn.vcpu,
    }).filter(([, value]) => value !== undefined));
    assert.ok(!fn.trafficRules, "Unexpected traffic rules require explicit mapping review");
    if (fn.schedule) schedules.push({ name: fn.name, cron: fn.schedule });
    uploads.set(hash, { name: fn.name, bytes, runtime: fn.runtimeVersion, invocationMode: fn.invocationMode, timeout: fn.timeout });
  }
  assert.deepEqual(Object.fromEntries(schedules.map(x => [x.name, x.cron])), SCHEDULES);
  return { functions, functionsConfig, schedules, uploads, inputPaths: Object.keys(evidence.inputs),
    inputDigest: digest(evidence.inputs), executionDigest: digest(report), manifestDigest: digest(manifest) };
}

function readAuth() {
  const config = json(path.join(process.env.APPDATA, "netlify", "Config", "config.json"));
  const token = config.users?.[config.userId]?.auth?.token;
  assert.ok(typeof token === "string" && token.length > 10, "Existing Netlify CLI authentication unavailable");
  return token;
}

function client(token, mode, transport = fetch) {
  const redact = value => String(value).replaceAll(token, "[REDACTED]").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  return async function request(route, { method = "GET", body, binary = false } = {}) {
    assert.ok(route.startsWith("/") && !route.startsWith("//"));
    assert.ok(mode !== "plan" || method === "GET", "Plan cannot perform remote writes");
    const response = await transport(API + route, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : {
        "Content-Type": binary ? "application/octet-stream" : "application/json",
      }) }, body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
      redirect: "error", signal: AbortSignal.timeout(60000),
    });
    const text = await response.text();
    let value; try { value = text ? JSON.parse(text) : null; } catch { value = null; }
    if (!response.ok) throw new Error(`Netlify ${method} ${route.split("?")[0]} returned ${response.status}: ${redact(value?.code || value?.message || "non-JSON or empty error").slice(0, 300)}`);
    return value;
  };
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, file);
}

async function makePlan(args, api, verified, previousState) {
  const site = await api(`/sites/${SITE}`);
  assert.equal(site.published_deploy?.id, args.expectedPublished, "Published deploy changed; do not proceed automatically");
  const oldFiles = previousState?.files || await api(`/sites/${SITE}/files`);
  const files = {}, uploadFiles = new Map();
  const entries = Array.isArray(oldFiles) ? oldFiles.map(f => [f.path || f.id, f.sha]) : Object.entries(oldFiles);
  for (const [original, hash] of entries) {
    const name = original.replace(/^\//, "");
    assert.ok(name && !name.includes("..") && !name.includes("\\") && !/[?#]/.test(name), "Unsafe published path");
    assert.ok(!/^(data|node_modules|\.git|\.aws|\.codex)\/|(^|\/)\.env(?:\.|$)|credentials|\.pem$/i.test(name), "Published file list contains a sensitive path; manual review required");
    assert.match(hash, /^[a-f0-9]{40}$/);
    files[name] = hash;
  }
  for (const name of ["index.html", "netlify.toml"]) {
    const bytes = fs.readFileSync(path.join(ROOT, name)), hash = sha(bytes, "sha1");
    files[name] = hash; uploadFiles.set(hash, { name, bytes });
  }
  const headers = Buffer.from("/.netlify/functions/*\n  Cache-Control: no-store\n  X-Content-Type-Options: nosniff\n", "utf8");
  files._headers = sha(headers, "sha1"); uploadFiles.set(files._headers, { name: "_headers", bytes: headers });
  const body = { files, functions: verified.functions, function_schedules: verified.schedules,
    functions_config: verified.functionsConfig, async: false, draft: !args.production, branch: "main", build_version: "37.4.1" };
  const plan = { version: 1, siteId: SITE, basePublishedId: args.expectedPublished, commit: args.commit,
    inputDigest: verified.inputDigest, executionDigest: verified.executionDigest, manifestDigest: verified.manifestDigest,
    payloadDigest: digest(body), files, functionHashes: verified.functions, createdAt: previousState?.createdAt || new Date().toISOString() };
  if (previousState) for (const key of ["siteId", "basePublishedId", "commit", "inputDigest", "executionDigest", "manifestDigest", "payloadDigest"])
    assert.equal(plan[key], previousState[key], `Existing deployment state differs: ${key}`);
  return { plan, body, uploadFiles };
}

// The complete, verified manifest is present on CREATE. An empty deploy can
// become ready before the function manifest arrives, so it is never created.
// Persist the attempt BEFORE sending it: an uncertain response must not cause a
// second deploy or build. Operator recovery may attach the existing ID only.
async function ensureCandidate(api, state, body, persist) {
  if (state.deployId) return state.deployId;
  assert.ok(!state.creationAttemptedAt, "Previous create outcome unknown. Inspect Netlify and recover its ID; NEVER retry create automatically");
  state.creationAttemptedAt = new Date().toISOString(); persist(state);
  const created = await api(`/sites/${SITE}/deploys?title=${encodeURIComponent(`Verified ZIP ${state.commit}`)}`, {
    method: "POST", body: { ...body, deploy_source: "cli" },
  });
  assert.match(created?.id || "", /^[a-f0-9]{24}$/);
  state.deployId = created.id; state.createdCandidateAt = new Date().toISOString(); persist(state);
  return state.deployId;
}

const needsManifestUpload = (state, deploy) => !state.manifestUploadedAt || deploy.state !== "ready";

async function waitReady(api, deployId) {
  const started = Date.now();
  while (Date.now() - started < 10 * 60 * 1000) {
    const deploy = await api(`/deploys/${deployId}`);
    if (deploy.state === "ready") return deploy;
    if (["error", "failed", "canceled"].includes(deploy.state)) throw new Error(`Candidate ${deployId} state=${deploy.state}; no replacement candidate will be created`);
    await new Promise(resolve => setTimeout(resolve, 4000));
  }
  throw new Error("Ready wait limit reached; rerun upload to inspect the SAME candidate, never create another");
}

function verifyRemote(deploy, plan, verified) {
  assert.equal(deploy.commit_ref, plan.commit, "Remote commit mismatch");
  const fns = deploy.available_functions || [];
  assert.equal(fns.length, 31);
  for (const fn of fns) {
    const name = fn.n || fn.name;
    assert.equal(fn.d || fn.sha || fn.code_sha, verified.functions[name], `Remote function hash mismatch: ${name}`);
    assert.equal((fn.bd || fn.build_data)?.runtimeAPIVersion, 2);
    assert.equal(fn.r || fn.runtime, "nodejs22.x");
    assert.equal(fn.im || fn.invocation_mode, name.endsWith("-background") ? "background" : "stream");
  }
  assert.deepEqual(Object.fromEntries((deploy.function_schedules || []).map(x => [x.name, x.cron])), SCHEDULES);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv), verified = loadVerifiedArtifacts(args.artifacts);
  const api = client(readAuth(), args.mode);
  let state = fs.existsSync(args.state) ? json(args.state) : null;
  const { plan, body, uploadFiles } = await makePlan(args, api, verified, state);
  if (args.mode === "plan") {
    console.log(JSON.stringify({ mode: "plan", remoteWrites: 0, deploysCreated: 0, sourceApiCalls: 0,
      basePublishedId: plan.basePublishedId, commit: plan.commit, staticFiles: Object.keys(body.files).length,
      staticLocalUploadAllowlist: ["index.html", "netlify.toml", "_headers"], otherStaticFiles: "Remote published SHA references only; no local directory upload",
      functions: 31, schedules: verified.schedules, runtime: "nodejs22.x", runtimeAPIVersion: 2,
      inputDigest: plan.inputDigest, executionDigest: plan.executionDigest, payloadDigest: plan.payloadDigest,
      existingCandidateId: state?.deployId || null, draft: !args.production,
      publishRequiresSeparateCommand: !args.production,
      productionOnReady: args.production,
      rollback: "Restore basePublishedId immediately if actual read-only Function checks fail; never create a second deploy" }, null, 2));
    return;
  }
  assert.equal(git(["rev-parse", "HEAD"]), args.commit, "Commit must be current HEAD");
  assert.equal(git(["diff", "HEAD", "--name-only", "--", ...verified.inputPaths, "index.html"]), "", "Build inputs must be committed unchanged");
  if (args.mode === "publish") {
    assert.ok(state?.readyVerifiedAt && state?.deployId, "Verified ready candidate required");
    assert.equal(args["confirm-publish"], state.deployId, "Explicit --confirm-publish <candidate-id> required");
    const deploy = await api(`/deploys/${state.deployId}`);
    assert.equal(deploy.state, "ready"); verifyRemote(deploy, plan, verified);
    await api(`/sites/${SITE}/deploys/${state.deployId}/restore`, { method: "POST" });
    const site = await api(`/sites/${SITE}`);
    assert.equal(site.published_deploy?.id, state.deployId);
    state.publishedAt = new Date().toISOString(); saveState(args.state, state);
    console.log(JSON.stringify({ publishedId: state.deployId, commit: args.commit, additionalBuilds: 0,
      warning: "Publication confirmed only; actual Function/service verification and immediate rollback decision remain separate." }));
    return;
  }
  state ||= { ...plan };
  await ensureCandidate(api, state, body, value => saveState(args.state, value));
  let deploy = await api(`/deploys/${state.deployId}`);
  if (needsManifestUpload(state, deploy)) {
    deploy = await api(`/sites/${SITE}/deploys/${state.deployId}?commit_ref=${args.commit}`, { method: "PUT", body });
    state.manifestUploadedAt = new Date().toISOString(); saveState(args.state, state);
    for (const hash of deploy.required || []) {
      const file = uploadFiles.get(hash);
      assert.ok(file, "Server requested an inherited static SHA; refusing local fallback or extra file upload");
      await api(`/deploys/${state.deployId}/files/${encodeURIComponent(file.name)}`, { method: "PUT", binary: true, body: file.bytes });
    }
    for (const hash of deploy.required_functions || []) {
      const fn = verified.uploads.get(hash); assert.ok(fn, "Unexpected requested function digest");
      const query = new URLSearchParams({ runtime: fn.runtime, invocation_mode: fn.invocationMode });
      if (fn.timeout !== undefined) query.set("timeout", String(fn.timeout));
      await api(`/deploys/${state.deployId}/functions/${encodeURIComponent(fn.name)}?${query}`, { method: "PUT", binary: true, body: fn.bytes });
      state.uploadedFunctions ||= []; if (!state.uploadedFunctions.includes(fn.name)) state.uploadedFunctions.push(fn.name);
      saveState(args.state, state);
    }
    deploy = await waitReady(api, state.deployId);
  }
  verifyRemote(deploy, plan, verified);
  if (args.production) assert.equal(deploy.context, "production", "Unexpected deploy context; stop and restore previous published deploy");
  assert.equal((await api(`/sites/${SITE}`)).published_deploy?.id,
    args.production ? state.deployId : args.expectedPublished,
    args.production ? "Production ready but not published; inspect without a second deploy" : "Draft unexpectedly changed published deploy");
  state.readyVerifiedAt = new Date().toISOString(); state.context = deploy.context;
  if (args.production) state.publishedAt = new Date().toISOString();
  state.permalink = deploy.links?.permalink || null; saveState(args.state, state);
  console.log(JSON.stringify({ candidateId: state.deployId, state: "ready", commit: args.commit, context: deploy.context,
    publishedUnchanged: !args.production, functionsVerified: 31, schedulesVerified: 4, sourceApiCalls: 0,
    functionInvocations: 0, publishPerformed: args.production, permalink: state.permalink,
    warning: "Ready/Published metadata is not a service health test. Check actual read-only Functions and restore the previous deploy immediately on failure." }, null, 2));
}

module.exports = { parseArgs, loadVerifiedArtifacts, client, makePlan, verifyRemote, ensureCandidate, needsManifestUpload, main };
if (require.main === module) main().catch(error => {
  console.error(`Verified-artifact deployment stopped: ${String(error.message).slice(0, 600)}`);
  process.exitCode = 1;
});
