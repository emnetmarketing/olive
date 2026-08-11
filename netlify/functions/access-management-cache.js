const { connectLambda, getStore } = require("@netlify/blobs");

const STORE = "access-management";
const USERS_KEY = "users-v1";
const DEFAULT_MASTER_EMAIL = "huni@emnet.co.kr";

function connect(event) { if (event?.blobs) connectLambda(event); }
function store() { return getStore(STORE); }
function normalizeEmail(value) { return String(value || "").trim().toLowerCase(); }
function publicUser(user) {
  return {
    email: normalizeEmail(user.email), name: String(user.name || "").trim(),
    status: ["pending", "approved", "rejected"].includes(user.status) ? user.status : "pending",
    role: ["master", "editor", "operator"].includes(user.role) ? user.role : "operator",
    requestedAt: user.requestedAt || null, updatedAt: user.updatedAt || null
  };
}
function defaultMaster() {
  const now = new Date().toISOString();
  return { email: DEFAULT_MASTER_EMAIL, name: "huni", status: "approved", role: "master", requestedAt: now, updatedAt: now };
}
async function readUsers() {
  const saved = await store().get(USERS_KEY, { type: "json" });
  const users = Array.isArray(saved?.users) ? saved.users.map(publicUser).filter((user) => user.email) : [];
  if (!users.some((user) => user.role === "master" && user.status === "approved")) users.unshift(defaultMaster());
  return { version: 1, updatedAt: saved?.updatedAt || null, users };
}
async function writeUsers(users) {
  const value = { version: 1, updatedAt: new Date().toISOString(), users: users.map(publicUser).filter((user) => user.email) };
  await store().setJSON(USERS_KEY, value);
  return value;
}
async function requestAccess(input) {
  const email = normalizeEmail(input?.email);
  const name = String(input?.name || email.split("@")[0] || "").trim();
  if (!email || !email.includes("@")) throw new Error("A valid email address is required.");
  const current = await readUsers();
  const existing = current.users.find((user) => user.email === email);
  if (existing) return { registry: current, user: existing, existing: true };
  const now = new Date().toISOString();
  const user = { email, name, status: email === DEFAULT_MASTER_EMAIL ? "approved" : "pending", role: email === DEFAULT_MASTER_EMAIL ? "master" : "operator", requestedAt: now, updatedAt: now };
  const registry = await writeUsers([...current.users, user]);
  return { registry, user, existing: false };
}
async function updateAccess(input) {
  const email = normalizeEmail(input?.email);
  const action = String(input?.action || "");
  const current = await readUsers();
  const target = current.users.find((user) => user.email === email);
  if (!target) throw new Error("The requested user was not found.");
  if (target.role === "master" && ["reject", "delete"].includes(action)) throw new Error("The master account cannot be rejected or deleted.");
  let users = current.users.slice();
  const now = new Date().toISOString();
  if (action === "approve") users = users.map((user) => user.email === email ? { ...user, status: "approved", updatedAt: now } : user);
  else if (action === "reject") users = users.map((user) => user.email === email ? { ...user, status: "rejected", updatedAt: now } : user);
  else if (action === "role") {
    if (target.role === "master") throw new Error("The master role cannot be changed directly.");
    if (!["editor", "operator"].includes(input.role)) throw new Error("The requested role is not allowed.");
    users = users.map((user) => user.email === email ? { ...user, role: input.role, updatedAt: now } : user);
  } else if (action === "delete") users = users.filter((user) => user.email !== email);
  else if (action === "transfer-master") {
    if (target.status !== "approved") throw new Error("Only an approved user can receive the master role.");
    users = users.map((user) => user.email === email ? { ...user, role: "master", updatedAt: now }
      : user.role === "master" ? { ...user, role: "editor", updatedAt: now } : user);
  } else throw new Error("The requested access-management action is not allowed.");
  return writeUsers(users);
}

module.exports = { connect, readUsers, writeUsers, requestAccess, updateAccess, normalizeEmail, publicUser, STORE, USERS_KEY, DEFAULT_MASTER_EMAIL };
