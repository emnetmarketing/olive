const crypto = require("node:crypto");

const NAVER_OPEN_API = "https://openapi.naver.com";
const NAVER_SEARCHAD_API = "https://api.searchad.naver.com";
const SHOPPING_CATEGORIES = [
  { name: "화장품/미용", id: "50000002" },
  { name: "건강식품", id: "50000023" }
];

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  };
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function responseJson(response, apiName) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = payload.errorMessage || payload.message || payload.detail || "응답 본문에 원인이 없습니다.";
    throw new Error(`${apiName} 호출 실패: HTTP ${response.status} · ${reason}`);
  }
  return payload;
}

async function openApiRequest(path, { method = "GET", params, body }) {
  const clientId = String(process.env.NAVER_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.NAVER_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) throw new Error("Netlify 환경변수 NAVER_CLIENT_ID/NAVER_CLIENT_SECRET이 설정되지 않았습니다.");

  const url = new URL(path, NAVER_OPEN_API);
  if (params) Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await fetch(url, {
    method,
    headers: {
      "X-Naver-Client-Id": clientId,
      "X-Naver-Client-Secret": clientSecret,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return responseJson(response, path);
}

function searchAdAccounts() {
  return [1, 2].map((number) => ({
    number,
    label: `쇼핑검색광고 계정${number}`,
    endpoint: String(process.env[`NAVER_SEARCHAD_ENDPOINT_${number}`] || NAVER_SEARCHAD_API).trim(),
    apiKey: String(process.env[`NAVER_SEARCHAD_API_KEY_${number}`] || "").trim(),
    secretKey: String(process.env[`NAVER_SEARCHAD_SECRET_KEY_${number}`] || "").trim(),
    customerId: String(process.env[`NAVER_SEARCHAD_CUSTOMER_ID_${number}`] || "").trim()
  })).filter((account) => account.apiKey || account.secretKey || account.customerId);
}

async function searchAdGet(account, path, params) {
  const missing = [
    [account.apiKey, "API Key"], [account.secretKey, "Secret Key"], [account.customerId, "Customer ID"]
  ].filter(([value]) => !value).map(([, name]) => name);
  if (missing.length) throw new Error(`${account.label} 환경변수 누락: ${missing.join(", ")}`);

  const method = "GET";
  const timestamp = Date.now().toString();
  const signature = crypto.createHmac("sha256", account.secretKey)
    .update(`${timestamp}.${method}.${path}`).digest("base64");
  const url = new URL(path, account.endpoint);
  if (params) Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await fetch(url, {
    method,
    headers: {
      "X-Timestamp": timestamp,
      "X-API-KEY": account.apiKey,
      "X-Customer": account.customerId,
      "X-Signature": signature
    }
  });
  return responseJson(response, account.label);
}

async function searchAdProducts(account) {
  const productGroups = await searchAdGet(account, "/ncc/product-groups");
  if (!Array.isArray(productGroups)) throw new Error(`${account.label} 상품그룹 응답 형식 오류`);
  return productGroups.map((group) => ({
      account: account.label,
      campaign: "쇼핑검색광고 상품그룹",
      adGroup: `${Number(group.numberOfAdgroups || 0)}개 광고그룹 사용`,
      brand: String(group.brandName || "").trim(),
      product: String(group.name || "").trim(),
      productGroupId: group.nccProductGroupId,
      registrationMethod: group.registrationMethod,
      registeredProductType: group.registeredProductType
    })).filter((item) => item.product || item.brand);
}

function latestPair(data) {
  const points = Array.isArray(data) ? data : [];
  return { current: Number(points.at(-1)?.ratio || 0), previous: Number(points.at(-2)?.ratio || 0) };
}

function addSeries(target, results) {
  for (const result of results || []) {
    const keyword = String(result.title || result.keyword || "").trim();
    if (keyword) target.set(keyword, latestPair(result.data));
  }
}

function mergeSeriesMax(target, results, category) {
  for (const result of results || []) {
    const keyword = String(result.title || result.keyword || "").trim();
    if (!keyword) continue;
    const incoming = latestPair(result.data);
    const existing = target.get(keyword) || { current: 0, previous: 0, categories: [] };
    target.set(keyword, {
      current: Math.max(existing.current, incoming.current),
      previous: Math.max(existing.previous, incoming.previous),
      categories: [...new Set([...existing.categories, category.name])]
    });
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST 요청만 허용됩니다." });
  let input;
  try { input = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "요청 JSON 형식이 올바르지 않습니다." }); }

  const startDate = String(input.startDate || "").trim();
  const endDate = String(input.endDate || "").trim();
  const requestedKeywords = [...new Set((Array.isArray(input.keywords) ? input.keywords : [])
    .map((value) => String(value || "").trim()).filter(Boolean))];
  if (!startDate || !endDate) return json(400, { error: "수집 시작일과 종료일이 필요합니다." });

  const errors = {};
  const searchAdItems = [];
  const searchAdCounts = {};
  const accounts = searchAdAccounts();
  if (!accounts.length) {
    errors["네이버 검색광고"] = "Netlify Search Ad 환경변수가 설정되지 않았습니다.";
  } else {
    const accountResults = await Promise.allSettled(accounts.map(searchAdProducts));
    accountResults.forEach((result, index) => {
      const label = accounts[index].label;
      if (result.status === "fulfilled") {
        searchAdItems.push(...result.value);
        searchAdCounts[label] = result.value.length;
      } else {
        errors[label] = result.reason?.message || `${label} 호출 실패`;
        searchAdCounts[label] = 0;
      }
    });
  }

  const keywords = [...new Set([
    ...requestedKeywords,
    ...searchAdItems.map((item) => item.product)
  ])].slice(0, 10);
  if (!keywords.length) return json(400, { error: "검색광고 응답 또는 업로드 데이터에서 실제 분석 키워드를 찾지 못했습니다.", errors });

  const datalab = new Map();
  const shoppingInsight = new Map();
  const news = new Map();
  try {
    for (const batch of chunks(keywords, 5)) {
      const payload = await openApiRequest("/v1/datalab/search", {
        method: "POST",
        body: { startDate, endDate, timeUnit: "date", keywordGroups: batch.map((keyword) => ({ groupName: keyword, keywords: [keyword] })) }
      });
      addSeries(datalab, payload.results);
    }
  } catch (error) { errors["네이버 검색어트렌드"] = error.message; }

  try {
    for (const category of SHOPPING_CATEGORIES) {
      for (const batch of chunks(keywords, 5)) {
        const payload = await openApiRequest("/v1/datalab/shopping/category/keywords", {
          method: "POST",
          body: { startDate, endDate, timeUnit: "date", category: category.id, keyword: batch.map((keyword) => ({ name: keyword, param: [keyword] })) }
        });
        mergeSeriesMax(shoppingInsight, payload.results, category);
      }
    }
  } catch (error) { errors["네이버 쇼핑인사이트"] = error.message; }

  const newsResults = await Promise.allSettled(keywords.map(async (keyword) => {
    const payload = await openApiRequest("/v1/search/news.json", { params: { query: keyword, display: 1, start: 1, sort: "date" } });
    return [keyword, Number(payload.total || 0)];
  }));
  const newsFailures = [];
  newsResults.forEach((result, index) => {
    if (result.status === "fulfilled") news.set(result.value[0], result.value[1]);
    else newsFailures.push(`${keywords[index]}: ${result.reason?.message || "호출 실패"}`);
  });
  if (newsFailures.length) errors["네이버 뉴스"] = newsFailures.join(" / ");

  const rows = keywords.map((keyword) => ({
    keyword,
    datalabCurrent: datalab.get(keyword)?.current ?? null,
    datalabPrevious: datalab.get(keyword)?.previous ?? null,
    shoppingInsightCurrent: shoppingInsight.get(keyword)?.current ?? null,
    shoppingInsightPrevious: shoppingInsight.get(keyword)?.previous ?? null,
    shoppingCategories: shoppingInsight.get(keyword)?.categories || [],
    newsTotal: news.get(keyword) ?? null
  }));
  return json(200, {
    rows, searchAdItems,
    counts: { searchAd: searchAdItems.length, datalab: datalab.size, shoppingInsight: shoppingInsight.size, news: news.size },
    errors,
    categories: SHOPPING_CATEGORIES,
    searchAdCounts
  });
};
