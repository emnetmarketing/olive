const crypto = require("node:crypto");
const { connectLambda, getStore } = require("@netlify/blobs");

const STORE = "analysis-downloads";
const HISTORY_KEY = "shared-history/v1";
function connect(event) { if (event?.blobs) connectLambda(event); }
function store() { return getStore(STORE); }
async function readHistory() { return (await store().get(HISTORY_KEY, { type: "json" }))?.items || []; }
async function appendHistory(item) {
  const items = [{ id: crypto.randomUUID(), ...item }, ...(await readHistory())].slice(0, 50);
  await store().setJSON(HISTORY_KEY, { version: 1, updatedAt: new Date().toISOString(), items });
  return items[0];
}
module.exports = { connect, store, readHistory, appendHistory, STORE, HISTORY_KEY };
