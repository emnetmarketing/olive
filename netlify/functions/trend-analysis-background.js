const { connect, store: analysisStore, readJob, writeJob, writeLastSuccess, writeLastPartial, writeDiagnosticIndex } = require("./trend-analysis-cache");
const { readCandidateCache } = require("./keyword-candidate-cache");
const { readCache: readMarketDiscoveryCache } = require("./market-discovery-cache");
const { discoveryPriority } = require("./market-discovery-core");
const { readCache: readProductCache } = require("./search-ad-cache");
const { connect: connectTrendCache, readCache: readTrendSeriesCache, lookup: lookupTrendSeries,
  upsert: upsertTrendSeries, writeDirty: writeDirtyTrendSeries } = require("./trend-series-cache");
const { connect: connectQuota, readUsage: readQuotaUsage, statusFor: quotaStatusFor, recordUsageBatch: recordQuotaUsageBatch } = require("./trend-api-quota");
const { candidateTier, isDueForCollection, priorityWeight } = require("./trend-collection-policy");
const { connect: connectSnapshot, writeSnapshot } = require("./signal-snapshot-cache");
const { readHistory: readDiscoveryHistory, writeHistory: writeDiscoveryHistory, mergeSignalHistory, mergeEarlySignalHistory } = require("./market-discovery-history-cache");
const earlySignals = require("./today-early-signal-cache");
const { calculateMarketConfidence } = require("./market-confidence");
const schedulerExecutions = require("./trend-scheduler-execution-cache");
const { PRODUCT_TYPES, INGREDIENTS, compact, matchTokens, evaluateMatch, buildProductIndex, findBestMatch,
  detectVerifiedBrandProductContext } = require("./product-matching");
const { readSurgeHistory, writeSurgeHistory, upsertInstantHistory, deriveSurgeState, historyProtectionSignal,
  normalizeKeyword, CALCULATION_VERSION } = require("./surge-history-cache");

const API_HUB = "https://naverapihub.apigw.ntruss.com";
const CATEGORY_IDS = { beauty: "50000002", health: "50000023" };
const MAX_ACTIVE_CANDIDATES = 5000;
const RELATIVE_SURGE_PERCENT = 50;
const RELATIVE_SURGE_MIN_LIFT = 100;
const LOW_INTENSITY_SURGE_PERCENT = 20;
const LOW_INTENSITY_SURGE_MIN_LIFT = 40;
const TREND_BATCH_DELAY_MS = 1500;
const CANDIDATE_GROUP_QUOTAS = { new: 1500, highVolume: 1250, recentChange: 1000, priorSurge: 750, domainEvidence: 500 };
const BUSINESS_DOMAIN_TERMS = [
  "유산균", "프로바이오틱", "프리바이오틱", "콜라겐", "비타민", "영양제", "건강식품", "오메가", "프로틴", "단백질", "단백바", "쉐이크",
  "홍삼", "효소", "루테인", "마그네슘", "아연", "철분", "밀크씨슬", "글루타치온", "비오틴", "베르베린", "면역", "혈행", "관절", "장건강", "위건강",
  "세럼", "크림", "쿠션", "선크림", "마스크", "앰플", "토너", "로션", "클렌징", "클렌저", "샴푸", "트리트먼트", "립", "향수",
  "메이크업", "파운데이션", "네일", "헤어", "바디", "레티놀", "나이아신아마이드", "히알루론산", "세라마이드", "판테놀", "병풀", "시카",
  "브라이트닝", "미백", "보습", "화장품", "에센스", "틴트", "섀도우", "라이너", "브로우", "블러셔", "모공", "피부", "수딩", "브러쉬",
  "마사지", "괄사", "지압", "교정", "스트레칭", "폼롤러", "근막", "골반", "척추", "보호대", "패치", "치약", "칫솔", "구강", "생리", "여성청결", "다이어트"
];

function productBrandToken(item) {
  const explicit = compact(item?.brand);
  if (explicit) return explicit;
  const first = matchTokens(item?.product)[0] || "";
  return PRODUCT_TYPES.has(first) || INGREDIENTS.has(first) ? "" : compact(first);
}

function buildBrandOrCategorySignal(candidate, match, products) {
  if (!match?.signals || !["beauty", "health"].includes(candidate?.category)) return null;
  if (!match.signals.brandMatch || match.signals.genericOnlyMatch) return null;
  const brandOnly = !match.signals.productLineMatch && !match.signals.productTypeMatch
    && !match.signals.ingredientMatch && !match.signals.specMatch;
  const brandToken = compact(match.item?.brand) || (brandOnly ? compact(candidate.keyword) : productBrandToken(match.item));
  if (!brandToken || !compact(candidate.keyword).includes(brandToken)) return null;
  const related = products.filter((item) => compact(item?.brand) === brandToken
    || compact(item?.product).includes(brandToken));
  if (!related.length) return null;
  return {
    signalType: "brand",
    relatedBrand: String(match.item?.brand || matchTokens(match.item?.product)[0] || candidate.keyword),
    relatedProductCount: related.length,
    referenceProducts: related.slice(0, 5).map((item) => ({
      product: item.product || item.brand || "", brand: item.brand || "", account: item.account || "",
      productId: item.productId || item.id || null, adGroupId: item.adGroupId || null, adId: item.adId || null,
    })),
    judgment: "브랜드 급등",
    reason: `${String(match.item?.brand || matchTokens(match.item?.product)[0] || candidate.keyword)} 브랜드 관련 상품 ${related.length.toLocaleString("ko-KR")}건 존재 / 특정 상품 식별 근거 부족`,
  };
}

function hasBusinessDomainEvidence(candidate, match, relatedProducts = []) {
  const text = [candidate?.keyword, ...(candidate?.relatedProducts || []), match?.item?.product,
    ...relatedProducts.map((item) => item?.product)].filter(Boolean).join(" ").toLocaleLowerCase("ko-KR");
  return BUSINESS_DOMAIN_TERMS.some((term) => text.includes(term));
}

function buildDomainRelatedSignal(candidate, match, products) {
  if (!match?.signals || !["beauty", "health"].includes(candidate?.category)) return null;
  const signals = match.signals;
  const evidenceTokens = [...new Set([...(signals.ingredientMatches || []), ...(signals.productLineMatches || []), ...(signals.typeMatches || [])])];
  if (!evidenceTokens.length || (signals.genericOnlyMatch && signals.productTypeMatch && !signals.ingredientMatch && !signals.productLineMatch)) return null;
  const related = products.filter((item) => {
    const value = compact(`${item.brand || ""} ${item.product || ""}`);
    return evidenceTokens.some((token) => value.includes(compact(token)));
  });
  if (!related.length || !hasBusinessDomainEvidence(candidate, match, related)) return null;
  const signalType = signals.ingredientMatch ? "ingredient" : signals.productLineMatch ? "product_line" : "category";
  const label = signalType === "ingredient" ? "성분 관련 급등" : signalType === "product_line" ? "제품/제품라인 관련 급등" : "제품군/카테고리 관련 급등";
  return {
    signalType, relatedBrand: match.item?.brand || "", relatedProductCount: related.length,
    referenceProducts: related.slice(0, 5).map((item) => ({ product: item.product || item.brand || "", brand: item.brand || "", account: item.account || "",
      productId: item.productId || item.id || null, adGroupId: item.adGroupId || null, adId: item.adId || null })),
    judgment: label, reason: `${evidenceTokens.join(" + ")} 관련 활성 상품 ${related.length.toLocaleString("ko-KR")}건 확인 / 특정 상품 단독 식별 근거 부족`,
  };
}

function classifySurgeResult(candidate, match, products, matchThreshold) {
  if (!match || !hasBusinessDomainEvidence(candidate, match)) return { resultType: null, reason: "unrelated_or_insufficient_domain_evidence" };
  const signals = match.signals || {};
  const queryHasDomainTerm = BUSINESS_DOMAIN_TERMS.some((term) => compact(candidate?.keyword).includes(compact(term)));
  const verifiedMarketContext = Boolean(candidate?.marketDiscovery && candidate?.relatedBrand
    && (candidate?.relatedProductType || candidate?.relatedProductLine));
  if (!queryHasDomainTerm && !signals.brandMatch && !signals.ingredientMatch && !verifiedMarketContext) {
    return { resultType: null, reason: "query_has_no_verified_business_context" };
  }
  const productSpecific = Boolean(signals.productNameMatch
    || signals.brandMatch && signals.productLineMatch
    || signals.ingredientMatch && signals.concentrationMatch
    || signals.productLineMatch && signals.specMatch);
  if (match.score >= matchThreshold && productSpecific) return { resultType: "product_match", relatedSignal: null };
  const brandSignal = buildBrandOrCategorySignal(candidate, match, products);
  if (brandSignal && hasBusinessDomainEvidence(candidate, match, brandSignal.referenceProducts)) {
    return { resultType: "brand_or_category_signal", relatedSignal: brandSignal };
  }
  const domainSignal = buildDomainRelatedSignal(candidate, match, products);
  if (domainSignal) return { resultType: "domain_related_signal", relatedSignal: domainSignal };
  return { resultType: null, reason: "insufficient_relation_evidence" };
}

function classifyLowIntensitySignal(candidate, match, products, productIndex, matchThreshold) {
  if (!match || !["beauty", "health"].includes(candidate?.category)) return null;
  const normal = classifySurgeResult(candidate, match, products, matchThreshold);
  if (normal.resultType === "product_match") {
    return { signalType: "strong_product_match", relatedBrand: match.item?.brand || "",
      relatedProductContext: (match.signals?.productLineMatches || match.signals?.typeMatches || []).join(" + "),
      relatedProductCount: Number(match.matchingCandidateCount || 1), referenceProducts: [match.item, ...(match.additionalMatches || []).map((entry) => entry.item)].slice(0, 5),
      judgment: "상품 직접 매칭 선행 신호", reason: `${match.reason} / 절대 급등 기준 미만이나 초기 관심 상승 감지` };
  }
  const context = detectVerifiedBrandProductContext(candidate.keyword, match.item, productIndex);
  if (!context) return null;
  const related = products.filter((item) => {
    const itemBrand = compact(item?.brand) || compact(matchTokens(item?.product)[0] || "");
    return itemBrand === context.brand && compact(item?.product).includes(context.productType);
  });
  if (!related.length) return null;
  const brandLabel = String(match.item?.brand || matchTokens(match.item?.product)[0] || context.brand);
  return { signalType: "brand_product_context", relatedBrand: brandLabel, relatedProductContext: context.productType,
    relatedProductCount: related.length, referenceProducts: related.slice(0, 5),
    judgment: "브랜드 + 제품군 관련 선행 신호",
    reason: `브랜드 ${brandLabel} + 제품군 ${context.productType} 확인 / 절대 급등 기준 미만이나 초기 관심 상승 감지` };
}

