const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { calculateMarketConfidence, grade } = require("../netlify/functions/market-confidence");

function row(overrides = {}) { return { keyword: "테스트쿠션", resultType: "product_match", estimatedSurgeCount: 700,
  peakRelativeLiftPct: 120, absoluteSurgePassed: true, relativeSurgePassed: true, match: { score: 85 },
  sources: ["youtube", "searchad-new-query", "market-discovery"], searchAdNewQuery: true,
  earlyMarketEvidence: { comparisons: { youtube: { current: 3, previous: 1, delta: 2 } } },
  marketSourceConfidence: 92, shoppingRise: 4, news: { total: 2 }, ...overrides }; }

test("market confidence combines only present evidence without changing NAVER metrics", () => {
  const input = row(); const before = JSON.stringify({ surge: input.estimatedSurgeCount, relative: input.peakRelativeLiftPct });
  const result = calculateMarketConfidence(input, 300);
  assert.equal(JSON.stringify({ surge: input.estimatedSurgeCount, relative: input.peakRelativeLiftPct }), before);
  assert.ok(result.marketConfidenceScore >= 85); assert.equal(result.marketConfidenceGrade, "very_strong");
  assert.match(result.marketConfidenceReasons.join(" "), /YouTube/); assert.match(result.marketConfidenceReasons.join(" "), /Search Ad/);
});

test("missing optional sources neither add evidence nor fail an accepted result", () => {
  const result = calculateMarketConfidence(row({ sources: ["keywordstool"], earlyMarketEvidence: null, searchAdNewQuery: false,
    searchAdImpressionDelta: 0, searchAdClicks30d: 0, marketSourceConfidence: 0, shoppingRise: 0, news: null }), 300);
  assert.doesNotMatch(result.marketConfidenceReasons.join(" "), /YouTube|Search Ad|Shopping|뉴스|복수/);
  assert.ok(result.marketConfidenceScore > 0);
});

test("Search Ad evidence is counted once using the strongest available fact", () => {
  const result = calculateMarketConfidence(row({ searchAdNewQuery: true, searchAdImpressionDelta: 100, searchAdClicks30d: 20 }), 300);
  assert.equal(result.marketConfidenceComponents.searchAd, 8);
  assert.equal(result.marketConfidenceReasons.filter((reason) => reason.includes("Search Ad")).length, 1);
});

test("direct product relevance weighs more than brand and domain relevance", () => {
  const common = { sources: [], earlyMarketEvidence: null, searchAdNewQuery: false, shoppingRise: 0, news: null, absoluteSurgePassed: true, relativeSurgePassed: false };
  const product = calculateMarketConfidence(row({ ...common, resultType: "product_match", match: { score: 80 } }), 300);
  const brand = calculateMarketConfidence(row({ ...common, resultType: "brand_or_category_signal", match: { score: 38 } }), 300);
  const domain = calculateMarketConfidence(row({ ...common, resultType: "domain_related_signal", match: { score: 30 } }), 300);
  assert.ok(product.marketConfidenceComponents.relevance > brand.marketConfidenceComponents.relevance);
  assert.ok(brand.marketConfidenceComponents.relevance > domain.marketConfidenceComponents.relevance);
});

test("confidence grades use conservative thresholds", () => {
  assert.equal(grade(85), "very_strong"); assert.equal(grade(70), "strong"); assert.equal(grade(50), "medium"); assert.equal(grade(49), "reference");
});

test("yesterday summary and TOP 10 are one UI panel and confidence is exported", () => {
  const html = fs.readFileSync("index.html", "utf8");
  const panel = html.match(/<section class="panel" id="yesterdaySurgePanel">[\s\S]*?<\/section>/)?.[0] || "";
  assert.match(panel, /TOP 10 결과/); assert.match(panel, /trendChart/); assert.match(html, /marketConfidenceSummary/);
  assert.match(html, /종합 신뢰도/); assert.match(html, /신뢰도 근거/);
});

test("confidence calculation itself performs no external API call", () => {
  const source = fs.readFileSync("netlify/functions/market-confidence.js", "utf8"); assert.doesNotMatch(source, /fetch\s*\(/);
});
