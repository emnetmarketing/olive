#!/usr/bin/env node
"use strict";

// Read-only Production capture. This script never invokes an application
// function and never writes a Blob. Its only write is a new, ignored data file.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { Module, createRequire } = require("node:module");
const { getStore } = require("@netlify/blobs");

const ROOT = path.resolve(__dirname, "..");
const SITE_ID = "dc4e873a-5b98-40de-a2f8-9c36e9f7e8bc";
const sha256 = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trimEnd();

function argumentsFor(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--job", "--output"].includes(argv[i]) || !argv[i + 1]) throw new Error("Usage: node scripts/capture-period-recovery.js --job <UUID> [--output data/period-recovery-input.json]");
    args[argv[i].slice(2)] = argv[i + 1];
  }
  assert.match(args.job || "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "A valid --job is required");
  const output = path.resolve(ROOT, args.output || "data/period-recovery-input.json");
  const dataRoot = path.resolve(ROOT, "data");
  assert.ok(output.startsWith(dataRoot + path.sep) && path.extname(output) === ".json", "Output must be a JSON file inside the ignored data directory");
  assert.ok(!fs.existsSync(output), "Refusing to overwrite an existing recovery artifact");
  git("check-ignore", "--quiet", "--", path.relative(ROOT, output));
  return { jobId: args.job, output };
}

function makeReadOnlyFetch() {
  const nativeFetch = globalThis.fetch;
  const audit = { requests: 0, get: 0, head: 0, blocked: 0 };
  function allowedHost(host) {
    return host === "api.netlify.com" || host.endsWith(".netlify.com")
      || host.endsWith(".netlifyblob.com") || host.endsWith(".amazonaws.com");
  }
  const readFetch = async (input, options = {}) => {
    // All callers below supply URLs, so a Request with an implicit body is not
    // accepted. Redirect targets are checked individually as well.
    if (!(typeof input === "string" || input instanceof URL)) throw new Error("Only explicit read URLs are allowed");
    const method = String(options.method || "GET").toUpperCase();
    if (!["GET", "HEAD"].includes(method)) { audit.blocked += 1; throw new Error(`Read-only guard blocked ${method}`); }
    let url = new URL(input);
    let headers = new Headers(options.headers || {});
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      if (url.protocol !== "https:" || !allowedHost(url.hostname)) { audit.blocked += 1; throw new Error("Read-only guard blocked a non-storage host"); }
      audit.requests += 1; audit[method.toLowerCase()] += 1;
      const response = await nativeFetch(url, { ...options, method, headers, body: undefined,
        redirect: "manual", signal: options.signal || AbortSignal.timeout(30000) });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      const next = new URL(location, url);
      if (next.origin !== url.origin) { headers = new Headers(headers); headers.delete("authorization"); headers.delete("cookie"); }
      await response.body?.cancel();
      url = next;
    }
    throw new Error("Too many storage read redirects");
  };
  return { readFetch, audit };
}

function productionModules(commit) {
  const modules = new Map();
  const sourceFiles = {};
  function load(relativePath) {
    const relative = relativePath.replace(/\\/g, "/");
    assert.ok(relative.startsWith("netlify/functions/") && relative.endsWith(".js"), "Only deployed function modules may be loaded");
    if (modules.has(relative)) return modules.get(relative).exports;
    const filename = path.resolve(ROOT, relative);
    const source = git("show", `${commit}:${relative}`);
    sourceFiles[relative] = { deployedSha256: sha256(source),
      localSha256: fs.existsSync(filename) ? sha256(fs.readFileSync(filename, "utf8").trimEnd()) : null };
    const instance = new Module(filename, module);
    modules.set(relative, instance);
    instance.filename = filename;
    instance.paths = Module._nodeModulePaths(path.dirname(filename));
    const externalRequire = createRequire(filename);
    instance.require = (name) => {
      if (!name.startsWith(".")) return externalRequire(name);
      let resolved = path.resolve(path.dirname(filename), name);
      if (!path.extname(resolved)) resolved += ".js";
      return load(path.relative(ROOT, resolved));
    };
    instance._compile(source, filename);
    return instance.exports;
  }
  return { load, sourceFiles };
}

