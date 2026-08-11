const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  STORE,
  USERS_KEY,
  normalizeEmail,
  publicUser,
} = require("../netlify/functions/access-management-cache");

test("shared access records never include a browser password", () => {
  const user = publicUser({
    email: " Team@Example.com ",
    name: "Team",
    password: "must-stay-local",
    status: "pending",
    role: "operator",
  });

  assert.equal(STORE, "access-management");
  assert.equal(USERS_KEY, "users-v1");
  assert.equal(normalizeEmail(user.email), "team@example.com");
  assert.equal(Object.hasOwn(user, "password"), false);
});

test("frontend sends only access metadata and merges shared roles", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(html, /postAccessAction\(\{ action: "request", email, name \}\)/);
  assert.match(html, /async function loadAccessUsers\(\)/);
  assert.match(html, /sharedUser\.status === "approved"/);
});
