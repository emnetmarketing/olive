const assert = require("node:assert/strict");
process.env.NAVER_CLIENT_ID = "client";
process.env.NAVER_CLIENT_SECRET = "secret";
process.env.NAVER_SEARCHAD_API_KEY_1 = "api-key";
process.env.NAVER_SEARCHAD_SECRET_KEY_1 = "secret-key";
process.env.NAVER_SEARCHAD_CUSTOMER_ID_1 = "customer";
process.env.NAVER_SEARCHAD_API_KEY_2 = "api-key-2";
process.env.NAVER_SEARCHAD_SECRET_KEY_2 = "secret-key-2";
process.env.NAVER_SEARCHAD_CUSTOMER_ID_2 = "customer-2";
const { handler } = require("../netlify/functions/naver-analysis.js");

const requestedPaths = [];
const apiHubHeaders = [];
global.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  requestedPaths.push(parsed.pathname);
  if (parsed.hostname === "naverapihub.apigw.ntruss.com") apiHubHeaders.push(options.headers);
  let payload;
  if (parsed.pathname === "/ncc/product-groups") {
    payload = options.headers["X-Customer"] === "customer-2"
      ? [{ name: "계정2실제키워드", brandName: "계정2브랜드", nccProductGroupId: "product-group-2", numberOfAdgroups: 1 }]
      : [{ name: "실제키워드", brandName: "실제브랜드", nccProductGroupId: "product-group-1", numberOfAdgroups: 2 }];
  } else if (parsed.pathname === "/search-trend/v1/search") {
    payload = { results: [{ title: "실제키워드", data: [{ ratio: 10 }, { ratio: 25 }] }] };
  } else if (parsed.pathname === "/shopping/v1/categories") {
    payload = { results: [
      { title: "화장품/미용", data: [{ ratio: 12 }, { ratio: 30 }] },
      { title: "건강식품", data: [{ ratio: 8 }, { ratio: 20 }] }
    ] };
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
  assert.ok(body.rows.some((row) => row.keyword === "계정2실제키워드"));
  assert.deepEqual(body.categories.map((category) => category.id), ["50000002", "50000023"]);
  assert.ok(apiHubHeaders.every((headers) => headers["X-NCP-APIGW-API-KEY-ID"] === "client"));
  assert.ok(apiHubHeaders.every((headers) => headers["X-NCP-APIGW-API-KEY"] === "secret"));
  assert.ok(apiHubHeaders.every((headers) => !("X-Naver-Client-Id" in headers)));
  assert.equal(requestedPaths.filter((path) => path === "/ncc/product-groups").length, 2);
  assert.equal(requestedPaths.filter((path) => path === "/search-trend/v1/search").length, 1);
  assert.equal(requestedPaths.filter((path) => path === "/shopping/v1/categories").length, 1);
  assert.equal(requestedPaths.filter((path) => path === "/search/v1/news").length, 2);
  console.log("Netlify Naver analysis function flow OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