async function main() {
  const { jobId, output } = argumentsFor(process.argv.slice(2));
  const capturedAt = new Date().toISOString();
  const { readFetch, audit } = makeReadOnlyFetch();
  globalThis.fetch = readFetch;
  const configPath = path.join(process.env.APPDATA || "", "netlify", "Config", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const token = config.users?.[config.userId]?.auth?.token;
  assert.ok(typeof token === "string" && token.length > 0, "Existing authenticated Netlify CLI credentials are required");
  const stores = new Map();
  const store = (name) => {
    if (!stores.has(name)) stores.set(name, getStore({ name, siteID: SITE_ID, token, consistency: "strong", fetch: readFetch }));
    return stores.get(name);
  };
  const sources = [];
  async function read(name, key, { optional = false, verifyStable = true } = {}) {
    const entry = await store(name).getWithMetadata(key, { type: "json" });
    if (!entry && !optional) throw new Error(`Required stored input is missing: ${name}/${key}`);
    sources.push({ store: name, key, etag: entry?.etag || null, digest: entry ? sha256(entry.data) : null, verifyStable });
    return entry?.data || null;
  }
  async function readSite() {
    const response = await readFetch(`https://api.netlify.com/api/v1/sites/${SITE_ID}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200, "Authenticated site read failed");
    return response.json();
  }
  const site = await readSite();
  const productionCommit = site.published_deploy?.commit_ref;
  assert.match(productionCommit || "", /^[0-9a-f]{40}$/i, "Published deploy must identify its source commit");
  const deployed = productionModules(productionCommit);
  const background = deployed.load("netlify/functions/trend-analysis-background.js")._test;
  const history = deployed.load("netlify/functions/surge-history-cache.js");
  const continuation = deployed.load("netlify/functions/historical-continuation.js");
  const cache = deployed.load("netlify/functions/trend-series-cache.js");
  const policy = deployed.load("netlify/functions/trend-collection-policy.js");
  const job = await read("trend-analysis", `jobs/${jobId}`);
  assert.equal(job.mode, "period", "Recovery target must be a Period job");
  assert.equal(job.historicalCollection, true, "Recovery target must have historical calculation checkpoints");
  assert.ok(job.checkpointKey, "Recovery target has no checkpoint pointer");
  assert.equal(job.checkpointKey, continuation.checkpointKey(job), "Checkpoint window/threshold key mismatch");
  const checkpoint = await read("trend-analysis", job.checkpointKey);
  assert.equal(checkpoint.jobId, jobId, "A different Job replaced this shared checkpoint");

  const [candidateManifest, marketCache, productCache, priorSignalCache, historyManifest, earlyCache,
    seriesManifest, currentPointer] = await Promise.all([
    read("keyword-candidates", "current-v5"), read("market-discovery", "current-v1"),
    read("search-ad-products", "current"), read("trend-analysis", "signals/current", { optional: true }),
    read("trend-analysis", history.MANIFEST_KEY, { optional: true }), read("today-early-signals", "current-v1"),
    read("trend-series-cache", cache.MANIFEST_KEY), read("trend-analysis", "current-job/v1", { optional: true, verifyStable: false }),
  ]);
  const [candidateShards, historyShards, seriesShards] = await Promise.all([
    Promise.all((candidateManifest.shardKeys || []).map((key) => read("keyword-candidates", key))),
    Promise.all((historyManifest?.shardKeys || []).map((key) => read("trend-analysis", key))),
    Promise.all(Array.from({ length: cache.SHARD_COUNT }, (_, i) => read("trend-series-cache", `shards/v1/${i}`))),
  ]);
  const currentJob = currentPointer?.jobId
    ? await read("trend-analysis", `jobs/${currentPointer.jobId}`, { optional: true, verifyStable: false }) : null;
  const candidates = candidateManifest.candidates || candidateShards.flatMap((part) => part.candidates || []);
  const historyRecords = new Map(historyShards.flatMap((part) => part.items || []).map((record) => [record.normalizedKeyword, record]));
  const priorSignals = new Map((priorSignalCache?.items || []).map((item) => [item.keyword, item]));
  for (const candidate of candidates) {
    const signal = history.historyProtectionSignal(historyRecords.get(history.normalizeKeyword(candidate.keyword)), job.surgeThreshold);
    if (signal) priorSignals.set(candidate.keyword, signal);
  }
  const beforeLimit = candidates.filter((candidate) => ["beauty", "health"].includes(candidate.category)
    && Number(candidate.monthlyTotalSearches || 0) >= job.surgeThreshold);
  const selection = background.selectWithMarketDiscovery(beforeLimit, marketCache.items || [], priorSignals);
  assert.ok(continuation.isCompatible(checkpoint, job, selection.selected), "Current candidate order/window differs from the original checkpoint; recovery aborted");
  assert.equal(selection.selected.length + selection.ratioOnly.length, 5000, "Expected the preserved 5,000-candidate scope");
  assert.ok(Number.isInteger(checkpoint.calculationCursor) && checkpoint.calculationCursor > 0
    && checkpoint.calculationCursor <= selection.selected.length, "Invalid checkpoint cursor");
  assert.equal(checkpoint.processedCount, checkpoint.calculationCursor, "Checkpoint progress/cursor mismatch");
  const oldCandidates = new Map((checkpoint.calculated || []).map((item) => [item.candidate.keyword, item.candidate]));
  assert.equal(oldCandidates.size, checkpoint.calculated.length, "Duplicate checkpoint calculations");
  const byKeyword = new Map(selection.selected.map((candidate) => [candidate.keyword, candidate]));
  for (const [keyword, original] of oldCandidates) {
    const current = byKeyword.get(keyword);
    assert.ok(current, "A calculated candidate is no longer present");
    const keys = [...new Set([...Object.keys(original), ...Object.keys(current)])].filter((key) => key !== "candidateTier");
    for (const key of keys) assert.deepEqual(current[key], original[key], `Calculated input changed: ${keyword}/${key}`);
  }
  const processedKeywords = new Set(checkpoint.eligibleKeywords.slice(0, checkpoint.calculationCursor));
  assert.ok([...oldCandidates.keys()].every((keyword) => processedKeywords.has(keyword)), "Saved calculation lies beyond checkpoint cursor");
  const uncalculated = checkpoint.analysisTrace.filter((trace) => processedKeywords.has(trace.keyword) && !oldCandidates.has(trace.keyword));
  assert.equal(uncalculated.length, checkpoint.calculationCursor - checkpoint.calculated.length, "Unexplained gap in processed calculations");
  assert.ok(uncalculated.every((trace) => trace.cacheHit && trace.searchTrendStatus === "empty"), "Processed calculation gap is not explained by cached empty source data");
  assert.equal(new Set(checkpoint.rows.map((row) => row.keyword)).size, checkpoint.rows.length, "Duplicate intermediate result rows");
  assert.ok(checkpoint.rows.every((row) => processedKeywords.has(row.keyword)), "Intermediate result lies beyond checkpoint cursor");

  const entries = new Map(seriesShards.flatMap((part) => Object.entries(part.entries || {})));
  const trendEntries = {}; const shoppingEntries = {};
  const numericCandidates = selection.selected;
  const ratioCandidates = selection.ratioOnly;
  for (const candidate of [...numericCandidates, ...ratioCandidates]) {
    const trend = cache.lookup(entries, candidate.keyword, "search", candidate.category, job.queryStartDate, job.endDate, new Date(capturedAt));
    assert.equal(trend.state, "hit", `Historical cache miss for ${candidate.keyword}; zero-call recovery aborted`);
    candidate.candidateTier = oldCandidates.get(candidate.keyword)?.candidateTier
      || policy.isDueForCollection(candidate, priorSignals.get(candidate.keyword), trend.record, new Date(capturedAt)).tier;
    trendEntries[candidate.keyword] = { state: "hit", series: trend.series, record: trend.record, recordDigest: sha256(trend.record) };
  }
  for (const candidate of numericCandidates) {
    const shopping = cache.lookup(entries, candidate.keyword, "shopping", candidate.category, job.queryStartDate, job.endDate, new Date(capturedAt));
    if (shopping.state === "hit") shoppingEntries[candidate.keyword] = {
      state: "hit", series: shopping.series, record: shopping.record, recordDigest: sha256(shopping.record),
    };
  }

  // Input objects are mutable in Production. ETags must still match before we
  // create a local artifact; this also detects a concurrent checkpoint writer.
  for (let offset = 0; offset < sources.length; offset += 8) {
    await Promise.all(sources.slice(offset, offset + 8).filter((source) => source.verifyStable).map(async (source) => {
      const current = await store(source.store).getMetadata(source.key);
      assert.equal(current?.etag || null, source.etag, `Stored input changed during capture: ${source.store}/${source.key}`);
    }));
  }
  const currentSite = await readSite();
  assert.equal(currentSite.published_deploy?.id, site.published_deploy?.id, "Production changed during capture");
  const sourceManifest = { siteId: SITE_ID, capturedAt, completedAt: new Date().toISOString(),
    candidateGeneration: { refreshedAt: candidateManifest.refreshedAt, shardKeys: candidateManifest.shardKeys || [], count: candidates.length },
    marketRefreshedAt: marketCache.refreshedAt, productRefreshedAt: productCache.refreshedAt,
    earlyGeneratedAt: earlyCache.generatedAt, priorSignalsUpdatedAt: priorSignalCache?.updatedAt || null,
    surgeHistoryUpdatedAt: historyManifest?.updatedAt || null, seriesManifest,
    orderedNumericKeywordDigest: sha256(numericCandidates.map((item) => item.keyword)),
    orderedRatioKeywordDigest: sha256(ratioCandidates.map((item) => item.keyword)),
    currentJob: currentJob ? { jobId: currentJob.jobId, state: currentJob.state, currentStage: currentJob.currentStage,
      createdAt: currentJob.createdAt, updatedAt: currentJob.updatedAt, processedCount: currentJob.processedCount, totalCount: currentJob.totalCount } : null,
    sources, network: { ...audit, sourceApiCalls: 0, productionWrites: 0 } };
  const codeVersion = { productionCommit, productionDeployId: site.published_deploy.id, localHead: git("rev-parse", "HEAD"),
    calculationVersion: history.CALCULATION_VERSION, checkpointVersion: continuation.CHECKPOINT_VERSION, sourceFiles: deployed.sourceFiles };
  const artifact = { version: 1, capturedAt, job, checkpoint, numericCandidates, ratioCandidates,
    productCache, trendEntries, shoppingEntries, earlyCache, priorSignals: Object.fromEntries(priorSignals), sourceManifest, codeVersion };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(artifact), { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ output: path.relative(ROOT, output), jobId, checkpointCursor: checkpoint.calculationCursor,
    numericCandidates: numericCandidates.length, ratioCandidates: ratioCandidates.length,
    preservedCalculations: checkpoint.calculated.length, preservedRows: checkpoint.rows.length,
    processedEmptySeries: uncalculated.length, cacheHits: Object.keys(trendEntries).length,
    productionCommit, productionDeployId: site.published_deploy.id,
    deployConfiguration: { repositoryBranch: site.build_settings?.repo_branch || null,
      buildsStopped: site.build_settings?.stop_builds ?? null, autoPublishLocked: site.published_deploy?.locked ?? null },
    sourceApiCalls: 0, productionWrites: 0 }, null, 2));
}

if (require.main === module) main().catch((error) => {
  // Avoid serializing SDK error objects, signed URLs, request headers, or tokens.
  console.error(`Recovery capture aborted: ${String(error?.message || error).replace(/https?:\/\/\S+/g, "[URL omitted]")}`);
  process.exitCode = 1;
});

module.exports = { argumentsFor, makeReadOnlyFetch, productionModules };
