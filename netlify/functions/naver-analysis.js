const crypto = require("node:crypto");

const NAVER_API_HUB = "https://naverapihub.apigw.ntruss.com";
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

async function mapWithConcurrency(values, concurrency, mapper) {
  const output = [];
  for (const batch of chunks(values, concurrency)) output.push(...await Promise.all(batch.map(mapper)));
  return output;
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

  const url = new URL(path, NAVER_API_HUB);
  if (params) Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await fetch(url, {
    method,
    headers: {
      "X-NCP-APIGW-API-KEY-ID": clientId,
      "X-NCP-APIGW-API-KEY": clientSecret,
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
  const registeredGroups = productGroups.map((group) => ({
      account: account.label,
      campaign: "쇼핑검색광고 상품그룹",
      adGroup: `${Number(group.numberOfAdgroups || 0)}개 광고그룹 사용`,
      brand: String(group.brandName || "").trim(),
      product: String(group.name || "").trim(),
      productGroupId: group.nccProductGroupId,
      registrationMethod: group.registrationMethod,
      registeredProductType: group.registeredProductType
    })).filter((item) => item.product || item.brand);
  if (registeredGroups.length) return { items: registeredGroups, meta: { source: "product-groups", limited: false } };

  const campaigns = await searchAdGet(account, "/ncc/campaigns");
  const shoppingCampaigns = (Array.isArray(campaigns) ? campaigns : []).filter((campaign) => {
    const type = String(campaign.campaignTp || campaign.type || "").toUpperCase();
    return ["SHOPPING", "CATALOG", "SHOPPING_BRAND"].some((value) => type.includes(value))
      && campaign.status !== "DELETED" && campaign.userLock !== true;
  });
  const selectedCampaigns = shoppingCampaigns.slice(0, 3);
  const groupResults = await mapWithConcurrency(selectedCampaigns, 3, (campaign) =>
    searchAdGet(account, "/ncc/adgroups", { nccCampaignId: campaign.nccCampaignId })
      .then((groups) => ({ campaign, groups })));
  const allGroups = groupResults.flatMap(({ campaign, groups }) => (Array.isArray(groups) ? groups : [])
    .filter((group) => group.status !== "DELETED" && group.userLock !== true)
    .map((group) => ({ campaign, group })));
  const selectedGroups = allGroups.slice(0, 5);
  const adResults = await mapWithConcurrency(selectedGroups, 2, ({ campaign, group }) =>
    searchAdGet(account, "/ncc/ads", { nccAdgroupId: group.nccAdgroupId })
      .then((ads) => ({ campaign, group, ads })));
  const items = adResults.flatMap(({ campaign, group, ads }) => (Array.isArray(ads) ? ads : [])
    .filter((ad) => ["SHOPPING_PRODUCT_AD", "CATALOG_AD", "SHOPPING_BRAND_AD"].includes(ad.type))
    .map((ad) => ({
      account: account.label,
      campaign: String(campaign.name || "").trim(),
      adGroup: String(group.name || "").trim(),
      brand: "",
      product: findProductName(ad.ad),
      adId: ad.nccAdId,
      adType: ad.type
    })).filter((item) => item.product));
  return {
    items,
    meta: {
      source: "shopping-ads",
      limited: shoppingCampaigns.length > selectedCampaigns.length || allGroups.length > selectedGroups.length,
      shoppingCampaigns: shoppingCampaigns.length,
      inspectedCampaigns: selectedCampaigns.length,
      activeAdgroups: allGroups.length,
      inspectedAdgroups: selectedGroups.length
    }
  };
}

function findProductName(value) {
  let ad = value;
  if (typeof ad === "string") {
    try { ad = JSON.parse(ad); }
    catch { return ad.trim(); }
  }
  if (!ad || typeof ad !== "object") return "";
  for (const key of ["productName", "productTitle", "title", "headline", "subject", "name"]) {
    if (typeof ad[key] === "string" && ad[key].trim()) return ad[key].trim();
  }
  for (const nested of Object.values(ad)) {
    const found = findProductName(nested);
    if (found) return found;
  }
  return "";
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

function balancedAccountKeywords(items, limit = 10) {
  const groups = new Map();
  for (const item of items) {
    const account = String(item.account || "계정 미지정");
    if (!groups.has(account)) groups.set(account, []);
    const product = String(item.product || item.brand || "").trim();
    if (product && !groups.get(account).includes(product)) groups.get(account).push(product);
  }
  const queues = [...groups.values()];
  const selected = [];
  for (let index = 0; selected.length < limit && queues.some((queue) => index < queue.length); index += 1) {
    for (const queue of queues) {
      if (index < queue.length && !selected.includes(queue[index])) selected.push(queue[index]);
      if (selected.length === limit) break;
    }
  }
  return selected;
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
  const searchAdMeta = {};
  const accounts = searchAdAccounts();
  if (!accounts.length) {
    errors["네이버 검색광고"] = "Netlify Search Ad 환경변수가 설정되지 않았습니다.";
  } else {
    const accountResults = await Promise.allSettled(accounts.map(searchAdProducts));
    accountResults.forEach((result, index) => {
      const label = accounts[index].label;
      if (result.status === "fulfilled") {
        searchAdItems.push(...result.value.items);
        searchAdCounts[label] = result.value.items.length;
        searchAdMeta[label] = result.value.meta;
      } else {
        errors[label] = result.reason?.message || `${label} 호출 실패`;
        searchAdCounts[label] = 0;
      }
    });
  }

  const keywords = [...new Set([
    ...requestedKeywords,
    ...balancedAccountKeywords(searchAdItems, 10)
  ])].slice(0, 10);
  if (!keywords.length) return json(400, { error: "검색광고 응답 또는 업로드 데이터에서 실제 분석 키워드를 찾지 못했습니다.", errors });

  const datalab = new Map();
  const shoppingInsight = new Map();
  const news = new Map();
  try {
    for (const batch of chunks(keywords, 5)) {
      const payload = await openApiRequest("/search-trend/v1/search", {
        method: "POST",
        body: { startDate, endDate, timeUnit: "date", keywordGroups: batch.map((keyword) => ({ groupName: keyword, keywords: [keyword] })) }
      });
      addSeries(datalab, payload.results);
    }
  } catch (error) { errors["네이버 검색어트렌드"] = error.message; }

  try {
    const payload = await openApiRequest("/shopping/v1/categories", {
      method: "POST",
      body: {
        startDate, endDate, timeUnit: "date",
        category: SHOPPING_CATEGORIES.map((category) => ({ name: category.name, param: [category.id] }))
      }
    });
    addSeries(shoppingInsight, payload.results);
  } catch (error) { errors["네이버 쇼핑인사이트"] = error.message; }

  const newsResults = await Promise.allSettled(keywords.map(async (keyword) => {
    const payload = await openApiRequest("/search/v1/news", { params: { query: keyword, display: 1, start: 1, sort: "date" } });
    return [keyword, Number(payload.total || 0)];
  }));
  const newsFailures = [];
  newsResults.forEach((result, index) => {
    if (result.status === "fulfilled") news.set(result.value[0], result.value[1]);
    else newsFailures.push(`${keywords[index]}: ${result.reason?.message || "호출 실패"}`);
  });
  if (newsFailures.length) errors["네이버 뉴스"] = newsFailures.join(" / ");

  const shoppingCategoryPairs = [...shoppingInsight.values()];
  const combinedShopping = {
    current: Math.max(0, ...shoppingCategoryPairs.map((value) => value.current)),
    previous: Math.max(0, ...shoppingCategoryPairs.map((value) => value.previous))
  };
  const rows = keywords.map((keyword) => ({
    keyword,
    datalabCurrent: datalab.get(keyword)?.current ?? null,
    datalabPrevious: datalab.get(keyword)?.previous ?? null,
    shoppingInsightCurrent: shoppingCategoryPairs.length ? combinedShopping.current : null,
    shoppingInsightPrevious: shoppingCategoryPairs.length ? combinedShopping.previous : null,
    shoppingCategories: SHOPPING_CATEGORIES.map((category) => category.name),
    newsTotal: news.get(keyword) ?? null
  }));
  return json(200, {
    rows, searchAdItems,
    counts: { searchAd: searchAdItems.length, datalab: datalab.size, shoppingInsight: shoppingInsight.size, news: news.size },
    errors,
    categories: SHOPPING_CATEGORIES,
    searchAdCounts,
    searchAdMeta
  });
};
