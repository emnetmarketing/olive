const assert = require("node:assert/strict");
const { _test } = require("../netlify/functions/keyword-candidate-refresh-background.js");

assert.equal(_test.normalize("메디힐 세럼 40ml 1+1 기획"), "메디힐 세럼");
assert.equal(_test.classify("레티놀 세럼"), "beauty");
assert.equal(_test.classify("유산균 영양제"), "health");
assert.equal(_test.numericVolume("12,300"), 12300);
assert.equal(_test.numericVolume("< 10"), null);
const seeds = _test.productSeeds([{ product: "메디힐 비타민씨 브라이트닝 세럼 40ml 기획", brand: "메디힐" }]);
assert.ok(seeds.includes("메디힐"));
assert.ok(seeds.some((seed) => seed.includes("세럼")));
console.log("Keyword candidate normalization and seed extraction OK");
