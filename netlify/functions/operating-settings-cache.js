const { connectLambda, getStore } = require("@netlify/blobs");

const STORE = "operating-settings";
const SETTINGS_KEY = "thresholds-v1";
const DEFAULT_SETTINGS = Object.freeze({ surgeThreshold: 300, matchThreshold: 40 });

function connect(event) { if (event?.blobs) connectLambda(event); }
function store() { return getStore(STORE); }

function validateSettings(input) {
  const surgeThreshold = Number(input?.surgeThreshold);
  const matchThreshold = Number(input?.matchThreshold);
  if (!Number.isInteger(surgeThreshold) || surgeThreshold < 1 || surgeThreshold > 10000000) {
    throw new Error("급등수 기준은 1~10,000,000 사이의 정수여야 합니다.");
  }
  if (!Number.isFinite(matchThreshold) || matchThreshold < 1 || matchThreshold > 100) {
    throw new Error("일치율 기준은 1~100 사이여야 합니다.");
  }
  return { surgeThreshold, matchThreshold };
}

async function readOperatingSettings() {
  const saved = await store().get(SETTINGS_KEY, { type: "json" });
  if (!saved) return { ...DEFAULT_SETTINGS, savedAt: null, version: 1, source: "default" };
  const validated = validateSettings(saved);
  return { ...validated, savedAt: saved.savedAt || null, version: 1, source: "blob" };
}

async function writeOperatingSettings(input) {
  const validated = validateSettings(input);
  const value = { ...validated, savedAt: new Date().toISOString(), version: 1 };
  await store().setJSON(SETTINGS_KEY, value);
  return { ...value, source: "blob" };
}

module.exports = { connect, readOperatingSettings, writeOperatingSettings, validateSettings, DEFAULT_SETTINGS, STORE, SETTINGS_KEY };
