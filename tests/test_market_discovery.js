const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../netlify/functions/market-discovery-core");
const { _test: analysis } = require("../netlify/functions/trend-analysis-background");

const products = [
  { product: "넘버즈인 1번 판토텐산스킨케어100 블러 파우더", adGroupId: "n1" },
  { product: "넘버즈인 3번 결광가득 에센스 토너", adGroupId: "n2" },
  { product: "넘버즈인 5번 글루타치온 세럼", adGroupId: "n3" },
  { product: "마데카 크림 시즌7", brand: "마데카", adGroupId: "m1" },
  { product: "마데카 앰플", brand: "마데카", adGroupId: "m2" },
];

test("product cache creates only verified brand/product-context candidates", () => {
  const items = core.productCandidates(products, { limit: 100 });
  const keys = new Set(items.map((item) => item.normalizedKeyword));
  assert.ok(keys.has("넘버즈인파우더"));
  assert.ok(keys.has("마데카크림"));
  assert.ok(!keys.has("비타민d"));
});

test("youtube extraction merges repeated brand/product evidence", () => {
  const videos = [
    { videoId: "v1", channelId: "c1", title: "넘버즈인 파우더 신제품 리뷰", description: "넘버즈인 파우더", publishedAt: new Date().toISOString() },
    { videoId: "v2", channelId: "c2", title: "요즘 넘버즈인 파우더 써봄", description: "", publishedAt: new Date().toISOString() },
  ];
  const items = core.youtubeCandidates(videos, products);
  const target = items.find((item) => item.normalizedKeyword === "넘버즈인파우더");
  assert.ok(target);
  assert.equal(target.youtubeEvidence.length, 2);
  assert.equal(target.evidence[0].videoCount, 2);
  assert.equal(target.evidence[0].channelCount, 2);
});

test("multi-source candidates merge without resetting first discovery", () => {
  const old = { keyword: "마데카크림", normalizedKeyword: "마데카크림", discoverySource: ["product-cache"], discoveredAt: "2026-08-20T00:00:00.000Z", sourceConfidence: 70, evidence: [] };
  const fresh = { keyword: "마데카 크림", normalizedKeyword: "마데카크림", discoverySource: ["youtube"], sourceConfidence: 80, evidence: [] };
  const [merged] = core.mergeCandidates([old], [fresh], new Date("2026-08-25T00:00:00.000Z"));
  assert.equal(merged.discoveredAt, old.discoveredAt);
  assert.deepEqual(new Set(merged.discoverySource), new Set(["product-cache", "youtube"]));
  assert.ok(merged.sourceConfidence > 80);
});

test("market discovery reserves at most 500 and fills unused slots from existing candidates", () => {
  const market = Array.from({ length: 600 }, (_, i) => ({ keyword: `브랜드${i}크림`, discoverySource: ["product-cache"], discoveredAt: "2026-08-25T00:00:00.000Z",
    sourceConfidence: 80, relatedBrand: `브랜드${i}`, relatedProductType: "크림", monthlySearchStatus: "available", monthlyTotalSearches: 100 + i }));
  const base = Array.from({ length: 5000 }, (_, i) => ({ keyword: `기존후보${i}`, category: "beauty", categoryEvidence: "keyword", sources: ["searchad-query"],
    firstSeenAt: "2026-01-01T00:00:00.000Z", monthlyVolumeStatus: "available", monthlyTotalSearches: 1000 + i, priorityScore: i }));
  const selected = analysis.selectWithMarketDiscovery(base, market, new Map(), 5000, 500);
  assert.equal(selected.diagnostics.marketSelected, 500);
  assert.equal(selected.selected.length + selected.ratioOnly.length, 5000);
});

test("ratio-only calculations never fabricate estimated search volume", () => {
  const data = Array.from({ length: 10 }, (_, i) => ({ period: `2026-08-${String(i + 1).padStart(2, "0")}`, ratio: i === 9 ? 40 : 10 }));
  const metrics = analysis.ratioOnlyMetrics(data, "2026-08-08", "2026-08-10");
  assert.equal(metrics.ratioPeak, 40);
  assert.equal(metrics.ratioBaseline, 10);
  assert.equal(metrics.relativeRatioLift, 300);
  assert.equal(Object.hasOwn(metrics, "estimatedSurgeCount"), false);
});

test("generic ambiguous words are not inferred as verified brands", () => {
  const index = analysis.buildIndex([
    { product: "비타 비타민 세럼", adGroupId: "x1" },
    { product: "비타 비타민 크림", adGroupId: "x2" },
  ]);
  const match = analysis.bestMatch("비타민D", [
    { product: "비타 비타민 세럼", adGroupId: "x1" },
    { product: "비타 비타민 크림", adGroupId: "x2" },
  ], index);
  assert.equal(match?.signals?.brandMatch, false);
});

test("unavailable strong market evidence uses ratio-only slot without fabricated volume", () => {
  const market = [{ keyword: "헤라블랙쿠션", discoverySource: ["product-cache", "youtube"], discoveredAt: "2026-08-25T00:00:00.000Z",
    sourceConfidence: 90, relatedBrand: "헤라", relatedProductType: "쿠션", monthlySearchStatus: "keywordtool-unavailable" }];
  const selected = analysis.selectWithMarketDiscovery([], market, new Map(), 5000, 500);
  assert.equal(selected.selected.length, 0);
  assert.equal(selected.ratioOnly.length, 1);
  assert.equal(selected.ratioOnly[0].monthlyTotalSearches, null);
});

test("unused market slots are fully returned to existing candidates", () => {
  const base = Array.from({ length: 100 }, (_, i) => ({ keyword: `기존${i}`, category: "beauty", categoryEvidence: "keyword", sources: ["searchad-query"],
    firstSeenAt: "2026-01-01T00:00:00.000Z", monthlyVolumeStatus: "available", monthlyTotalSearches: 1000 + i, priorityScore: i }));
  const selected = analysis.selectWithMarketDiscovery(base, [], new Map(), 100, 500);
  assert.equal(selected.selected.length, 100);
  assert.equal(selected.ratioOnly.length, 0);
});

test("ambiguous single terms are not promoted by an unrelated cosmetic product", () => {
  for (const keyword of ["두유", "카카오"]) {
    const items = [{ product: `${keyword} 세럼`, brand: "믹순", adGroupId: "a" }];
    const match = analysis.bestMatch(keyword, items, analysis.buildIndex(items));
    assert.equal(analysis.classifySurgeResult({ keyword, category: "beauty" }, match, items, 40).resultType, null);
  }
});
