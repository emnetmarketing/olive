const crypto = require("node:crypto");
const { connectLambda, getStore } = require("@netlify/blobs");

const SEARCH_AD_API = "https://api.searchad.naver.com";
const STORE_NAME = "search-ad-products";
const CACHE_KEY = "current";
const STATUS_KEY = "status";
const SHOPPING_TYPES = new Set(["SHOPPING_PRODUCT_AD", "CATALOG_AD", "SHOPPING_BRAND_AD"]);
const DISABLED_STATUSES = new Set(["DELETED", "PAUSED", "SUSPENDED", "OFF"]);

function store() {
  return getStore(STORE_NAME);
}

function connect(event) {
  if (event?.blobs) connectLambda(event);
}

function accounts() {
  return [1, 2].map((number) => ({
    number,
    label: `쇼핑검색광고 계정${number}`,
    endpoint: String(process.env[`NAVER_SEARCHAD_ENDPOINT_${number}`] || SEARCH_AD_API).trim(),
    apiKey: String(process.env[`NAVER_SEARCHAD_API_KEY_${number}`] || "").trim(),
    secretKey: String(process.env[`NAVER_SEARCHAD_SECRET_KEY_${number}`] || "").trim(),
    customerId: String(process.env[`NAVER_SEARCHAD_CUSTOMER_ID_${number}`] || "").trim()
  }));
}

function isActive(value) {
  const status = String(value?.status || value?.statusCode || "").toUpperCase();
  return !DISABLED_STATUSES.has(status) && value?.userLock !== true && value?.deleted !== true;
}

async function responseJson(response, label) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = payload.errorMessage || payload.message || payload.detail || "응답 본문에서 원인을 확인할 수 없습니다.";
    const error = new Error(`${label} 호출 실패: HTTP ${response.status} · ${reason}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function searchAdGet(account, path, params, metrics, attempt = 0) {
  const missing = [[account.apiKey, "API Key"], [account.secretKey, "Secret Key"], [account.customerId, "Customer ID"]]
    .filter(([value]) => !value).map(([, name]) => name);
  if (missing.length) throw new Error(`${account.label} 환경변수 누락: ${missing.join(", ")}`);
  const timestamp = Date.now().toString();
  const signature = crypto.createHmac("sha256", account.secretKey)
    .update(`${timestamp}.GET.${path}`).digest("base64");
  const url = new URL(path, account.endpoint);
  Object.entries(params || {}).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  metrics.apiCalls += 1;
  try {
    const response = await fetch(url, {
      headers: {
        "X-Timestamp": timestamp,
        "X-API-KEY": account.apiKey,
        "X-Customer": account.customerId,
        "X-Signature": signature
      },
      signal: AbortSignal.timeout(20000)
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      metrics.retries += 1;
      await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
      return searchAdGet(account, path, params, metrics, attempt + 1);
    }
    return responseJson(response, account.label);
  } catch (error) {
    if ((error.name === "TimeoutError" || error.name === "AbortError") && attempt < 3) {
      metrics.retries += 1;
      await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
      return searchAdGet(account, path, params, metrics, attempt + 1);
    }
    throw error;
  }
}

function findValue(value, keys) {
  let item = value;
  if (typeof item === "string") {
    try { item = JSON.parse(item); } catch { return keys.includes("name") ? item.trim() : ""; }
  }
  if (!item || typeof item !== "object") return "";
  for (const key of keys) {
    if (item[key] !== undefined && item[key] !== null && String(item[key]).trim()) return String(item[key]).trim();
  }
  for (const nested of Object.values(item)) {
    const found = findValue(nested, keys);
    if (found) return found;
  }
  return "";
}

function productFromAd(account, group, ad) {
  if (!SHOPPING_TYPES.has(String(ad.type || "").toUpperCase()) || !isActive(ad)) return null;
  const productName = findValue(ad.ad, ["productName", "productTitle", "title", "headline", "subject", "name"]);
  if (!productName) return null;
  return {
    account: account.label,
    accountNumber: account.number,
    productId: findValue(ad.ad, ["productId", "mallProductId", "naverShoppingProductId", "productNo", "id"]),
    product: productName,
    brand: findValue(ad.ad, ["brandName", "brand"]),
    adId: String(ad.nccAdId || ad.adId || ""),
    adGroupId: String(group.nccAdgroupId || ""),
    active: true,
    adType: String(ad.type || "")
  };
}

function uniqueProducts(items) {
  const seen = new Set();
  return items.filter((item) => {
    const normalized = item.product.toLocaleLowerCase("ko-KR").replace(/\s+/g, " ").trim();
    const key = `${item.accountNumber}:${item.productId || normalized}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function readCache() {
  return store().get(CACHE_KEY, { type: "json" });
}

async function readStatus() {
  return store().get(STATUS_KEY, { type: "json" });
}

async function writeStatus(status) {
  await store().setJSON(STATUS_KEY, status);
  return status;
}

async function acquireJob() {
  const current = await readStatus();
  const updatedAt = Date.parse(current?.updatedAt || "");
  const stale = !Number.isFinite(updatedAt) || Date.now() - updatedAt > 30 * 60 * 1000;
  if (current?.state === "running" && !stale) return { acquired: false, status: current };
  const now = new Date().toISOString();
  const status = {
    jobId: crypto.randomUUID(), state: "running", message: "Search Ad 상품 동기화 준비 중",
    startedAt: now, updatedAt: now, processedAdgroups: 0, totalAdgroups: 0,
    accountProgress: { "1": { processed: 0, total: 0 }, "2": { processed: 0, total: 0 } },
    apiCalls: 0, retries: 0, errors: []
  };
  await writeStatus(status);
  const verified = await readStatus();
  return verified?.jobId === status.jobId ? { acquired: true, status } : { acquired: false, status: verified };
}

module.exports = {
  accounts, isActive, searchAdGet, productFromAd, uniqueProducts,
  readCache, readStatus, writeStatus, acquireJob, store,
  connect,
  CACHE_KEY, STATUS_KEY
};
