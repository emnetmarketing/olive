const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { _test } = require("../netlify/functions/market-discovery-list");

test("new discovery list defaults can filter 24 hours and seven days", () => {
  const now = Date.parse("2026-08-26T00:00:00Z");
  assert.equal(_test.inWindow({ discoveredAt: "2026-08-25T12:00:00Z" }, "24h", now), true);
  assert.equal(_test.inWindow({ discoveredAt: "2026-08-24T12:00:00Z" }, "24h", now), false);
  assert.equal(_test.inWindow({ discoveredAt: "2026-08-24T12:00:00Z" }, "7d", now), true);
});

test("multi-source recent YouTube discovery ranks above old single-source discovery", () => {
  const now = Date.parse("2026-08-26T00:00:00Z");
  const recent = { discoveredAt: "2026-08-25T20:00:00Z", discoverySource: ["youtube", "product-cache"], sourceConfidence: 80 };
  const old = { discoveredAt: "2026-08-20T00:00:00Z", discoverySource: ["product-cache"], sourceConfidence: 100, monthlyTotalSearches: 100000 };
  assert.ok(_test.discoverySortScore(recent, now) > _test.discoverySortScore(old, now));
});

test("dashboard exposes automatic top list, novelty filters, and collapsed detailed search", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /최근 발견 키워드 TOP 100/);
  assert.match(html, /최근 24시간/);
  assert.match(html, /id="marketDiscoveryDiagnostic"[\s\S]*<summary><strong>관리자 상세 진단/);
  assert.match(html, /market-discovery-list/);
  assert.match(html, /TREND_STATUS_LABELS/);
});