function surgePassSignals(metrics, surgeThreshold) {
  const peakDailyLift = Number(metrics?.peakDailyLift ?? metrics?.surgeCount ?? 0);
  const peakBaseline = Number(metrics?.peakDailyBaseline ?? metrics?.baseline ?? 0);
  const peakEstimatedSearches = Number(metrics?.peakDailyEstimated ?? metrics?.latest ?? 0);
  const peakRelativeLiftPct = peakBaseline > 0 ? peakDailyLift / peakBaseline * 100 : null;
  return {
    absoluteSurgePassed: Number(metrics?.surgeCount || 0) >= Number(surgeThreshold || 0),
    relativeTrendPassed: peakRelativeLiftPct !== null
      && peakRelativeLiftPct >= RELATIVE_SURGE_PERCENT
      && peakDailyLift >= RELATIVE_SURGE_MIN_LIFT,
    lowIntensityTrendPassed: peakRelativeLiftPct !== null
      && peakRelativeLiftPct >= LOW_INTENSITY_SURGE_PERCENT
      && peakDailyLift >= LOW_INTENSITY_SURGE_MIN_LIFT,
    peakDailyLift,
    peakRelativeLiftPct,
    peakBaseline,
    peakEstimatedSearches,
    peakDate: metrics?.peakDailyDate || metrics?.latestPeriod || null,
  };
}

function chunks(values, size) { const out = []; for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size)); return out; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function responseJson(response, name) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${name} 호출 실패: HTTP ${response.status} · ${payload.errMsg || payload.errorMessage || payload.message || "응답 오류"}`);
  return payload;
}
async function api(path, { method = "GET", params, body, metrics } = {}) {
  const id = String(process.env.NAVER_CLIENT_ID || "").trim();
  const secret = String(process.env.NAVER_CLIENT_SECRET || "").trim();
  if (!id || !secret) throw new Error("NAVER API HUB 인증정보가 없습니다.");
  const url = new URL(path, API_HUB);
  Object.entries(params || {}).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (metrics?.exhausted) throw new Error(`${path} 호출 중단: NAVER 일일 호출 한도 소진 상태`);
    if (metrics) metrics.calls += 1;
    const response = await fetch(url, { method, headers: {
      "X-NCP-APIGW-API-KEY-ID": id, "X-NCP-APIGW-API-KEY": secret,
      ...(body ? { "Content-Type": "application/json" } : {})
    }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) });
    if (metrics) {
      if (response.status === 200) metrics.http200 += 1;
      else if (response.status === 429) metrics.http429 += 1;
      else metrics.httpOther += 1;
    }
    const retryAfterSeconds = Number(response.headers.get("retry-after") || 0);
    // API HUB supplies Retry-After for recoverable throttling. A bare 429 has
    // consistently represented the exhausted daily budget in Production, so
    // retrying it only burns more calls and cannot make forward progress.
    if (response.status === 429 && retryAfterSeconds <= 0) {
      if (metrics) metrics.exhausted = true;
      return responseJson(response, path);
    }
    if (response.status !== 429 || attempt === 3) {
      if (response.status === 429 && metrics) metrics.exhausted = true;
      return responseJson(response, path);
    }
    if (metrics) metrics.retries += 1;
    await sleep(Math.min(30000, retryAfterSeconds * 1000));
  }
  throw new Error(`${path} 호출 실패: HTTP 429`);
}

function normalize(value) { return String(value || "").toLocaleLowerCase("ko-KR").replace(/[^0-9a-z가-힣]/g, ""); }
function tokens(value) { return String(value || "").toLocaleLowerCase("ko-KR").split(/[^0-9a-z가-힣]+/).filter((item) => item.length >= 2); }
function levenshtein(a, b) {
  const left = normalize(a), right = normalize(b), row = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) { let prev = row[0]; row[0] = i; for (let j = 1; j <= right.length; j += 1) {
    const saved = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (left[i - 1] === right[j - 1] ? 0 : 1)); prev = saved;
  } } return row[right.length];
}
function similarity(a, b) {
  const aa = normalize(a), bb = normalize(b), max = Math.max(aa.length, bb.length); if (!max) return 0;
  const char = (1 - levenshtein(a, b) / max) * 100;
  const left = new Set(tokens(a)), right = new Set(tokens(b)); let intersection = 0;
  left.forEach((item) => { if (right.has(item)) intersection += 1; });
  const union = new Set([...left, ...right]).size;
  return Math.min(100, Math.round(char * .68 + (union ? intersection / union * 100 : 0) * .32 + ((aa.includes(bb) || bb.includes(aa)) ? 12 : 0)));
}
function buildIndex(items) {
  const index = new Map();
  items.forEach((item, position) => {
    for (const token of new Set(tokens(`${item.brand || ""} ${item.product || ""}`))) {
      if (!index.has(token)) index.set(token, []);
      if (index.get(token).length < 500) index.get(token).push(position);
    }
  });
  return index;
}
function bestMatch(keyword, items, index) {
  const positions = new Set();
  for (const token of tokens(keyword)) for (const position of index.get(token) || []) positions.add(position);
  const shortlist = [...positions].slice(0, 200).map((position) => items[position]);
  if (!shortlist.length) return null;
  let best = null;
  for (const item of shortlist) for (const candidate of [item.product, item.brand, `${item.brand || ""} ${item.product || ""}`.trim()].filter(Boolean)) {
    const score = similarity(keyword, candidate); if (!best || score > best.score) best = { item, candidate, score };
  }
  return best;
}
function median(values) { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); if (!sorted.length) return 0; const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; }
function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function estimate(data, monthly, startDate, maxPoints = 30) {
  const raw = (data || []).map((point) => ({ period: point.period, ratio: Number(point.ratio || 0) })).filter((point) => point.period);
  let points = raw;
  if (startDate && raw.length) {
    const ratios = new Map(raw.map((point) => [point.period, point.ratio]));
    const last = raw.map((point) => point.period).sort().at(-1);
    points = [];
    for (let date = new Date(`${startDate}T00:00:00Z`); date <= new Date(`${last}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1)) {
      const period = date.toISOString().slice(0, 10);
      points.push({ period, ratio: Number(ratios.get(period) || 0) });
    }
    if (maxPoints) points = points.slice(-maxPoints);
  }
  const sum = points.reduce((total, point) => total + point.ratio, 0);
  return points.map((point) => ({ ...point, estimated: sum > 0 ? monthly * point.ratio / sum : 0 }));
}
function periodMetrics(series, startDate, endDate) {
  const selected = series.filter((point) => point.period >= startDate && point.period <= endDate);
  const n = selected.length; const window = n <= 3 ? 1 : n <= 7 ? 2 : n <= 14 ? 3 : 7;
  const firstIndex = series.findIndex((point) => point.period === selected[0]?.period);
  const previousSeven = firstIndex >= 0 ? series.slice(Math.max(0, firstIndex - 7), firstIndex).map((point) => point.estimated) : [];
  const baseline = median(previousSeven.length ? previousSeven : selected.slice(0, window).map((point) => point.estimated));
  const recent = average(selected.slice(-window).map((point) => point.estimated));
  let sustainedLift = 0, peakValue = 0;
  for (let i = window; i < n; i += 1) {
    const before = median(selected.slice(Math.max(0, i - window), i).map((point) => point.estimated));
    const after = average(selected.slice(i, Math.min(n, i + window)).map((point) => point.estimated));
    sustainedLift = Math.max(sustainedLift, after - before); peakValue = Math.max(peakValue, after);
  }
  const dailyLifts = selected.map((point) => {
    const index = series.findIndex((item) => item.period === point.period);
    const prior = index >= 0 ? series.slice(Math.max(0, index - 7), index).map((item) => item.estimated) : [];
    const dailyBaseline = median(prior);
    return { period: point.period, estimated: point.estimated, baseline: dailyBaseline, lift: prior.length ? point.estimated - dailyBaseline : 0 };
  });
  const peakDaily = dailyLifts.slice().sort((a, b) => b.lift - a.lift)[0] || { period: null, estimated: 0, baseline: 0, lift: 0 };
  const peakDailyLift = Math.max(0, peakDaily.lift);
  const endLift = recent - baseline;
  return { baseline, latest: recent, peakValue: Math.max(peakValue, ...selected.map((point) => point.estimated), 0),
    surgeCount: Math.max(0, endLift, peakDailyLift), endLift, peakLift: peakDailyLift, peakDailyLift, sustainedLift,
    peakDailyDate: peakDaily.period, peakDailyEstimated: peakDaily.estimated, peakDailyBaseline: peakDaily.baseline,
    dailyLifts, latestPeriod: selected.at(-1)?.period, series: selected };
}
function instantMetrics(series) {
  const latestPoint = series.at(-1); const baselineValues = series.slice(-8, -1).map((point) => point.estimated);
  const baseline = median(baselineValues), latest = Number(latestPoint?.estimated || 0);
  return { baseline, latest, peakValue: latest, surgeCount: Math.max(0, latest - baseline), endLift: latest - baseline, peakLift: latest - baseline, latestPeriod: latestPoint?.period, series: series.slice(-8) };
}
function ratioOnlyMetrics(data, startDate, endDate) {
  const series = (data || []).map((point) => ({ period: point.period, ratio: Number(point.ratio || 0) }))
    .filter((point) => point.period).sort((a, b) => a.period.localeCompare(b.period));
  const selected = series.filter((point) => point.period >= startDate && point.period <= endDate);
  const daily = selected.map((point) => {
    const index = series.findIndex((entry) => entry.period === point.period);
    const prior = index >= 0 ? series.slice(Math.max(0, index - 7), index).map((entry) => entry.ratio) : [];
    const baseline = median(prior);
    return { period: point.period, ratio: point.ratio, baseline, lift: prior.length ? point.ratio - baseline : 0,
      relativeLiftPct: prior.length && baseline > 0 ? (point.ratio - baseline) / baseline * 100 : null };
  });
  const peak = daily.filter((point) => point.relativeLiftPct !== null).sort((a, b) => b.relativeLiftPct - a.relativeLiftPct)[0] || null;
  return { series: selected, daily, peakDate: peak?.period || null, ratioPeak: Number(peak?.ratio || 0), ratioBaseline: Number(peak?.baseline || 0),
    relativeRatioLift: peak?.relativeLiftPct ?? null, latestRatio: Number(selected.at(-1)?.ratio || 0) };
}
function slope(values) { if (values.length < 2) return 0; const n = values.length, sx = n * (n - 1) / 2, sy = values.reduce((a, b) => a + b, 0); let sxy = 0, sx2 = 0; values.forEach((y, x) => { sxy += x * y; sx2 += x * x; }); return (n * sxy - sx * sy) / Math.max(1, n * sx2 - sx * sx); }
function summaryStats(items) {
  const monthly = items.map((item) => Number(item.monthlyTotalSearches || 0));
  const impressions = items.map((item) => Number(item.impressions30d || 0));
  return {
    count: items.length,
    averageMonthlySearches: Math.round(average(monthly)), medianMonthlySearches: Math.round(median(monthly)),
    averageSearchAdImpressions: Math.round(average(impressions)), medianSearchAdImpressions: Math.round(median(impressions)),
    newSearchAdQueryRate: items.length ? items.filter((item) => item.isNewSearchQuery).length / items.length : 0,
    recent14DayQueryRate: items.length ? items.filter((item) => isRecentCandidate(item)).length / items.length : 0,
    beautyRate: items.length ? items.filter((item) => item.category === "beauty").length / items.length : 0,
    healthRate: items.length ? items.filter((item) => item.category === "health").length / items.length : 0,
    actualSearchAdQueryRate: items.length ? items.filter((item) => item.sources.includes("searchad-query")).length / items.length : 0,
    keywordToolRate: items.length ? items.filter((item) => item.sources.includes("keywordstool")).length / items.length : 0
  };
}
function candidateDiagnostic(item) {
  return { keyword: item.keyword, monthlyPcSearches: item.monthlyPcSearches, monthlyMobileSearches: item.monthlyMobileSearches,
    monthlyTotalSearches: item.monthlyTotalSearches, searchAdImpressions30d: Number(item.impressions30d || 0),
    searchAdClicks30d: Number(item.clicks30d || 0), actualSearchAdQuery: item.sources.includes("searchad-query"),
    newSearchAdQuery: Boolean(item.isNewSearchQuery), category: item.category, categoryEvidence: item.categoryEvidence,
    monthlyVolumeStatus: item.monthlyVolumeStatus, priorityScore: item.priorityScore };
}
function surgeDiagnostic(item, metrics, series) {
  return { ...candidateDiagnostic(item), ratioSum: series.reduce((sum, point) => sum + Number(point.ratio || 0), 0),
    baseline: metrics.baseline, latest: metrics.latest, estimatedBaselineSearch: metrics.baseline,
    estimatedLatestSearch: metrics.latest, estimatedSurgeCount: metrics.surgeCount,
    latestDataDate: metrics.latestPeriod, endLift: metrics.endLift, peakLift: metrics.peakLift,
    nonZeroRatioDays: series.filter((point) => Number(point.ratio || 0) > 0).length,
    ratios: series.map((point) => ({ period: point.period, ratio: point.ratio, estimated: point.estimated })) };
}
function analysisPriority(item, priorSignal) {
  return Number(item.priorityScore || 0) + Math.log10(Number(priorSignal?.estimatedSurgeCount || 0) + 1) * 6;
}
function domainEvidenceScore(item) {
  const evidence = String(item.categoryEvidence || "");
  return evidence === "keyword" ? 3 : evidence === "adgroup-product" ? 2 : evidence === "keywordstool-seed" ? 1 : 0;
}
function isRecentCandidate(item, now = Date.now()) {
  const firstSeen = Date.parse(item.firstSeenAt || "");
  return Number.isFinite(firstSeen) && now - firstSeen <= 14 * 86400000;
}
function selectAnalysisCandidates(candidates, priorSignals, limit = MAX_ACTIVE_CANDIDATES) {
  const selected = []; const selectedKeys = new Set();
  const addGroup = (quota, predicate, compare) => {
    let added = 0;
    for (const item of candidates.filter(predicate).sort(compare)) {
      if (added >= quota || selected.length >= limit) break;
      const key = item.keyword.toLocaleLowerCase("ko-KR");
      if (selectedKeys.has(key)) continue;
      selected.push(item); selectedKeys.add(key); added += 1;
    }
    return added;
  };
  const scoreSort = (a, b) => analysisPriority(b, priorSignals.get(b.keyword)) - analysisPriority(a, priorSignals.get(a.keyword))
    || Number(b.monthlyTotalSearches || 0) - Number(a.monthlyTotalSearches || 0);
  const highVolumeKeys = new Set(candidates.slice().sort((a, b) => Number(b.monthlyTotalSearches || 0) - Number(a.monthlyTotalSearches || 0))
    .slice(0, CANDIDATE_GROUP_QUOTAS.highVolume).map((item) => item.keyword.toLocaleLowerCase("ko-KR")));
  const groupCounts = {
    new: addGroup(CANDIDATE_GROUP_QUOTAS.new, (item) => isRecentCandidate(item),
      (a, b) => Number(b.monthlyTotalSearches || 0) - Number(a.monthlyTotalSearches || 0)
        || Number(b.impressionDelta || 0) - Number(a.impressionDelta || 0) || scoreSort(a, b)),
    highVolume: addGroup(CANDIDATE_GROUP_QUOTAS.highVolume, () => true,
      (a, b) => Number(b.monthlyTotalSearches || 0) - Number(a.monthlyTotalSearches || 0) || scoreSort(a, b)),
    recentChange: addGroup(CANDIDATE_GROUP_QUOTAS.recentChange,
      (item) => Number(item.impressionDelta || 0) > 0 || Number(item.clicks30d || 0) > 0,
      (a, b) => Number(b.impressionDelta || 0) - Number(a.impressionDelta || 0)
        || Number(b.clicks30d || 0) - Number(a.clicks30d || 0) || scoreSort(a, b)),
    priorSurge: addGroup(CANDIDATE_GROUP_QUOTAS.priorSurge,
      (item) => Number(priorSignals.get(item.keyword)?.protectionPriority || 0) > 0 || Number(priorSignals.get(item.keyword)?.estimatedSurgeCount || 0) > 0,
      (a, b) => Number(priorSignals.get(b.keyword)?.protectionPriority || 0) - Number(priorSignals.get(a.keyword)?.protectionPriority || 0)
        || Number(priorSignals.get(b.keyword)?.estimatedSurgeCount || 0) - Number(priorSignals.get(a.keyword)?.estimatedSurgeCount || 0) || scoreSort(a, b)),
    domainEvidence: addGroup(CANDIDATE_GROUP_QUOTAS.domainEvidence, (item) => domainEvidenceScore(item) > 0,
      (a, b) => domainEvidenceScore(b) - domainEvidenceScore(a)
        || Number(b.monthlyTotalSearches || 0) - Number(a.monthlyTotalSearches || 0) || scoreSort(a, b))
  };
  let compositeFill = 0;
  for (const item of candidates.slice().sort(scoreSort)) {
    if (selected.length >= limit) break;
    const key = item.keyword.toLocaleLowerCase("ko-KR");
    if (selectedKeys.has(key)) continue;
    selected.push(item); selectedKeys.add(key); compositeFill += 1;
  }
  const qualifyingGroupCount = (item) => Number(isRecentCandidate(item))
    + Number(highVolumeKeys.has(item.keyword.toLocaleLowerCase("ko-KR")))
    + Number(Number(item.impressionDelta || 0) > 0 || Number(item.clicks30d || 0) > 0)
    + Number(Number(priorSignals.get(item.keyword)?.estimatedSurgeCount || 0) > 0) + Number(domainEvidenceScore(item) > 0);
  return { selected, excluded: candidates.filter((item) => !selectedKeys.has(item.keyword.toLocaleLowerCase("ko-KR"))),
    diagnostics: { quotas: CANDIDATE_GROUP_QUOTAS, selectedByGroup: { ...groupCounts, compositeFill },
      multiGroupOverlap: selected.filter((item) => qualifyingGroupCount(item) > 1).length } };
}

