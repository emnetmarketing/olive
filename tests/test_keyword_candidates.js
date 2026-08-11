const assert = require("node:assert/strict");
const { _test } = require("../netlify/functions/keyword-candidate-refresh-background.js");

assert.equal(_test.normalize("메디힐 세럼 40ml 1+1 기획"), "메디힐 세럼");
assert.equal(_test.classify("레티놀 세럼"), "beauty");
assert.equal(_test.classify("유산균 영양제"), "health");
assert.equal(_test.classify("키보드"), "unknown");
assert.equal(_test.classify("라로슈포제", "라로슈포제 에빠끌라 세럼"), "beauty");
assert.equal(_test.classify("비피더스", "비피더스 유산균 영양제"), "health");
assert.equal(_test.numericVolume("12,300"), 12300);
assert.equal(_test.numericVolume("< 10"), null);
const seeds = _test.productSeeds([{ product: "메디힐 비타민씨 브라이트닝 세럼 40ml 기획", brand: "메디힐" }]);
assert.ok(seeds.includes("메디힐"));
assert.ok(seeds.some((seed) => seed.includes("세럼")));
const contexts = _test.buildGroupContexts([{ accountNumber: 1, adGroupId: "g1", product: "유산균 영양제", brand: "브랜드" }]);
assert.match(contexts.get("1:g1").text, /유산균/);
assert.ok(_test.candidatePriority({ category: "health", monthlyTotalSearches: 10000, impressions30d: 1, impressionDelta: 1, firstSeenAt: new Date().toISOString(), sources: ["keywordstool"] }) >
  _test.candidatePriority({ category: "unknown", monthlyTotalSearches: 10000, impressions30d: 100000, impressionDelta: 0, firstSeenAt: "2020-01-01", sources: ["searchad-query"] }));
console.log("Keyword candidate normalization and seed extraction OK");
