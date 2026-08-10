const assert = require("node:assert/strict");
const fs = require("node:fs");
const { isActive, productFromAd, uniqueProducts } = require("../netlify/functions/search-ad-cache.js");

const account = { number: 1, label: "쇼핑검색광고 계정1" };
const group = { nccAdgroupId: "group-1" };
const active = productFromAd(account, group, {
  nccAdId: "ad-1", type: "SHOPPING_PRODUCT_AD", status: "ELIGIBLE", userLock: false,
  ad: { productId: "product-1", productName: "실제 상품명", brandName: "실제 브랜드" }
});
assert.equal(active.product, "실제 상품명");
assert.equal(active.productId, "product-1");
assert.equal(active.active, true);
assert.equal(productFromAd(account, group, { type: "SHOPPING_PRODUCT_AD", status: "DELETED", ad: { productName: "삭제 상품" } }), null);
assert.equal(isActive({ status: "PAUSED" }), false);
assert.equal(isActive({ status: "ELIGIBLE", userLock: false }), true);
assert.equal(uniqueProducts([active, { ...active, adId: "ad-2" }]).length, 1);

const background = fs.readFileSync("netlify/functions/search-ad-refresh-background.js", "utf8");
const analysis = fs.readFileSync("netlify/functions/naver-analysis.js", "utf8");
const cacheModuleSource = fs.readFileSync("netlify/functions/search-ad-cache.js", "utf8");
assert.equal(background.includes("slice(0, 3)"), false);
assert.equal(background.includes("slice(0, 5)"), false);
assert.match(background, /CONCURRENCY = 4/);
assert.match(background, /setJSON\(CACHE_KEY, cache\)/);
assert.match(analysis, /await readCache\(\)/);
assert.match(cacheModuleSource, /connectLambda\(event\)/);
console.log("Search Ad cache and full synchronization helpers OK");