function marketCandidateForAnalysis(item) {
  const type = String(item.relatedProductType || "");
  const health = ["유산균", "비타민", "영양제", "프로틴", "단백질", "콜라겐", "오메가3"].some((value) => type.includes(value));
  return { keyword: item.keyword, category: item.category || (health ? "health" : "beauty"), categoryEvidence: "market-discovery",
    sources: [...new Set([...(item.discoverySource || []), "market-discovery"])], firstSeenAt: item.discoveredAt, lastSeenAt: item.lastSeenAt,
    isNewSearchQuery: item.discoverySource?.includes("searchad-new-query"), impressions30d: Number(item.searchAdEvidence?.recentImpressions || 0),
    clicks30d: Number(item.searchAdEvidence?.recentClicks || 0), impressionDelta: Number(item.searchAdEvidence?.recentImpressions || 0),
    confidenceImpressionDelta: Number.isFinite(Number(item.searchAdEvidence?.previousImpressions))
      ? Number(item.searchAdEvidence?.recentImpressions || 0) - Number(item.searchAdEvidence.previousImpressions) : 0,
    monthlyPcSearches: item.monthlyPcSearches ?? null, monthlyMobileSearches: item.monthlyMobileSearches ?? null,
    monthlyTotalSearches: item.monthlyTotalSearches ?? null, monthlyVolumeStatus: item.monthlySearchStatus || "not-requested",
    priorityScore: discoveryPriority(item), marketDiscovery: true, marketEvidence: item.evidence || [], sourceConfidence: item.sourceConfidence,
    relatedBrand: item.relatedBrand || "", relatedProductType: item.relatedProductType || "", relatedProductLine: item.relatedProductLine || "",
    todayEarlySignalScore: Number(item.todayEarlySignalScore || 0) };
}

function trendFetchPriority(candidate, priorSignals) {
  const sources = candidate?.sources || [];
  const discoveredAt = Date.parse(candidate?.firstSeenAt || 0); const ageDays = Number.isFinite(discoveredAt) ? Math.max(0, (Date.now() - discoveredAt) / 86400000) : 9999;
  const tier = candidateTier(candidate, priorSignals?.get(candidate?.keyword));
  return Number(Boolean(candidate?.marketDiscovery)) * 8000000
    + Number(candidate?.todayEarlySignalScore || 0) * 100000
    + Number(sources.includes("youtube")) * 4000000
    + Number(Boolean(candidate?.isNewSearchQuery || sources.includes("searchad-new-query"))) * 2000000
    + Number(new Set(sources.filter((source) => source !== "market-discovery")).size > 1) * 1000000
    + Number(Number(priorSignals?.get(candidate?.keyword)?.estimatedSurgeCount || 0) > 0) * 500000
    + Number(Boolean(candidate?.relatedBrand && (candidate?.relatedProductType || candidate?.relatedProductLine))) * 250000
    + Math.max(0, 10000 - Math.round(ageDays * 100))
    + priorityWeight(tier) + Number(candidate?.priorityScore || 0);
}

function planTrendFetch(fetchQueue, quotaStatus, groupSize = 5) {
  const callBudget = quotaStatus?.exhausted ? 0
    : Math.max(0, Math.min(Number(quotaStatus?.remaining || 0), Number(quotaStatus?.dailyRemaining || 0)));
  const selected = fetchQueue.slice(0, callBudget * groupSize);
  return { selected, pending: fetchQueue.slice(selected.length), callBudget, expectedCalls: Math.ceil(selected.length / groupSize) };
}

