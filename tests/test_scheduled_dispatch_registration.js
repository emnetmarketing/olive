const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { loadVerifiedArtifacts, verifyRemote, EXPECTED_FUNCTION_COUNT, SCHEDULES } = require("../scripts/deploy-verified-functions.cjs");

const root = path.resolve(__dirname, "..");
const scheduledName = "trend-instant-dispatch-scheduled";
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function loadHandler(tick) {
  const exports = {}, calls = [];
  vm.runInNewContext(read(`netlify/functions/${scheduledName}.js`), {
    exports, require(name) {
      calls.push(name);
      if (name === "./blob-store-compat") return { connectLambda: event => calls.push({ connected: event }) };
      if (name === "./instant-dispatch") return { tick };
      throw new Error(`Unexpected scheduler dependency: ${name}`);
    },
  }, { filename: `${scheduledName}.js` });
  return { exports, calls };
}

test("new independent dispatcher is registered once every two minutes without changing the four existing schedules", () => {
  assert.equal(EXPECTED_FUNCTION_COUNT, 32);
  assert.deepEqual(SCHEDULES, {
    "keyword-candidate-scheduled": "0 17 * * *",
    "market-discovery-scheduled": "0 */6 * * *",
    "trend-data-collection-recovery-scheduled": "0 23 * * *",
    "trend-data-collection-scheduled": "0 21 * * *",
    [scheduledName]: "*/2 * * * *",
  });
  const toml = read("netlify.toml");
  const registrations = Object.fromEntries([...toml.matchAll(/\[functions\."([^"]+)"\]\s+schedule\s*=\s*"([^"]+)"/g)]
    .map(match => [match[1], match[2]]));
  assert.deepEqual(registrations, SCHEDULES);
  assert.equal(fs.readdirSync(path.join(root, "netlify/entries")).filter(name => name.endsWith(".mjs")).length, 32);
  const native = read(`netlify/entries/${scheduledName}.mjs`);
  assert.match(native, /^import "@netlify\/blobs";/m);
  assert.match(native, /export default withLambda\(legacy\.handler\)/);
  assert.ok(native.includes('schedule: "*/2 * * * *"'));
  assert.doesNotMatch(native, /fetch\s*\(|connectLambda|setEnvironmentContext/);
});

test("scheduled handler uses runtime Blob context and passes invocation identity to one tick only", async () => {
  const tickCalls = [];
  const { exports, calls } = loadHandler(async options => { tickCalls.push(options); return { status: "idle", dispatched: false }; });
  const event = { body: '{"next_run":"2026-10-27T00:02:00Z"}' };
  const result = await exports.handler(event, { awsRequestId: "scheduler-native-invocation" });
  assert.equal(exports.config.schedule, "*/2 * * * *");
  assert.equal(tickCalls.length, 1);
  assert.equal(tickCalls[0].requestId, "scheduler-native-invocation");
  assert.equal(calls[1].connected, event);
  assert.deepEqual(calls.filter(item => typeof item === "string"), ["./blob-store-compat", "./instant-dispatch"]);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { status: "idle", dispatched: false });
});

test("scheduled tick failures remain failures and never become fake successful completion", async () => {
  const failure = new Error("fixture dispatcher CAS failed");
  const { exports } = loadHandler(async () => { throw failure; });
  await assert.rejects(exports.handler({}, { requestId: "failed-native-invocation" }), error => error === failure);
  const source = read(`netlify/functions/${scheduledName}.js`);
  assert.doesNotMatch(source, /trend-analysis-start|acquireJob|createJob|\.run\(|fetch\s*\(|api\.searchTrend/);
});

function fixtureArtifacts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verified-dispatch-artifacts-"));
  const names = fs.readdirSync(path.join(root, "netlify/entries")).filter(name => name.endsWith(".mjs")).map(name => name.slice(0, -4));
  const functions = names.map(name => {
    const bytes = Buffer.from(`synthetic ZIP fingerprint fixture ${name}`);
    fs.writeFileSync(path.join(dir, `${name}.zip`), bytes);
    return { name, path: path.join(dir, `${name}.zip`), runtimeVersion: "nodejs22.x",
      buildData: { runtimeAPIVersion: 2, bootstrapVersion: "2.24.0" },
      invocationMode: name.endsWith("-background") ? "background" : "stream",
      ...(SCHEDULES[name] ? { schedule: SCHEDULES[name] } : {}) };
  });
  const evidence = { version: "16.3.0", hostNode: "v22.23.3", symlinkCount: 0, entryCount: 32, inputs: {},
    functions: functions.map(fn => ({ name: fn.name, sha256: sha(fs.readFileSync(fn.path)), errors: [] })) };
  const flags = ["duplicateBlocked", "staleBlocked", "publicationFailureProtected", "publicationRetrySucceeded", "instantPublicationVerified",
    "instantPreviousProtected", "normalWorkerClaimVerified", "normalWorkerFrozenInputsVerified", "normalWorkerCheckpointResumeVerified"];
  const execution = { mode: "execution", bootstrapExecuted: true, nativeContext: true, latestStatusSnapshotJobMatch: true,
    sourceApiCalls: 0, productionCalls: 0, canonicalPeriodRows: 439, excelPeriodRows: 439, probePhases: [1, 2],
    probeReport: Object.fromEntries(flags.map(name => [name, true])), sdkVersions: ["10.7.12"],
    scheduledDispatcherVerified: true, scheduledDispatcherIdleWrites: 0, scheduledDispatcherIdleSourceCalls: 0 };
  const report = { node: "v22.23.3", ancestorModulesDisabled: true, workspaceModuleFallback: false, zipEntryCount: 32,
    artifacts: evidence.functions.map(fn => ({ name: fn.name, sha256: fn.sha256, normalizedLinks: [] })),
    results: [{ mode: "imports", imported: 32, externalCalls: 0, schedules: SCHEDULES }, execution] };
  const save = () => {
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ functions }));
    fs.writeFileSync(path.join(dir, "build-evidence.json"), JSON.stringify(evidence));
    fs.writeFileSync(path.join(dir, "execution-report.json"), JSON.stringify(report));
  };
  const cleanup = () => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("verified-dispatch-artifacts-"));
    fs.rmSync(dir, { recursive: true, force: true });
  };
  save(); return { dir, functions, evidence, report, execution, save, cleanup };
}

