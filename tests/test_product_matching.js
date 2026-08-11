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
const numericBrandOnly = evaluateMatch("블랑101", { brand: "", product: "블랑101 고농축 세탁세제 1L" });
assert.ok(numericBrandOnly.score < 60);
assert.equal(numericBrandOnly.judgment, "브랜드 관련");

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

const concentrationProducts = [
  { product: "오휘 데이쉴드 나이아신아마이드 5% 톤업 선", account: "계정2" },
  { product: "구달 청귤 비타C 나이아신아마이드10 흔적앰플", account: "계정1" },
  { product: "주미소 나이아신아마이드 10% 세럼 40ml", account: "계정1" },
  { product: "디오디너리 나이아신아마이드 10%+징크 1%", account: "계정1" },
  { product: "주미소 나이아신아마이드 20% 세럼 40ml", account: "계정1" },
  { product: "더마팩토리 나이아신아마이드20% 세럼 30ml", account: "계정2" }
];
const concentrationIndex = buildProductIndex(concentrationProducts);
const match5 = findBestMatch("나이아신아마이드5", concentrationProducts, concentrationIndex);
const match10 = findBestMatch("나이아신아마이드10", concentrationProducts, concentrationIndex);
const match20 = findBestMatch("나이아신아마이드20", concentrationProducts, concentrationIndex);
assert.deepEqual([match5.matchingCandidateCount, match10.matchingCandidateCount, match20.matchingCandidateCount], [1, 3, 2]);
assert.deepEqual([match5.score, match10.score, match20.score], [94, 88, 90]);
assert.deepEqual([match5.additionalMatches.length, match10.additionalMatches.length, match20.additionalMatches.length], [0, 2, 1]);
assert.ok([match5, match10, match20].every((match) => match.score < 100 && match.judgment === "강한 매칭"));

const uniquelyIdentified = [{ brand: "라로슈포제", product: "라로슈포제 에빠끌라 B5", account: "계정1" }];
const uniqueMatch = findBestMatch("라로슈포제 에빠끌라 B5", uniquelyIdentified, buildProductIndex(uniquelyIdentified));
assert.equal(uniqueMatch.matchingCandidateCount, 1);
assert.equal(uniqueMatch.uniqueIdentification, true);
assert.equal(uniqueMatch.score, 100);
console.log("Structured product matching signals and judgments OK");