function selectWithMarketDiscovery(baseCandidates, marketItems, priorSignals, limit = MAX_ACTIVE_CANDIDATES, marketLimit = 500) {
  const marketPool = (marketItems || []).map(marketCandidateForAnalysis);
  const numericMarket = marketPool.filter((item) => item.monthlyVolumeStatus === "available" && Number(item.monthlyTotalSearches || 0) >= LOW_INTENSITY_SURGE_MIN_LIFT)
    .sort((a, b) => Number(b.priorityScore || 0) - Number(a.priorityScore || 0));
  const ratioOnly = marketPool.filter((item) => item.monthlyVolumeStatus === "keywordtool-unavailable" && Number(item.sourceConfidence || 0) >= 75
    && (item.sources.length > 2 || item.sources.includes("searchad-new-query") || item.relatedBrand && (item.relatedProductType || item.relatedProductLine)))
    .sort((a, b) => Number(b.priorityScore || 0) - Number(a.priorityScore || 0));
  const marketSelected = []; const keys = new Set();
  const add = (items, cap) => {
    let added = 0;
    for (const item of items) {
      if (marketSelected.length >= marketLimit || added >= cap) break;
      const key = normalizeKeyword(item.keyword); if (keys.has(key)) continue;
      keys.add(key); marketSelected.push(item); added += 1;
    }
  };
  // Keep a bounded lane for high-confidence ratio-only market signals. Any unused
  // capacity is immediately returned to numeric market candidates (and then base).
  const ratioOnlyReserve = Math.min(ratioOnly.length, Math.floor(marketLimit * 0.3));
  add(numericMarket, marketLimit - ratioOnlyReserve);
  add(ratioOnly, ratioOnlyReserve);
  add([...numericMarket, ...ratioOnly], marketLimit - marketSelected.length);
  const numericKeys = new Set(numericMarket.map((item) => normalizeKeyword(item.keyword)));
  const selectedNumericMarket = marketSelected.filter((item) => numericKeys.has(normalizeKeyword(item.keyword)));
  const selectedRatioOnly = marketSelected.filter((item) => !numericKeys.has(normalizeKeyword(item.keyword)));
  const base = baseCandidates.filter((item) => !keys.has(normalizeKeyword(item.keyword)));
  const baseSelection = selectAnalysisCandidates(base, priorSignals, Math.max(0, limit - marketSelected.length));
  return { selected: [...selectedNumericMarket, ...baseSelection.selected], ratioOnly: selectedRatioOnly,
    excluded: [...baseSelection.excluded, ...numericMarket.filter((item) => !keys.has(normalizeKeyword(item.keyword)))],
    diagnostics: { marketLimit, marketSelected: marketSelected.length, marketNumeric: selectedNumericMarket.length,
      marketRatioOnly: selectedRatioOnly.length, existingSelected: baseSelection.selected.length, total: marketSelected.length + baseSelection.selected.length,
      existingSelection: baseSelection.diagnostics } };
}

