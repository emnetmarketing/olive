const assert = require("node:assert/strict");
const { evaluateMatch, buildProductIndex, findBestMatch } = require("../netlify/functions/product-matching");

const ingredientSpec = evaluateMatch("나이아신아마이드20", { brand: "더마팩토리", product: "더마팩토리 나이아신아마이드20% 세럼" });
assert.equal(ingredientSpec.signals.ingredientMatch, true);
assert.equal(ingredientSpec.signals.concentrationMatch, true);
assert.ok(ingredientSpec.score >= 70);
assert.match(ingredientSpec.reason, /성분 \+ 농도/);

const brandOnly = evaluateMatch("라로슈포제", { brand: "라로슈포제", product: "라로슈포제 에빠끌라 AI" });
assert.equal(brandOnly.signals.brandMatch, true);
assert.equal(brandOnly.signals.productLineMatch, false);
assert.ok(brandOnly.score < 60);
assert.equal(brandOnly.judgment, "브랜드 관련");

const brandLine = evaluateMatch("라로슈포제 에빠끌라", { brand: "라로슈포제", product: "라로슈포제 에빠끌라 AI" });
assert.equal(brandLine.signals.brandMatch, true);
assert.equal(brandLine.signals.productLineMatch, true);
assert.ok(brandLine.score >= 70);

const inferredBrandOnly = evaluateMatch("라로슈포제", { brand: "", product: "라로슈포제 에빠끌라 AI" });
assert.ok(inferredBrandOnly.score < 60);
assert.equal(inferredBrandOnly.judgment, "브랜드 관련");
const inferredBrandLine = evaluateMatch("라로슈포제 에빠끌라", { brand: "", product: "라로슈포제 에빠끌라 AI" });
assert.ok(inferredBrandLine.score >= 70);

const genericType = evaluateMatch("유산균", { brand: "종근당", product: "종근당 락토핏 유산균" });
assert.equal(genericType.signals.productTypeMatch, true);
assert.ok(genericType.score < 60);
assert.equal(genericType.judgment, "제품군 관련");

const brandType = evaluateMatch("종근당 유산균", { brand: "종근당", product: "종근당 락토핏 유산균" });
assert.equal(brandType.signals.brandMatch, true);
assert.equal(brandType.signals.productTypeMatch, true);
assert.ok(brandType.score >= 60);

const products = [
  { brand: "라로슈포제", product: "라로슈포제 에빠끌라 AI", account: "계정1" },
  { brand: "더마팩토리", product: "더마팩토리 나이아신아마이드20% 세럼", account: "계정2" }
];
const index = buildProductIndex(products);
const best = findBestMatch("나이아신아마이드20", products, index);
assert.equal(best.item.account, "계정2");
assert.ok(best.score >= 70);
console.log("Structured product matching signals and judgments OK");
