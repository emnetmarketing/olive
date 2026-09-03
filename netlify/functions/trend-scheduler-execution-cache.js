const crypto = require("node:crypto");
const { connectLambda, getStore } = require("@netlify/blobs");

const STORE_NAME = "trend-scheduler-executions";
const LATEST_KEY = "latest-v1";
function connect(event) { if (event?.blobs) connectLambda(event); }
function store() { return getStore(STORE_NAME); }
async function begin(source, scheduledFor) {
  const now = new Date().toISOString();
  const record = { executionId: crypto.randomUUID(), source, scheduledFor: scheduledFor || null,
    state: "started", triggeredAt: now, startedAt: now, stage: "scheduler-entry" };
  await Promise.all([store().setJSON(`executions/${record.executionId}`, record), store().setJSON(LATEST_KEY, record)]);
  return record;
}
async function update(record, patch) {
  const next = { ...record, ...patch, updatedAt: new Date().toISOString() };
  await Promise.all([store().setJSON(`executions/${record.executionId}`, next), store().setJSON(LATEST_KEY, next)]);
  return next;
}
async function updateById(executionId, patch) {
  if (!executionId) return null;
  const record = await store().get(`executions/${executionId}`, { type: "json" }).catch(() => null);
  return record ? update(record, patch) : null;
}
async function readLatest() { return store().get(LATEST_KEY, { type: "json" }).catch(() => null); }

module.exports = { connect, begin, update, updateById, readLatest, STORE_NAME, LATEST_KEY };