test("exact-artifact gate requires 32 self-contained functions, five real native schedules and idle dispatcher SDK execution", () => {
  const fixture = fixtureArtifacts();
  try {
    const valid = loadVerifiedArtifacts(fixture.dir);
    assert.equal(Object.keys(valid.functions).length, 32); assert.equal(valid.schedules.length, 5);
    fixture.execution.scheduledDispatcherVerified = false; fixture.save();
    assert.throws(() => loadVerifiedArtifacts(fixture.dir));
    fixture.execution.scheduledDispatcherVerified = true;
    fixture.execution.scheduledDispatcherIdleWrites = 1; fixture.save();
    assert.throws(() => loadVerifiedArtifacts(fixture.dir));
    fixture.execution.scheduledDispatcherIdleWrites = 0;
    fixture.execution.scheduledDispatcherIdleSourceCalls = 1; fixture.save();
    assert.throws(() => loadVerifiedArtifacts(fixture.dir));
    fixture.execution.scheduledDispatcherIdleSourceCalls = 0;
    fixture.report.results[0].schedules = { ...SCHEDULES, [scheduledName]: "*/5 * * * *" }; fixture.save();
    assert.throws(() => loadVerifiedArtifacts(fixture.dir));
  } finally { fixture.cleanup(); }
});

test("adding the dispatcher does not weaken SDK/runtime/ZIP/no-fallback/source-API gate failures", () => {
  const fixture = fixtureArtifacts();
  try {
    const mutations = [
      [fixture.evidence, "entryCount", 31], [fixture.evidence, "symlinkCount", 1],
      [fixture.report, "workspaceModuleFallback", true], [fixture.execution, "sourceApiCalls", 1],
      [fixture.execution, "sdkVersions", ["10.0.0"]], [fixture.execution.probeReport, "publicationFailureProtected", false],
      [fixture.functions[0].buildData, "runtimeAPIVersion", 1],
    ];
    for (const [object, field, invalid] of mutations) {
      const original = object[field]; object[field] = invalid; fixture.save();
      assert.throws(() => loadVerifiedArtifacts(fixture.dir), `${field} must remain enforced`);
      object[field] = original; fixture.save();
    }
    fs.writeFileSync(fixture.functions[0].path, "tampered fixture artifact");
    assert.throws(() => loadVerifiedArtifacts(fixture.dir), /ZIP build mismatch/);
  } finally { fixture.cleanup(); }
});

test("remote deploy verification rejects missing, duplicate or wrongly scheduled dispatcher registration", () => {
  const functions = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`fixture-${i}`, i.toString(16).padStart(64, "0")]));
  const commit = "a".repeat(40);
  const remote = { commit_ref: commit, function_schedules: Object.entries(SCHEDULES).map(([name, cron]) => ({ name, cron })),
    available_functions: Object.entries(functions).map(([n, d]) => ({ n, d, bd: { runtimeAPIVersion: 2 }, r: "nodejs22.x", im: "stream" })) };
  verifyRemote(remote, { commit }, { functions });
  const duplicate = structuredClone(remote); duplicate.available_functions[31] = duplicate.available_functions[0];
  assert.throws(() => verifyRemote(duplicate, { commit }, { functions }), /registration mismatch/);
  const missing = structuredClone(remote); missing.function_schedules.pop();
  assert.throws(() => verifyRemote(missing, { commit }, { functions }));
  const wrong = structuredClone(remote); wrong.function_schedules.find(item => item.name === scheduledName).cron = "*/5 * * * *";
  assert.throws(() => verifyRemote(wrong, { commit }, { functions }));
});
