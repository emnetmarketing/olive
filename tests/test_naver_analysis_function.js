const assert = require("node:assert/strict");
process.env.NAVER_CLIENT_ID = "client";
process.env.NAVER_CLIENT_SECRET = "secret";
process.env.NAVER_SEARCHAD_API_KEY_1 = "api-key";
process.env.NAVER_SEARCHAD_SECRET_KEY_1 = "secret-key";
process.env.NAVER_SEARCHAD_CUSTOMER_ID_1 = "customer";
const { handler } = require("../netlify/functions/naver-analysis.js");

const requestedPaths = [];
global.fetch = async (url) => {
  const parsed = new URL(url);
  requestedPaths.push(parsed.pathname);
  let payload;
  if (parsed.pathname === "/ncc/product-groups") {
    payload = [{ name: "실제키워드", brandName: "실제브랜드", nccProductGroupId: "product-group-1", numberOfAdgroups: 2 }];
  } else if (parsed.pathname === "/v1/datalab/search") {
    payload = { results: [{ title: "실제키워드", data: [{ ratio: 10 }, { ratio: 25 }] }] };
  } else if (parsed.pathname === "/v1/datalab/shopping/category/keywords") {
    payload = { results: [{ title: "실제키워드", data: [{ ratio: 12 }, { ratio: 30 }] }] };
  } else {
    payload = { total: 7, items: [] };
  }
  return { ok: true, status: 200, json: async () => payload };
};

(async () => {
  const response = await handler({
    httpMethod: "POST",
    body: JSON.stringify({
      startDate: "2026-08-01", endDate: "2026-08-10", keywords: ["실제키워드"]
    })
  });
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(body.errors, {});
  assert.equal(body.rows[0].datalabCurrent, 25);
  assert.equal(body.rows[0].datalabPrevious, 10);
  assert.equal(body.rows[0].shoppingInsightCurrent, 30);
  assert.equal(body.rows[0].newsTotal, 7);
  assert.equal(body.searchAdItems[0].productGroupId, "product-group-1");
  assert.deepEqual(body.categories.map((category) => category.id), ["50000002", "50000023"]);
  assert.deepEqual(requestedPaths.sort(), [
    "/v1/datalab/search",
    "/v1/datalab/shopping/category/keywords",
    "/v1/datalab/shopping/category/keywords",
    "/v1/search/news.json",
    "/ncc/product-groups"
  ].sort());
  console.log("Netlify Naver analysis function flow OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