exports.handler = async (event) => {
  connect(event); connectTrendCache(event); connectQuota(event); connectSnapshot(event); schedulerExecutions.connect(event);
  let input; try { input = JSON.parse(event.body || "{}"); } catch { return; }
  let job = await readJob(input.jobId) || input.job;
  if (!job?.jobId || job.state !== "running") return;
  const persist = async (patch) => { job = { ...job, ...patch, updatedAt: new Date().toISOString() }; await writeJob(job.jobId, job); };
  const started = Date.now();
  let seriesCache = null; const dirtyTrendKeys = new Set();
  let cacheStats = null;
  const apiMetrics = {
    searchTrend: { calls: 0, retries: 0, keywords: 0, exhausted: false, http200: 0, http429: 0, httpOther: 0 },
    shoppingInsight: { calls: 0, retries: 0, keywords: 0, exhausted: false, http200: 0, http429: 0, httpOther: 0 }
  };
  let trendCollectedAt = null;
  let budgetMode = "normal";
  let quotaUsageRecorded = false;
  const recordObservedUsage = async () => {
    if (quotaUsageRecorded) return; quotaUsageRecorded = true;
    // Both API families are persisted in one Blob write. Netlify Blob reads are
    // eventually consistent, so separate read-modify-write calls could otherwise
    // overwrite the first family's counters with the second family's stale read.
    await recordQuotaUsageBatch(apiMetrics).catch(() => null);
  };
  try {
    const [candidateCache, marketCache, productCache, priorSignalCache, surgeHistoryCache, loadedSeriesCache, quotaUsage, loadedEarlyCache] = await Promise.all([
      readCandidateCache(), readMarketDiscoveryCache().catch(() => null), readProductCache(), analysisStore().get("signals/current", { type: "json" }).catch(() => null), readSurgeHistory(),
      readTrendSeriesCache(), readQuotaUsage(), earlySignals.readCache().catch(() => null)
    ]);
    seriesCache = loadedSeriesCache;
    const priorSignals = new Map((priorSignalCache?.items || []).map((item) => [item.keyword, item]));
    const allCandidates = candidateCache.candidates;
    for (const candidate of allCandidates) {
      const historyRecord = surgeHistoryCache.records.get(normalizeKeyword(candidate.keyword));
      const historySignal = historyProtectionSignal(historyRecord, job.surgeThreshold);
      if (historySignal) priorSignals.set(candidate.keyword, historySignal);
    }
    const relevantCandidates = allCandidates.filter((item) => item.category === "beauty" || item.category === "health");
    const unknownCandidates = allCandidates.filter((item) => item.category === "unknown");
    const monthlyPresent = allCandidates.filter((item) => item.monthlyTotalSearches !== null && item.monthlyTotalSearches !== undefined && Number.isFinite(Number(item.monthlyTotalSearches)));
    const eligibleBeforeLimit = relevantCandidates.filter((item) => Number(item.monthlyTotalSearches || 0) >= job.surgeThreshold);
    const selection = selectWithMarketDiscovery(eligibleBeforeLimit, marketCache?.items || [], priorSignals);
    const eligible = selection.selected;
    const ratioOnlyCandidates = selection.ratioOnly;
    const excludedByLimit = selection.excluded;
    if (!eligible.length) throw new Error("급등수 기준을 계산할 수 있는 월간 검색량 후보가 없습니다.");
    const cutDiagnostic = {
      included: summaryStats(eligible), excluded: summaryStats(excludedByLimit), selectionGroups: selection.diagnostics,
      excludedTopMonthly100: excludedByLimit.slice().sort((a, b) => Number(b.monthlyTotalSearches || 0) - Number(a.monthlyTotalSearches || 0)).slice(0, 100).map(candidateDiagnostic),
      excludedTopNewQueries100: excludedByLimit.filter((item) => item.sources.includes("searchad-query"))
        .sort((a, b) => Number(b.impressions30d || 0) - Number(a.impressions30d || 0)).slice(0, 100).map(candidateDiagnostic)
    };
    const funnel = {
      candidates: { totalCache: allCandidates.length, beauty: allCandidates.filter((item) => item.category === "beauty").length,
        health: allCandidates.filter((item) => item.category === "health").length, unknown: unknownCandidates.length,
        nonDomainExcluded: unknownCandidates.length, monthlyVolumePresent: monthlyPresent.length,
        monthlyVolumeMissing: allCandidates.length - monthlyPresent.length,
        monthlyVolumeAvailable: allCandidates.filter((item) => item.monthlyVolumeStatus === "available").length,
        monthlyVolumeUnavailable: allCandidates.filter((item) => item.monthlyVolumeStatus === "keywordtool-unavailable").length,
        monthlyVolumeNotRequested: allCandidates.filter((item) => item.monthlyVolumeStatus === "not-requested").length,
        monthlyVolumeRequestFailed: allCandidates.filter((item) => item.monthlyVolumeStatus === "request-failed").length,
        monthlyAtOrAboveThreshold: eligibleBeforeLimit.length,
        before5000Limit: eligibleBeforeLimit.length + Number(selection.diagnostics.marketSelected || 0), analyzed: eligible.length + ratioOnlyCandidates.length, excludedBy5000Limit: excludedByLimit.length,
        marketDiscoveryCache: marketCache?.items?.length || 0, marketDiscoverySelected: selection.diagnostics.marketSelected || 0,
        marketDiscoveryNumeric: selection.diagnostics.marketNumeric || 0, ratioOnlySelected: ratioOnlyCandidates.length },
      searchTrend: { requested: eligible.length + ratioOnlyCandidates.length, validSeries: 0, emptySeries: 0, apiErrorCandidates: 0 },
      surge: { positive: 0, from0To99: 0, from100To199: 0, from200To299: 0, from300To499: 0, from500To999: 0, atLeast1000: 0,
        atLeast100: 0, atLeast500: 0, atLeast5000: 0, atLeast10000: 0, atUserThreshold: 0 },
      matching: { atLeast30: 0, atLeast40: 0, atLeast50: 0, atLeast60: 0, atLeast70: 0, atLeast80: 0, atLeast90: 0, atUserThreshold: 0 },
      resultClassification: { productMatch: 0, brandSignal: 0, domainRelatedSignal: 0, unrelatedOrInsufficient: 0 },
      relativeSurge: { trendEligible: 0, passedWithDomainEvidence: 0, relativeOnlyAdded: 0,
        productMatch: 0, brandSignal: 0, domainRelatedSignal: 0, insufficientDomainEvidence: 0 },
      lowIntensity: { numericEligible: 0, included: 0, strongProductMatch: 0, brandProductContext: 0, insufficientRelationEvidence: 0 }
    };
    const trendCandidates = [...eligible, ...ratioOnlyCandidates];
    const ratioOnlyKeys = new Set(ratioOnlyCandidates.map((item) => normalizeKeyword(item.keyword)));
    const analysisTrace = new Map(trendCandidates.map((candidate) => [normalizeKeyword(candidate.keyword), {
      keyword: candidate.keyword, normalizedKeyword: normalizeKeyword(candidate.keyword), selectedForAnalysis: true,
      selectedForProtectedSlot: Boolean(candidate.marketDiscovery), selectionType: ratioOnlyKeys.has(normalizeKeyword(candidate.keyword)) ? "ratio-only" : "monthly-search",
      monthlySearchStatus: candidate.monthlyVolumeStatus, monthlyTotalSearches: candidate.monthlyTotalSearches,
      searchTrendRequested: true, searchTrendStatus: "pending", marketDiscovery: Boolean(candidate.marketDiscovery)
    }]));
    const trendMap = new Map(); const shoppingMap = new Map();
    cacheStats = { searchTrend: { hits: 0, misses: 0, stale: 0, windowUnavailable: 0, freshFetchCandidates: 0, apiCalls: 0, retries: 0 },
      shoppingInsight: { hits: 0, misses: 0, stale: 0, freshFetchCandidates: 0, apiCalls: 0, retries: 0 } };
    const searchFetchQueue = []; const tierCounts = { hot: 0, warm: 0, cold: 0 };
    const tierPendingCounts = { hot: 0, warm: 0, cold: 0 };
    for (const candidate of trendCandidates) {
      const cached = lookupTrendSeries(seriesCache.entries, candidate.keyword, "search", candidate.category, job.queryStartDate, job.endDate);
      const tierState = isDueForCollection(candidate, priorSignals.get(candidate.keyword), cached.record);
      candidate.candidateTier = tierState.tier; tierCounts[tierState.tier] += 1;
      const coveredCachedSeries = cached.record?.requestStartDate <= job.queryStartDate && cached.record?.requestEndDate >= job.endDate
        ? (cached.record.rawRatioSeries || []).filter((point) => point.period >= job.queryStartDate && point.period <= job.endDate) : null;
      if (cached.state === "hit" || (coveredCachedSeries && (job.fastPath || !tierState.due))) {
        cacheStats.searchTrend.hits += 1; trendMap.set(candidate.keyword, cached.state === "hit" ? cached.series : coveredCachedSeries);
        const trace = analysisTrace.get(normalizeKeyword(candidate.keyword));
        if (trace) Object.assign(trace, { cacheHit: true, trendFetchedAt: cached.record.fetchedAt,
          dataFreshness: cached.state === "hit" ? "cache-current" : "tier-cache-reuse", candidateTier: tierState.tier });
      } else {
        if (cached.state === "window-unavailable") {
          cacheStats.searchTrend.windowUnavailable += 1;
          const trace = analysisTrace.get(normalizeKeyword(candidate.keyword));
          if (trace) Object.assign(trace, { trendWaitReason: "cache_window_unavailable", exclusionReason: "요청 기간을 충족하는 Trend 캐시 window 없음" });
        } else cacheStats.searchTrend[cached.state === "stale" ? "stale" : "misses"] += 1;
        searchFetchQueue.push(candidate); tierPendingCounts[tierState.tier] += 1;
      }
    }
    searchFetchQueue.sort((a, b) => trendFetchPriority(b, priorSignals) - trendFetchPriority(a, priorSignals));
    const shoppingFetchByCategory = new Map([["beauty", []], ["health", []]]);
    for (const candidate of eligible) {
      const cached = lookupTrendSeries(seriesCache.entries, candidate.keyword, "shopping", candidate.category, job.queryStartDate, job.endDate);
      if (cached.state === "hit") { cacheStats.shoppingInsight.hits += 1; shoppingMap.set(candidate.keyword, cached.series); }
      else { cacheStats.shoppingInsight[cached.state === "stale" ? "stale" : "misses"] += 1; shoppingFetchByCategory.get(candidate.category).push(candidate); }
    }
    for (const values of shoppingFetchByCategory.values()) values.sort((a, b) => trendFetchPriority(b, priorSignals) - trendFetchPriority(a, priorSignals));
    const initialCoveragePct = trendCandidates.length ? cacheStats.searchTrend.hits / trendCandidates.length * 100 : 100;
    budgetMode = !job.fastPath && initialCoveragePct < 90 ? "bootstrap" : "normal";
    const searchQuota = quotaStatusFor(quotaUsage, "searchTrend", 0, new Date(), { bootstrap: budgetMode === "bootstrap" });
    const searchPlan = job.fastPath ? { selected: [], pending: searchFetchQueue, callBudget: 0, expectedCalls: 0 }
      : planTrendFetch(searchFetchQueue, searchQuota);
    const pendingTrendKeys = new Set(searchPlan.pending.map((candidate) => normalizeKeyword(candidate.keyword)));
    let quotaStopped = searchQuota.exhausted;
    let eligibleShoppingFetch = new Map([["beauty", []], ["health", []]]);
    let expectedShoppingCalls = 0;
    let shoppingQuota = quotaStatusFor(quotaUsage, "shoppingInsight", 0);
    funnel.trendCache = { searchTrend: { ...cacheStats.searchTrend, requestedMisses: searchFetchQueue.length,
      scheduledFetchCandidates: searchPlan.selected.length, pendingCandidates: searchPlan.pending.length, expectedApiCalls: searchPlan.expectedCalls },
      shoppingInsight: { ...cacheStats.shoppingInsight, expectedApiCalls: expectedShoppingCalls }, quota: { searchTrend: searchQuota, shoppingInsight: shoppingQuota },
      candidateTiers: tierCounts, tierPending: tierPendingCounts, executionPath: job.fastPath ? "fast" : "slow",
      budgetMode, initialCoveragePct: Math.round(initialCoveragePct * 100) / 100 };
    for (const candidate of searchPlan.pending) {
      const trace = analysisTrace.get(normalizeKeyword(candidate.keyword));
      if (trace) {
        const trendWaitReason = trace.trendWaitReason || (job.fastPath ? "fast_path_cache_wait"
          : searchQuota.exhausted ? "provider_quota_wait" : "internal_budget_wait");
        const exclusionReason = trendWaitReason === "cache_window_unavailable" ? "요청 기간을 충족하는 Trend 캐시 window 없음"
          : trendWaitReason === "provider_quota_wait" ? "NAVER API 429/공식 quota 제한 대기"
            : trendWaitReason === "internal_budget_wait" ? "내부 일일 Trend budget 소진 대기" : "Fast Path Trend 캐시 대기";
        Object.assign(trace, { searchTrendStatus: "pending-cache", trendWaitReason, exclusionReason });
      }
    }
    await persist({ message: `검색어트렌드 캐시 ${cacheStats.searchTrend.hits.toLocaleString("ko-KR")}건 재사용 · 신규 ${searchFetchQueue.length.toLocaleString("ko-KR")}건`, totalCandidates: trendCandidates.length, progress: 5,
      currentStage: "search-trend", processedCount: 0, totalCount: trendCandidates.length,
      diagnostic: { funnel, candidateCut: cutDiagnostic, surgeTop30: [], matchTop30: [], calculationSamples: [] } });
    let processed = cacheStats.searchTrend.hits;
    searchFetchLoop: for (const requestBatch of chunks(chunks(searchPlan.selected, 5), 5)) {
      const settled = await Promise.allSettled(requestBatch.map((batch) => api("/search-trend/v1/search", { method: "POST", body: {
          startDate: job.queryStartDate, endDate: job.endDate, timeUnit: "date",
          keywordGroups: batch.map((item) => ({ groupName: item.keyword, keywords: [item.keyword] }))
        }, metrics: apiMetrics.searchTrend })));
      const fetchedAt = new Date().toISOString();
      for (let responseIndex = 0; responseIndex < settled.length; responseIndex += 1) {
        if (settled[responseIndex].status === "rejected") {
          const failedBatch = requestBatch[responseIndex]; funnel.searchTrend.apiErrorCandidates += failedBatch.length;
          for (const candidate of failedBatch) pendingTrendKeys.add(normalizeKeyword(candidate.keyword));
          quotaStopped = quotaStopped || apiMetrics.searchTrend.exhausted;
          continue;
        }
        const returned = new Map((settled[responseIndex].value.results || []).map((result) => [normalizeKeyword(result.title), result.data || []]));
        for (const candidate of requestBatch[responseIndex]) {
          const series = returned.get(normalizeKeyword(candidate.keyword)) || [];
          trendMap.set(candidate.keyword, series); dirtyTrendKeys.add(upsertTrendSeries(seriesCache.entries, { keyword: candidate.keyword,
            source: "search", startDate: job.queryStartDate, endDate: job.endDate, series, fetchedAt }));
          apiMetrics.searchTrend.keywords += 1;
          trendCollectedAt = fetchedAt;
          const trace = analysisTrace.get(normalizeKeyword(candidate.keyword));
          if (trace) Object.assign(trace, { cacheHit: false, trendFetchedAt: fetchedAt, dataFreshness: "fresh-fetch" });
        }
      }
      processed = trendMap.size;
      if (dirtyTrendKeys.size) { await writeDirtyTrendSeries(seriesCache, dirtyTrendKeys); dirtyTrendKeys.clear(); }
      job.currentStage = "search-trend"; job.processedCount = processed; job.totalCount = trendCandidates.length;
      await persist({ message: `검색어트렌드 조회 중 · ${processed.toLocaleString("ko-KR")} / ${trendCandidates.length.toLocaleString("ko-KR")}`, progress: 5 + Math.round(processed / trendCandidates.length * 35) });
      if (quotaStopped) {
        for (const remaining of searchPlan.selected) if (!trendMap.has(remaining.keyword)) pendingTrendKeys.add(normalizeKeyword(remaining.keyword));
        break searchFetchLoop;
      }
      await sleep(TREND_BATCH_DELAY_MS);
    }
    const shoppingMissesWithTrend = [...shoppingFetchByCategory.values()].flat().filter((candidate) => trendMap.has(candidate.keyword))
      .sort((a, b) => trendFetchPriority(b, priorSignals) - trendFetchPriority(a, priorSignals));
    shoppingQuota = quotaStatusFor(quotaUsage, "shoppingInsight", 0);
    // Shopping Insight is intentionally deferred until Search Trend, surge and
    // business relevance have produced a small meaningful result set.
    const shoppingPlan = { selected: [], pending: shoppingMissesWithTrend, expectedCalls: 0 };
    eligibleShoppingFetch = new Map([["beauty", []], ["health", []]]);
    expectedShoppingCalls = 0;
    funnel.trendCache.shoppingInsight.expectedApiCalls = expectedShoppingCalls;
    funnel.trendCache.shoppingInsight.pendingCandidates = shoppingPlan.pending.length;
    funnel.trendCache.quota.shoppingInsight = { ...shoppingQuota, expectedCalls: expectedShoppingCalls };
    await persist({ message: job.fastPath ? "저장된 Trend 캐시로 분석 중" : "Trend 신호 계산 준비", progress: 42 });
    cacheStats.searchTrend.freshFetchCandidates = [...analysisTrace.values()].filter((trace) => trace.dataFreshness === "fresh-fetch").length;
    cacheStats.searchTrend.pendingCandidates = pendingTrendKeys.size; cacheStats.searchTrend.apiCalls = apiMetrics.searchTrend.calls; cacheStats.searchTrend.retries = apiMetrics.searchTrend.retries;
    cacheStats.shoppingInsight.freshFetchCandidates = [...eligibleShoppingFetch.values()].reduce((sum, values) => sum + values.length, 0);
    cacheStats.shoppingInsight.apiCalls = apiMetrics.shoppingInsight.calls; cacheStats.shoppingInsight.retries = apiMetrics.shoppingInsight.retries;
    funnel.trendCache.searchTrend = { ...funnel.trendCache.searchTrend, ...cacheStats.searchTrend };
    funnel.trendCache.shoppingInsight = { ...funnel.trendCache.shoppingInsight, ...cacheStats.shoppingInsight };
    const trendAvailableCount = trendMap.size;
    const pendingTrendCacheCount = Math.max(0, trendCandidates.length - trendAvailableCount);
    const trendCoveragePct = trendCandidates.length ? Math.round(trendAvailableCount / trendCandidates.length * 10000) / 100 : 0;
    const partialAnalysis = pendingTrendCacheCount > 0;
    for (const trace of analysisTrace.values()) if (!trendMap.has(trace.keyword)) {
      trace.searchTrendStatus = "pending-cache";
      if (quotaStopped || apiMetrics.searchTrend.exhausted || searchQuota.exhausted) trace.trendWaitReason = "provider_quota_wait";
      else if (!trace.trendWaitReason) trace.trendWaitReason = job.fastPath ? "fast_path_cache_wait" : "internal_budget_wait";
      trace.exclusionReason = trace.trendWaitReason === "cache_window_unavailable" ? "요청 기간을 충족하는 Trend 캐시 window 없음"
        : trace.trendWaitReason === "provider_quota_wait" ? "NAVER API 429/공식 quota 제한 대기"
          : trace.trendWaitReason === "internal_budget_wait" ? "내부 일일 Trend budget 소진 대기" : "Fast Path Trend 캐시 대기";
    }
    await persist({ message: "추정 급등수 계산 및 상품 매칭 중", progress: 75 });
    job.currentStage = "calculation-matching"; job.processedCount = 0; job.totalCount = eligible.length;
    const productIndex = buildProductIndex(productCache.items);
    const rows = []; const calculated = []; const matchedDiagnostics = []; const boundaryRelated = [];
    let calculationProcessed = 0;
    for (const candidate of eligible) {
      calculationProcessed += 1;
      if (calculationProcessed % 500 === 0) {
        await persist({
          currentStage: "calculation-matching",
          processedCount: calculationProcessed,
          totalCount: eligible.length,
          progress: 75 + Math.round((calculationProcessed / Math.max(1, eligible.length)) * 14),
        });
      }
      const trendData = trendMap.get(candidate.keyword);
      const trace = analysisTrace.get(normalizeKeyword(candidate.keyword));
      if (trace?.searchTrendStatus === "pending-cache") continue;
      if (!Array.isArray(trendData) || !trendData.length) { funnel.searchTrend.emptySeries += 1; if (trace) trace.searchTrendStatus = "empty"; continue; }
      funnel.searchTrend.validSeries += 1;
      if (trace) trace.searchTrendStatus = "valid";
      const queryDays = Math.round((Date.parse(`${job.endDate}T00:00:00Z`) - Date.parse(`${job.queryStartDate}T00:00:00Z`)) / 86400000) + 1;
      const series = estimate(
        trendData,
        Number(candidate.monthlyTotalSearches),
        job.queryStartDate,
        queryDays <= 31 ? 30 : queryDays,
      );
      if (!series.length) { funnel.searchTrend.emptySeries += 1; funnel.searchTrend.validSeries -= 1; continue; }
      const metrics = job.mode === "instant" ? instantMetrics(series) : periodMetrics(series, job.startDate, job.endDate);
      const surgeSignals = surgePassSignals(metrics, job.surgeThreshold);
      if (trace) Object.assign(trace, { latestDataDate: metrics.latestPeriod, estimatedSurgeCount: Math.round(metrics.surgeCount),
        peakDailyLift: Math.round(metrics.peakDailyLift || metrics.peakLift), peakRelativeLiftPct: metrics.peakRelativeLiftPct,
        peakBaseline: metrics.peakBaseline, peakEstimatedSearches: metrics.peakEstimatedSearches, peakDate: metrics.peakDailyDate,
        absoluteSurgePassed: surgeSignals.absoluteSurgePassed, relativeSurgePassed: surgeSignals.relativeTrendPassed,
        lowIntensityTrendPassed: surgeSignals.lowIntensityTrendPassed });
      const diagnosticRow = surgeDiagnostic(candidate, metrics, series);
      calculated.push({ candidate, metrics, diagnosticRow });
      if (metrics.surgeCount > 0) funnel.surge.positive += 1;
      if (metrics.surgeCount >= 0 && metrics.surgeCount < 100) funnel.surge.from0To99 += 1;
      if (metrics.surgeCount >= 100 && metrics.surgeCount < 200) funnel.surge.from100To199 += 1;
      if (metrics.surgeCount >= 200 && metrics.surgeCount < 300) funnel.surge.from200To299 += 1;
      if (metrics.surgeCount >= 300 && metrics.surgeCount < 500) funnel.surge.from300To499 += 1;
      if (metrics.surgeCount >= 500 && metrics.surgeCount < 1000) funnel.surge.from500To999 += 1;
      if (metrics.surgeCount >= 100) funnel.surge.atLeast100 += 1;
      if (metrics.surgeCount >= 500) funnel.surge.atLeast500 += 1;
      if (metrics.surgeCount >= 1000) funnel.surge.atLeast1000 += 1;
      if (metrics.surgeCount >= 5000) funnel.surge.atLeast5000 += 1;
      if (metrics.surgeCount >= 10000) funnel.surge.atLeast10000 += 1;
      if (metrics.surgeCount >= 200 && metrics.surgeCount < 300) {
        const boundaryMatch = findBestMatch(candidate.keyword, productCache.items, productIndex);
        const boundaryClassification = classifySurgeResult(candidate, boundaryMatch, productCache.items, job.matchThreshold);
        if (boundaryClassification.resultType) boundaryRelated.push({ keyword: candidate.keyword,
          estimatedSurgeCount: Math.round(metrics.surgeCount), resultType: boundaryClassification.resultType,
          matchScore: Number(boundaryMatch?.score || 0), judgment: boundaryClassification.relatedSignal?.judgment || boundaryMatch?.judgment || null,
          reason: boundaryClassification.relatedSignal?.reason || boundaryMatch?.reason || null });
      }
      if (surgeSignals.absoluteSurgePassed) funnel.surge.atUserThreshold += 1;
      if (surgeSignals.relativeTrendPassed) funnel.relativeSurge.trendEligible += 1;
      if (!surgeSignals.absoluteSurgePassed && !surgeSignals.relativeTrendPassed && !surgeSignals.lowIntensityTrendPassed) continue;
      const match = findBestMatch(candidate.keyword, productCache.items, productIndex);
      const score = Number(match?.score || 0);
      const existingNumericSurge = surgeSignals.absoluteSurgePassed || surgeSignals.relativeTrendPassed;
      if (existingNumericSurge && score >= 30) funnel.matching.atLeast30 += 1;
      if (existingNumericSurge && score >= 40) funnel.matching.atLeast40 += 1;
      if (existingNumericSurge && score >= 50) funnel.matching.atLeast50 += 1;
      if (existingNumericSurge && score >= 60) funnel.matching.atLeast60 += 1;
      if (existingNumericSurge && score >= 70) funnel.matching.atLeast70 += 1;
      if (existingNumericSurge && score >= 80) funnel.matching.atLeast80 += 1;
      if (existingNumericSurge && score >= 90) funnel.matching.atLeast90 += 1;
      if (existingNumericSurge && score >= job.matchThreshold) funnel.matching.atUserThreshold += 1;
      if (existingNumericSurge && match) matchedDiagnostics.push({ keyword: candidate.keyword, estimatedSurgeCount: Math.round(metrics.surgeCount),
        matchedProductName: match.item.product, matchScore: match.score, matchJudgment: match.judgment, matchReason: match.reason,
        matchingCandidateCount: match.matchingCandidateCount, additionalMatches: match.additionalMatches,
        matchSignals: match.signals, account: match.item.account, productId: match.item.productId || match.item.id || null });
      const shopping = shoppingMap.get(candidate.keyword) || [];
      const shoppingRatios = shopping.map((point) => Number(point.ratio || 0));
      const baseRow = { keyword: candidate.keyword, category: candidate.category, monthlySearches: candidate.monthlyTotalSearches,
        estimatedBaseline: Math.round(metrics.baseline), estimatedLatest: Math.round(metrics.latest), estimatedPeak: Math.round(metrics.peakValue),
        estimatedSurgeCount: Math.round(metrics.surgeCount), riseRate: metrics.baseline > 0 ? (metrics.surgeCount / metrics.baseline * 100) : null,
        endLift: Math.round(metrics.endLift), peakLift: Math.round(metrics.peakLift), peakDailyLift: Math.round(metrics.peakDailyLift || metrics.peakLift),
        sustainedLift: Math.round(metrics.sustainedLift || 0), peakDailyDate: metrics.peakDailyDate || null, latestDataDate: metrics.latestPeriod,
        trendFetchedAt: trace?.trendFetchedAt || null, cacheHit: Boolean(trace?.cacheHit), dataFreshness: trace?.dataFreshness || null,
        trendSeries: metrics.series, trendSlope: slope(metrics.series.map((point) => point.estimated)),
        shoppingTrend: shopping, shoppingRise: shoppingRatios.length > 1 ? shoppingRatios.at(-1) - median(shoppingRatios.slice(-8, -1)) : 0,
        newSearchAdQuery: candidate.sources.includes("searchad-query"), searchAdNewQuery: Boolean(candidate.isNewSearchQuery),
        searchAdImpressions30d: candidate.impressions30d, searchAdImpressionDelta: Number(candidate.confidenceImpressionDelta ?? candidate.impressionDelta ?? 0), searchAdClicks30d: Number(candidate.clicks30d || 0),
        match, sources: candidate.sources, discoverySource: candidate.sources, marketSourceConfidence: Number(candidate.sourceConfidence || 0),
        marketEvidence: candidate.marketEvidence || [], earlyMarketEvidence: (loadedEarlyCache?.history || []).filter((item) => item.normalizedKeyword === normalizeKeyword(candidate.keyword)
          && item.earlySignalDate <= metrics.latestPeriod).sort((a, b) => b.earlySignalDate.localeCompare(a.earlySignalDate))[0] || null,
        candidateTier: candidate.candidateTier || candidateTier(candidate, priorSignals.get(candidate.keyword)), news: null };
      const classification = classifySurgeResult(candidate, match, productCache.items, job.matchThreshold);
      const relativeSurgePassed = surgeSignals.relativeTrendPassed && Boolean(classification.resultType);
      const lowIntensityOnlyEligible = !surgeSignals.absoluteSurgePassed && !relativeSurgePassed && surgeSignals.lowIntensityTrendPassed;
      if (lowIntensityOnlyEligible) funnel.lowIntensity.numericEligible += 1;
      const lowIntensitySignal = lowIntensityOnlyEligible
        ? classifyLowIntensitySignal(candidate, match, productCache.items, productIndex, job.matchThreshold) : null;
      if (surgeSignals.relativeTrendPassed) {
        if (classification.resultType) funnel.relativeSurge.passedWithDomainEvidence += 1;
        else funnel.relativeSurge.insufficientDomainEvidence += 1;
        if (classification.resultType === "product_match") funnel.relativeSurge.productMatch += 1;
        else if (classification.resultType === "brand_or_category_signal") funnel.relativeSurge.brandSignal += 1;
        else if (classification.resultType === "domain_related_signal") funnel.relativeSurge.domainRelatedSignal += 1;
        if (!surgeSignals.absoluteSurgePassed && classification.resultType) funnel.relativeSurge.relativeOnlyAdded += 1;
      }
      if (lowIntensityOnlyEligible) {
        if (lowIntensitySignal) {
          funnel.lowIntensity.included += 1;
          if (lowIntensitySignal.signalType === "strong_product_match") funnel.lowIntensity.strongProductMatch += 1;
          else funnel.lowIntensity.brandProductContext += 1;
        } else funnel.lowIntensity.insufficientRelationEvidence += 1;
      }
      if (!lowIntensityOnlyEligible) {
        if (classification.resultType === "product_match") funnel.resultClassification.productMatch += 1;
        else if (classification.resultType === "brand_or_category_signal") funnel.resultClassification.brandSignal += 1;
        else if (classification.resultType === "domain_related_signal") funnel.resultClassification.domainRelatedSignal += 1;
        else funnel.resultClassification.unrelatedOrInsufficient += 1;
      }
      if (lowIntensitySignal) rows.push({ ...baseRow, ...surgeSignals, relativeSurgePassed: false, lowIntensityEarlySignal: true,
        surgeSignalType: "low_intensity", resultType: "low_intensity_early_signal", relatedSignal: lowIntensitySignal });
      else if (classification.resultType && !lowIntensityOnlyEligible) rows.push({ ...baseRow, ...surgeSignals, relativeSurgePassed,
        surgeSignalType: surgeSignals.absoluteSurgePassed && relativeSurgePassed ? "absolute_and_relative"
          : relativeSurgePassed ? "relative" : "absolute",
        resultType: classification.resultType, relatedSignal: classification.relatedSignal || null });
    }
    for (const candidate of ratioOnlyCandidates) {
      const trendData = trendMap.get(candidate.keyword);
      const trace = analysisTrace.get(normalizeKeyword(candidate.keyword));
      if (trace?.searchTrendStatus === "pending-cache") continue;
      if (!Array.isArray(trendData) || !trendData.length) { funnel.searchTrend.emptySeries += 1; if (trace) trace.searchTrendStatus = "empty"; continue; }
      const ratioMetrics = ratioOnlyMetrics(trendData, job.startDate, job.endDate);
      if (trace) Object.assign(trace, { searchTrendStatus: "valid", ratioOnly: true, ratioPeak: ratioMetrics.ratioPeak,
        ratioBaseline: ratioMetrics.ratioBaseline, relativeRatioLift: ratioMetrics.relativeRatioLift,
        peakDate: ratioMetrics.peakDate, latestRatio: ratioMetrics.latestRatio });
      if (ratioMetrics.relativeRatioLift === null || ratioMetrics.relativeRatioLift < RELATIVE_SURGE_PERCENT) continue;
      const match = findBestMatch(candidate.keyword, productCache.items, productIndex);
      const classification = classifySurgeResult(candidate, match, productCache.items, job.matchThreshold);
      const strongEvidence = Boolean(classification.resultType || candidate.sources.includes("searchad-new-query")
        || Number(candidate.sourceConfidence || 0) >= 80 && candidate.relatedBrand && (candidate.relatedProductType || candidate.relatedProductLine));
      if (!strongEvidence) continue;
      const evidenceSignal = classification.relatedSignal || { signalType: "market_context", relatedBrand: candidate.relatedBrand || "",
        relatedProductContext: candidate.relatedProductType || candidate.relatedProductLine || "", relatedProductCount: Number(match?.matchingCandidateCount || 0),
        referenceProducts: match?.item ? [match.item] : [], judgment: "ratio-only 시장 신호",
        reason: "월간검색량 미제공 / 검증된 시장·상품 문맥에서 Search Trend ratio 급상승" };
      rows.push({ keyword: candidate.keyword, category: candidate.category, monthlySearches: null, estimatedBaseline: null, estimatedLatest: null,
        estimatedPeak: null, estimatedSurgeCount: null, riseRate: null, endLift: null, peakLift: null, peakDailyLift: null,
        peakRelativeLiftPct: ratioMetrics.relativeRatioLift, peakBaseline: null, peakEstimatedSearches: null, peakDate: ratioMetrics.peakDate,
        latestDataDate: ratioMetrics.series.at(-1)?.period || null, trendFetchedAt: trace?.trendFetchedAt || null,
        cacheHit: Boolean(trace?.cacheHit), dataFreshness: trace?.dataFreshness || null,
        trendSeries: ratioMetrics.series, trendSlope: slope(ratioMetrics.series.map((point) => point.ratio)),
        shoppingTrend: [], shoppingRise: 0, newSearchAdQuery: candidate.sources.includes("searchad-new-query"), searchAdNewQuery: Boolean(candidate.isNewSearchQuery),
        searchAdImpressions30d: candidate.impressions30d, searchAdImpressionDelta: Number(candidate.confidenceImpressionDelta ?? candidate.impressionDelta ?? 0), searchAdClicks30d: Number(candidate.clicks30d || 0),
        match, sources: candidate.sources, discoverySource: candidate.sources, marketSourceConfidence: Number(candidate.sourceConfidence || 0),
        earlyMarketEvidence: (loadedEarlyCache?.history || []).filter((item) => item.normalizedKeyword === normalizeKeyword(candidate.keyword)
          && item.earlySignalDate <= (ratioMetrics.series.at(-1)?.period || "")).sort((a, b) => b.earlySignalDate.localeCompare(a.earlySignalDate))[0] || null,
        candidateTier: candidate.candidateTier || candidateTier(candidate, priorSignals.get(candidate.keyword)), news: null,
        absoluteSurgePassed: false, relativeSurgePassed: false, lowIntensityEarlySignal: false,
        ratioOnlyMarketSignal: true, ratioPeak: ratioMetrics.ratioPeak, ratioBaseline: ratioMetrics.ratioBaseline,
        relativeRatioLift: ratioMetrics.relativeRatioLift, latestRatio: ratioMetrics.latestRatio,
        resultType: "ratio_only_market_signal", surgeSignalType: "ratio_only", relatedSignal: evidenceSignal, marketEvidence: candidate.marketEvidence || [] });
    }
    // Slow Path only: enrich the already selected business signals. This keeps
    // Shopping Insight out of the 5,000-candidate fan-out while preserving the
    // existing shoppingRise UI for candidates where data is available.
    if (!job.fastPath && rows.length) {
      const candidateByKey = new Map(trendCandidates.map((candidate) => [normalizeKeyword(candidate.keyword), candidate]));
      const shoppingCandidates = rows.map((row) => candidateByKey.get(normalizeKeyword(row.keyword))).filter(Boolean)
        .filter((candidate) => !shoppingMap.has(candidate.keyword));
      shoppingQuota = quotaStatusFor(await readQuotaUsage(), "shoppingInsight", 0);
      const deferredPlan = planTrendFetch(shoppingCandidates, shoppingQuota);
      eligibleShoppingFetch = new Map(["beauty", "health"].map((category) => [category, deferredPlan.selected.filter((candidate) => candidate.category === category)]));
      expectedShoppingCalls = deferredPlan.expectedCalls;
      funnel.trendCache.shoppingInsight.expectedApiCalls = expectedShoppingCalls;
      funnel.trendCache.shoppingInsight.pendingCandidates = deferredPlan.pending.length;
      await persist({ message: `신호 후보 쇼핑 트렌드 보강 중 · ${deferredPlan.selected.length.toLocaleString("ko-KR")}건`,
        currentStage: "shopping-trend", progress: 89 });
      shoppingFetchLoop: for (const category of ["beauty", "health"]) {
        for (const requestBatch of chunks(chunks(eligibleShoppingFetch.get(category), 5), 5)) {
          const settled = await Promise.allSettled(requestBatch.map((batch) => api("/shopping/v1/category/keywords", { method: "POST", body: {
            startDate: job.queryStartDate, endDate: job.endDate, timeUnit: "date", category: CATEGORY_IDS[category],
            keyword: batch.map((item) => ({ name: item.keyword, param: [item.keyword] }))
          }, metrics: apiMetrics.shoppingInsight })));
          const fetchedAt = new Date().toISOString();
          for (let responseIndex = 0; responseIndex < settled.length; responseIndex += 1) {
            if (settled[responseIndex].status === "rejected") continue;
            const returned = new Map((settled[responseIndex].value.results || []).map((result) => [normalizeKeyword(result.title), result.data || []]));
            for (const candidate of requestBatch[responseIndex]) {
              const series = returned.get(normalizeKeyword(candidate.keyword)) || [];
              shoppingMap.set(candidate.keyword, series); dirtyTrendKeys.add(upsertTrendSeries(seriesCache.entries, { keyword: candidate.keyword,
                source: "shopping", category, startDate: job.queryStartDate, endDate: job.endDate, series, fetchedAt }));
              apiMetrics.shoppingInsight.keywords += 1;
            }
          }
          if (dirtyTrendKeys.size) { await writeDirtyTrendSeries(seriesCache, dirtyTrendKeys); dirtyTrendKeys.clear(); }
          if (apiMetrics.shoppingInsight.exhausted) break shoppingFetchLoop;
          await sleep(TREND_BATCH_DELAY_MS);
        }
      }
      for (const row of rows) {
        const series = shoppingMap.get(row.keyword); if (!series) continue;
        const ratios = series.map((point) => Number(point.ratio || 0)); row.shoppingTrend = series;
        row.shoppingRise = ratios.length > 1 ? ratios.at(-1) - median(ratios.slice(-8, -1)) : 0;
      }
      cacheStats.shoppingInsight.freshFetchCandidates = apiMetrics.shoppingInsight.keywords;
      cacheStats.shoppingInsight.apiCalls = apiMetrics.shoppingInsight.calls;
      cacheStats.shoppingInsight.retries = apiMetrics.shoppingInsight.retries;
      funnel.trendCache.shoppingInsight = { ...funnel.trendCache.shoppingInsight, ...cacheStats.shoppingInsight,
        expectedApiCalls: expectedShoppingCalls, pendingCandidates: deferredPlan.pending.length };
    }
    await recordObservedUsage();
    let surgeHistoryManifest = surgeHistoryCache.manifest;
    if (job.mode === "instant") {
      const latestHistoryCache = await readSurgeHistory();
      upsertInstantHistory(latestHistoryCache.records, calculated.map((entry) => ({ keyword: entry.candidate.keyword,
        latestDataDate: entry.metrics.latestPeriod, estimatedSurgeCount: entry.metrics.surgeCount,
        estimatedBaseline: entry.metrics.baseline, estimatedLatest: entry.metrics.latest,
        monthlySearches: entry.candidate.monthlyTotalSearches })), job.jobId, job.createdAt);
      surgeHistoryManifest = await writeSurgeHistory(latestHistoryCache.records);
      for (const row of rows) {
        const historyRecord = latestHistoryCache.records.get(normalizeKeyword(row.keyword));
        row.surgeHistoryState = deriveSurgeState(historyRecord, job.surgeThreshold, row.latestDataDate);
        row.surgeCalculationVersion = CALCULATION_VERSION;
      }
    }
    const surgeTop30 = calculated.slice().sort((a, b) => b.metrics.surgeCount - a.metrics.surgeCount).slice(0, 30).map((item) => item.diagnosticRow);
    const matchTop30 = matchedDiagnostics.slice().sort((a, b) => b.matchScore - a.matchScore || b.estimatedSurgeCount - a.estimatedSurgeCount).slice(0, 30);
    const samplePool = calculated.slice(); const samples = []; const addSample = (type, entry) => {
      if (entry && !samples.some((item) => item.keyword === entry.candidate.keyword)) samples.push({ type, ...entry.diagnosticRow });
    };
    addSample("highestSurge", samplePool.slice().sort((a, b) => b.metrics.surgeCount - a.metrics.surgeCount)[0]);
    addSample("nearThreshold", samplePool.slice().sort((a, b) => Math.abs(a.metrics.surgeCount - job.surgeThreshold) - Math.abs(b.metrics.surgeCount - job.surgeThreshold))[0]);
    addSample("largestMonthlyVolume", samplePool.slice().sort((a, b) => Number(b.candidate.monthlyTotalSearches || 0) - Number(a.candidate.monthlyTotalSearches || 0))[0]);
    addSample("largestLatestLift", samplePool.slice().sort((a, b) => b.metrics.endLift - a.metrics.endLift)[0]);
    addSample("sparsestTrend", samplePool.filter((item) => item.diagnosticRow.nonZeroRatioDays > 0).sort((a, b) => a.diagnosticRow.nonZeroRatioDays - b.diagnosticRow.nonZeroRatioDays)[0]);
    rows.sort((a, b) => Number(b.estimatedSurgeCount || 0) - Number(a.estimatedSurgeCount || 0)
      || Number(b.relativeRatioLift || 0) - Number(a.relativeRatioLift || 0) || b.shoppingRise - a.shoppingRise || b.trendSlope - a.trendSlope);
    await persist({ message: "상위 급등 검색어 뉴스 확인 중", progress: 90 });
    job.currentStage = "news"; job.processedCount = 0; job.totalCount = Math.min(rows.length, 20);
    const newsResults = job.fastPath ? [] : await Promise.allSettled(rows.slice(0, 20).map(async (row) => {
      const payload = await api("/search/v1/news", { params: { query: row.keyword, display: 3, start: 1, sort: "date" } });
      return { keyword: row.keyword, total: Number(payload.total || 0), items: (payload.items || []).slice(0, 3) };
    }));
    newsResults.forEach((result) => { if (result.status === "fulfilled") { const row = rows.find((item) => item.keyword === result.value.keyword); if (row) row.news = result.value; } });
    for (const row of rows) Object.assign(row, calculateMarketConfidence(row, job.surgeThreshold));
    const latestDataDate = [...trendMap.values()].flatMap((data) => (data || []).map((point) => point.period)).filter(Boolean).sort().at(-1) || null;
    const resultByKeyword = new Map(rows.map((row) => [normalizeKeyword(row.keyword), row]));
    for (const trace of analysisTrace.values()) {
      const result = resultByKeyword.get(trace.normalizedKeyword);
      trace.finalIncluded = Boolean(result); trace.resultType = result?.resultType || null;
      trace.exclusionReason = result ? null : trace.searchTrendStatus === "pending-cache" ? trace.exclusionReason || "Trend 캐시 구축 대기"
        : trace.searchTrendStatus === "empty" ? "Search Trend 시계열 없음"
        : trace.ratioOnly && Number(trace.relativeRatioLift || 0) < RELATIVE_SURGE_PERCENT ? "ratio-only 상대 변화 기준 미달"
          : !trace.ratioOnly && !trace.absoluteSurgePassed && !trace.relativeSurgePassed && !trace.lowIntensityTrendPassed ? "급등 수치 조건 미달"
            : "상품·브랜드·도메인 관련 근거 부족";
    }
    await writeDiagnosticIndex({ version: 1, jobId: job.jobId, mode: job.mode, startDate: job.startDate, endDate: job.endDate,
      latestDataDate, completedAt: new Date().toISOString(), items: [...analysisTrace.values()] });
    if (!partialAnalysis) await analysisStore().setJSON("signals/current", { updatedAt: new Date().toISOString(), mode: job.mode,
      items: calculated.map((entry) => ({ keyword: entry.candidate.keyword, estimatedSurgeCount: Math.round(entry.metrics.surgeCount),
        endLift: Math.round(entry.metrics.endLift), peakLift: Math.round(entry.metrics.peakLift), latestDataDate: entry.metrics.latestPeriod })) });
    await persist({ state: "completed", message: "분석 완료", progress: 100, completedAt: new Date().toISOString(), durationMs: Date.now() - started,
      currentStage: "completed", processedCount: trendCandidates.length, totalCount: trendCandidates.length,
      latestDataDate, searchAdCount: productCache.items.length, analyzedCandidateCount: trendCandidates.length, resultCount: rows.length,
      partialAnalysis, trendAvailableCount, pendingTrendCacheCount, trendCoveragePct,
      cacheHitCount: Number(cacheStats?.searchTrend?.hits || 0), freshFetchCount: Number(cacheStats?.searchTrend?.freshFetchCandidates || 0),
      cacheMissCount: Number(cacheStats?.searchTrend?.misses || 0) + Number(cacheStats?.searchTrend?.stale || 0) + Number(cacheStats?.searchTrend?.windowUnavailable || 0),
      staleRefreshCount: Number(cacheStats?.searchTrend?.stale || 0), searchTrendApiCallCount: Number(apiMetrics.searchTrend.calls || 0),
      cacheWindowUnavailableCount: Number(cacheStats?.searchTrend?.windowUnavailable || 0), trendCollectedAt, budgetMode,
      searchTrendHttp200Count: Number(apiMetrics.searchTrend.http200 || 0), searchTrendHttp429Count: Number(apiMetrics.searchTrend.http429 || 0),
      searchTrendHttpOtherCount: Number(apiMetrics.searchTrend.httpOther || 0),
      shoppingInsightApiCallCount: Number(apiMetrics.shoppingInsight.calls || 0), naverApiRetryCount: Number(apiMetrics.searchTrend.retries || 0) + Number(apiMetrics.shoppingInsight.retries || 0),
      shoppingInsightHttp200Count: Number(apiMetrics.shoppingInsight.http200 || 0), shoppingInsightHttp429Count: Number(apiMetrics.shoppingInsight.http429 || 0),
      shoppingInsightHttpOtherCount: Number(apiMetrics.shoppingInsight.httpOther || 0),
      productMatchResultCount: rows.filter((row) => row.resultType === "product_match").length,
      brandCategorySignalCount: rows.filter((row) => row.resultType === "brand_or_category_signal").length,
      domainRelatedSignalCount: rows.filter((row) => row.resultType === "domain_related_signal").length,
      lowIntensityEarlySignalCount: rows.filter((row) => row.resultType === "low_intensity_early_signal").length,
      ratioOnlyMarketSignalCount: rows.filter((row) => row.resultType === "ratio_only_market_signal").length,
      results: rows, errors: [],
      diagnostic: { funnel, candidateCut: cutDiagnostic, surgeTop30, matchTop30, boundary200To299: {
        total: funnel.surge.from200To299, relatedCount: boundaryRelated.length, items: boundaryRelated.slice().sort((a, b) => b.estimatedSurgeCount - a.estimatedSurgeCount).slice(0, 100) },
        calculationSamples: samples.slice(0, 5),
        surgeHistory: job.mode === "instant" ? { stored: true, calculationVersion: CALCULATION_VERSION,
          shardCount: surgeHistoryManifest?.shardCount || 0, recordCount: surgeHistoryManifest?.recordCount || 0 } : { stored: false, reason: "period-mode" } } });
    await writeSnapshot(job);
    if (job.schedulerExecutionId) await schedulerExecutions.updateById(job.schedulerExecutionId, { state: "completed", stage: "completed",
      jobId: job.jobId, completedAt: job.completedAt, latestDataDate: job.latestDataDate,
      trendCoveragePct: job.trendCoveragePct, searchTrendApiCallCount: job.searchTrendApiCallCount }).catch(() => null);
    const discoveryHistory = await readDiscoveryHistory().catch(() => null);
    const earlyCache = loadedEarlyCache;
    const confirmedEarlyCache = earlyCache ? earlySignals.confirmSignals(earlyCache, [...analysisTrace.values()], rows, latestDataDate) : null;
    if (confirmedEarlyCache) await earlySignals.writeCache(confirmedEarlyCache).catch(() => null);
    if (discoveryHistory) {
      const signalHistory = mergeSignalHistory(discoveryHistory, rows, job.completedAt);
      await writeDiscoveryHistory(mergeEarlySignalHistory(signalHistory, confirmedEarlyCache?.history || [], job.completedAt)).catch(() => null);
    }
    if (partialAnalysis) await writeLastPartial(job); else await writeLastSuccess(job);
  } catch (error) {
    if (seriesCache && dirtyTrendKeys.size) await writeDirtyTrendSeries(seriesCache, dirtyTrendKeys).catch(() => null);
    await recordObservedUsage();
    if (cacheStats) {
      cacheStats.searchTrend.apiCalls = apiMetrics.searchTrend.calls; cacheStats.searchTrend.retries = apiMetrics.searchTrend.retries;
      cacheStats.shoppingInsight.apiCalls = apiMetrics.shoppingInsight.calls; cacheStats.shoppingInsight.retries = apiMetrics.shoppingInsight.retries;
    }
    await persist({ state: "failed", message: "분석 실패", failedAt: new Date().toISOString(), durationMs: Date.now() - started,
      cacheHitCount: Number(cacheStats?.searchTrend?.hits || 0), freshFetchCount: Number(cacheStats?.searchTrend?.freshFetchCandidates || 0),
      staleRefreshCount: Number(cacheStats?.searchTrend?.stale || 0), searchTrendApiCallCount: Number(apiMetrics.searchTrend.calls || 0),
      cacheWindowUnavailableCount: Number(cacheStats?.searchTrend?.windowUnavailable || 0), trendCollectedAt, budgetMode,
      searchTrendHttp200Count: Number(apiMetrics.searchTrend.http200 || 0), searchTrendHttp429Count: Number(apiMetrics.searchTrend.http429 || 0),
      searchTrendHttpOtherCount: Number(apiMetrics.searchTrend.httpOther || 0),
      shoppingInsightApiCallCount: Number(apiMetrics.shoppingInsight.calls || 0), naverApiRetryCount: Number(apiMetrics.searchTrend.retries || 0) + Number(apiMetrics.shoppingInsight.retries || 0),
      shoppingInsightHttp200Count: Number(apiMetrics.shoppingInsight.http200 || 0), shoppingInsightHttp429Count: Number(apiMetrics.shoppingInsight.http429 || 0),
      shoppingInsightHttpOtherCount: Number(apiMetrics.shoppingInsight.httpOther || 0),
      errors: [error.message] });
    if (job?.schedulerExecutionId) await schedulerExecutions.updateById(job.schedulerExecutionId, { state: "failed", stage: job.currentStage || "background",
      jobId: job.jobId, failedAt: new Date().toISOString(), errorCode: "BACKGROUND_FAILED", errorMessage: error.message, retryable: true }).catch(() => null);
  }
};

exports._test = { estimate, periodMetrics, instantMetrics, surgePassSignals, similarity, buildIndex: buildProductIndex, bestMatch: findBestMatch,
  evaluateMatch, buildBrandOrCategorySignal, buildDomainRelatedSignal, classifySurgeResult, classifyLowIntensitySignal, hasBusinessDomainEvidence, productBrandToken,
  median, summaryStats, candidateDiagnostic, surgeDiagnostic, analysisPriority, selectAnalysisCandidates, selectWithMarketDiscovery,
  marketCandidateForAnalysis, ratioOnlyMetrics, domainEvidenceScore, isRecentCandidate, trendFetchPriority, planTrendFetch };
