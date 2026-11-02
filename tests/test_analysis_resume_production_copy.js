// Optional operator-workspace regression. The captured production bodies are
// read-only local evidence, not checked-in synthetic replacements or API reads.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { withResumeEvidence } = require("../netlify/functions/analysis-resume-presentation");
const directory = path.resolve(__dirname, "../data/fast-resume-20261027");
const available = fs.existsSync(path.join(directory, "current-before.json"));
const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
test("captured 5000-candidate Instant Job verifies its real 1750 cursor and seven saved output chunks", { skip: !available }, async () => {
  const job = read("current-before.json").body.job;
  const input = read("input-before.json"), state = read("state-before.json");
  assert.equal(job.jobId, "f0a6bea0-8dc3-4d93-9569-66b9e1675b37");
  assert.equal(input.value.totalCount, 5000); assert.equal(input.value.numericCount, 4850);
  assert.equal(state.value.parts.length, 20); assert.equal(state.value.outputs.length, 7);
  const before = JSON.stringify(job), reads = [];
  const store = {
    async get(key) {
      reads.push(key);
      const prefix = `jobs/${job.jobId}/instant-v1/`;
      assert.ok(key.startsWith(prefix));
      const [label, hash] = key.slice(prefix.length).split("/");
      assert.match(label, /^[a-z0-9-]+$/); assert.match(hash, /^[a-f0-9]{64}$/);
      return read(label === "inputs" ? "input-before.json" : label === "state" ? "state-before.json" : `artifact-${label}.json`);
    },
    async setJSON() { throw new Error("Production copy verification must be read-only"); },
    async delete() { throw new Error("Production copy verification must not delete"); }
  };
  const result = await withResumeEvidence(job, { store, now: Date.parse("2026-11-02T07:00:00Z") });
  assert.deepEqual(result.resumeEvidence, { verified: true, status: "verified", reason: "saved-stage-verified",
    kind: "calculation", stage: "numeric", cursor: 1750, totalCount: 4850,
    checkpointUpdatedAt: "2026-10-27T01:58:01.880Z" });
  assert.equal(reads.length, 29); assert.equal(JSON.stringify(job), before);
});
