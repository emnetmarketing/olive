const assert = require("node:assert/strict");
const fs = require("node:fs");
const { validateSettings, DEFAULT_SETTINGS, STORE, SETTINGS_KEY } = require("../netlify/functions/operating-settings-cache");

assert.deepEqual(DEFAULT_SETTINGS, { surgeThreshold: 300, matchThreshold: 40 });
assert.deepEqual(validateSettings({ surgeThreshold: "500", matchThreshold: "60" }), { surgeThreshold: 500, matchThreshold: 60 });
assert.throws(() => validateSettings({ surgeThreshold: 0, matchThreshold: 60 }), /급등수 기준/);
assert.throws(() => validateSettings({ surgeThreshold: 500, matchThreshold: 101 }), /일치율 기준/);
assert.equal(STORE, "operating-settings");
assert.equal(SETTINGS_KEY, "thresholds-v1");

const startSource = fs.readFileSync("netlify/functions/trend-analysis-start.js", "utf8");
assert.match(startSource, /readOperatingSettings\(\)/);
assert.equal(startSource.includes("Number(input.surgeThreshold)"), false);
assert.equal(startSource.includes("Number(input.matchThreshold)"), false);

console.log("Shared operating settings validation and server-side analysis source OK");
