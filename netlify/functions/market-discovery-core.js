const { PRODUCT_TYPES, INGREDIENTS, compact, matchTokens } = require("./product-matching");

const YOUTUBE_SEEDS = Object.freeze([
  "올리브영", "뷰티", "메이크업", "헤어", "추천템", "신상", "신제품",
  "화장품 추천", "신상 화장품", "신상 스킨케어", "신상 립",
  "립 추천", "쿠션 추천", "파운데이션 추천", "선크림 추천", "클렌저 추천",
  "아이크림 추천", "헤어제품 추천", "다이어트 추천", "영양제 추천", "건강기능식품",
  "유산균 추천", "비타민 추천", "피부관리", "뷰티 신제품", "화장품 신제품"
]);
const VERIFIED_TYPES = Object.freeze([...new Set([...PRODUCT_TYPES, "파우더", "립밤", "립글로우", "선파우더", "선로션", "비누", "스티커", "컬링에센스"])]);
const STOP = new Set(["추천", "리뷰", "후기", "신상", "신제품", "요즘", "진짜", "완전", "영상", "화장품", "제품", "사용", "써봄", "써봤어요", "소개", "공개", "광고", "협찬", "기획", "세트", "단독", "공식", "올리브영", "오늘", "내돈내산"]);
const GENERIC_BRAND = new Set([...PRODUCT_TYPES, ...INGREDIENTS, "비타민", "두유", "카카오", "화장품", "뷰티", "건강", "영양제"]);

function normalizeText(value) {
  return String(value || "").toLocaleLowerCase("ko-KR").replace(/<[^>]*>/g, " ")
    .replace(/\d+(?:\.\d+)?\s*(?:ml|g|mg|정|포|매|개|입)/gi, " ")
    .replace(/[^0-9a-z가-힣\s]/g, " ").replace(/\s+/g, " ").trim();
}
function normalizedKeyword(value) { return compact(value); }
function cleanTokens(value) {
  return normalizeText(value).split(/\s+/).filter((token) => token.length >= 2 && token.length <= 20 && !STOP.has(token) && !/^\d+$/.test(token));
}
function productTypeIn(value) {
  const text = compact(value);
  return VERIFIED_TYPES.slice().sort((a, b) => compact(b).length - compact(a).length).find((type) => text.includes(compact(type))) || "";
}
function buildVerifiedBrands(products) {
  const records = new Map();
  for (const item of products || []) {
    const first = compact(item.brand) || compact(matchTokens(item.product)[0] || "");
    if (first.length < 2 || GENERIC_BRAND.has(first)) continue;
    const record = records.get(first) || { token: first, products: 0, adgroups: new Set(), productTypes: new Set() };
    record.products += 1;
    if (item.adGroupId) record.adgroups.add(String(item.adGroupId));
    const type = productTypeIn(item.product); if (type) record.productTypes.add(type);
    records.set(first, record);
  }
  return new Map([...records].filter(([, record]) => record.products >= 2
    && (record.adgroups.size >= 2 || record.productTypes.size >= 2)));
}
function productCandidates(products, options = {}) {
  const brandProducts = options.brandProducts || products;
  const brands = buildVerifiedBrands(brandProducts); const byBrand = new Map();
  for (const item of products || []) {
    const brand = compact(item.brand) || compact(matchTokens(item.product)[0] || "");
    if (!brands.has(brand)) continue;
    if (!byBrand.has(brand)) byBrand.set(brand, []); byBrand.get(brand).push(item);
  }
  const output = new Map(); const add = (keyword, evidence) => {
    const key = normalizedKeyword(keyword); if (key.length < 2 || key.length > 30) return;
    if (!output.has(key)) output.set(key, { keyword: key, normalizedKeyword: key, relatedBrand: evidence.brand,
      relatedProductType: evidence.productType || "", relatedProductLine: evidence.productLine || "",
      evidence: [evidence], productEvidence: [evidence], sourceConfidence: evidence.confidence });
  };
  for (const [brand, items] of byBrand) {
    const lineCounts = new Map();
    for (const item of items) for (const token of cleanTokens(item.product)) {
      const value = compact(token); if (value === brand || GENERIC_BRAND.has(value) || VERIFIED_TYPES.some((type) => compact(type) === value)) continue;
      lineCounts.set(value, (lineCounts.get(value) || 0) + 1);
    }
    const repeatedLines = [...lineCounts].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([line]) => line);
    add(brand, { source: "product-cache", brand, confidence: 45, productCount: items.length });
    const types = [...new Set(items.map((item) => productTypeIn(item.product)).filter(Boolean))];
    for (const type of types) add(`${brand}${type}`, { source: "product-cache", brand, productType: type, confidence: 72, productCount: items.length });
    for (const line of repeatedLines) {
      add(`${brand}${line}`, { source: "product-cache", brand, productLine: line, confidence: 68, productCount: lineCounts.get(line) });
      add(line, { source: "product-cache", brand, productLine: line, confidence: 55, productCount: lineCounts.get(line) });
      for (const type of types.filter((type) => items.some((item) => compact(item.product).includes(line) && compact(item.product).includes(compact(type))))) {
        add(`${line}${type}`, { source: "product-cache", brand, productLine: line, productType: type, confidence: 78, productCount: lineCounts.get(line) });
        add(`${brand}${line}${type}`, { source: "product-cache", brand, productLine: line, productType: type, confidence: 84, productCount: lineCounts.get(line) });
      }
    }
  }
  const globalLines = new Map();
  for (const item of brandProducts || []) {
    const type = productTypeIn(item.product); if (!type) continue;
    const compactType = compact(type);
    for (const rawToken of cleanTokens(item.product)) {
      let line = compact(rawToken);
      if (line.endsWith(compactType) && line.length > compactType.length + 1) line = line.slice(0, -compactType.length);
      if (line.length < 3 || GENERIC_BRAND.has(line) || VERIFIED_TYPES.some((value) => compact(value) === line)) continue;
      const record = globalLines.get(`${line}|${compactType}`) || { line, type, products: 0, adgroups: new Set() };
      record.products += 1; if (item.adGroupId) record.adgroups.add(String(item.adGroupId)); globalLines.set(`${line}|${compactType}`, record);
    }
  }
  for (const record of globalLines.values()) if (record.products >= 2 && (record.adgroups.size >= 2 || record.products >= 3)) {
    add(`${record.line}${record.type}`, { source: "product-cache", brand: "", productLine: record.line,
      productType: record.type, confidence: 70, productCount: record.products });
  }
  return [...output.values()].sort((a, b) => b.sourceConfidence - a.sourceConfidence).slice(0, options.limit || 5000);
}
function youtubeCandidates(videos, products) {
  const verifiedBrands = buildVerifiedBrands(products); const occurrences = new Map();
  const record = (keyword, video, meta) => {
    const key = normalizedKeyword(keyword); if (key.length < 3 || key.length > 30) return;
    const current = occurrences.get(key) || { keyword: key, normalizedKeyword: key, videos: new Map(), channels: new Set(), titleHits: 0, descriptionHits: 0,
      relatedBrand: meta.brand || "", relatedProductType: meta.productType || "", relatedProductLine: meta.productLine || "" };
    current.videos.set(video.videoId, video); current.channels.add(video.channelId || video.channelTitle || "unknown");
    current.titleHits += meta.titleHit ? 1 : 0; current.descriptionHits += meta.descriptionHit ? 1 : 0; occurrences.set(key, current);
  };
  for (const video of videos || []) {
    const title = normalizeText(video.title); const description = normalizeText(video.description).slice(0, 500);
    const titleTokens = cleanTokens(title); const allText = `${title} ${description}`;
    for (const type of VERIFIED_TYPES.slice().sort((a, b) => compact(b).length - compact(a).length)) {
      const typeCompact = compact(type); if (!compact(allText).includes(typeCompact)) continue;
      for (let index = 0; index < titleTokens.length; index += 1) {
        const token = compact(titleTokens[index]); const joined = compact(`${titleTokens[index]}${titleTokens[index + 1] || ""}`);
        let brand = verifiedBrands.has(token) ? token : verifiedBrands.has(joined) ? joined : "";
        if (!brand && index < titleTokens.length - 1 && compact(titleTokens[index + 1]).includes(typeCompact)
          && token.length >= 2 && token.length <= 15 && !GENERIC_BRAND.has(token)) brand = token;
        if (!brand || !compact(title).includes(brand) || !compact(title).includes(typeCompact)) continue;
        const following = compact(titleTokens[index + 1] || "");
        const preceding = compact(titleTokens[index - 1] || "");
        let productExpression = typeCompact; let productLine = "";
        if (following.includes(typeCompact) && following.length > typeCompact.length) {
          productExpression = following; productLine = following.replace(typeCompact, "");
        } else if (preceding.includes(typeCompact) && preceding.length > typeCompact.length) {
          productExpression = preceding; productLine = preceding.replace(typeCompact, "");
        }
        record(`${brand}${productExpression}`, video, { brand, productType: type, productLine,
          titleHit: true, descriptionHit: compact(description).includes(brand + productExpression) });
      }
    }
  }
  return [...occurrences.values()].map((item) => {
    const videoCount = item.videos.size, channelCount = item.channels.size;
    const confidence = Math.min(100, 38 + item.titleHits * 14 + item.descriptionHits * 5 + Math.max(0, videoCount - 1) * 12
      + Math.max(0, channelCount - 1) * 12 + (verifiedBrands.has(item.relatedBrand) ? 12 : 0));
    return { keyword: item.keyword, normalizedKeyword: item.normalizedKeyword, relatedBrand: item.relatedBrand,
      relatedProductType: item.relatedProductType, relatedProductLine: item.relatedProductLine,
      sourceConfidence: confidence, youtubeEvidence: [...item.videos.values()].slice(0, 10),
      evidence: [{ source: "youtube", videoCount, channelCount, titleHits: item.titleHits, confidence }] };
  }).filter((item) => item.sourceConfidence >= 55).sort((a, b) => b.sourceConfidence - a.sourceConfidence);
}
function mergeCandidates(existing, incoming, now = new Date().toISOString()) {
  const map = new Map((existing || []).map((item) => [item.normalizedKeyword || normalizedKeyword(item.keyword), { ...item }]));
  for (const item of incoming || []) {
    const key = item.normalizedKeyword || normalizedKeyword(item.keyword); const previous = map.get(key);
    const sources = [...new Set([...(previous?.discoverySource || []), ...(item.discoverySource || []), ...(item.evidence || []).map((entry) => entry.source)].filter(Boolean))];
    map.set(key, { ...previous, ...item, keyword: item.keyword || previous?.keyword || key, normalizedKeyword: key,
      discoverySource: sources, discoveredAt: previous?.discoveredAt || now, lastSeenAt: now,
      evidence: [...(previous?.evidence || []), ...(item.evidence || [])].slice(-20),
      youtubeEvidence: item.youtubeEvidence || previous?.youtubeEvidence || [],
      productEvidence: item.productEvidence || previous?.productEvidence || [],
      searchAdEvidence: item.searchAdEvidence || previous?.searchAdEvidence || null,
      sourceConfidence: Math.min(100, Math.max(Number(previous?.sourceConfidence || 0), Number(item.sourceConfidence || 0)) + Math.max(0, sources.length - 1) * 8),
      monthlySearchStatus: previous?.monthlySearchStatus || "not-requested", monthlyTotalSearches: previous?.monthlyTotalSearches ?? null });
  }
  return [...map.values()];
}
function discoveryPriority(item, now = Date.now()) {
  const sources = item.discoverySource || []; const ageHours = Math.max(0, (now - Date.parse(item.discoveredAt || now)) / 3600000);
  return sources.length * 40 + Number(item.sourceConfidence || 0) + (ageHours <= 48 ? 25 : 0)
    + (item.relatedBrand && (item.relatedProductType || item.relatedProductLine) ? 30 : 0)
    + (sources.includes("searchad-new-query") ? 25 : 0) + (item.monthlySearchStatus === "available" ? 15 : 0)
    + Math.log10(Number(item.monthlyTotalSearches || 0) + 1) * 3 + Math.log10(Number(item.searchAdEvidence?.recentImpressions || 0) + 1) * 2;
}

module.exports = { YOUTUBE_SEEDS, VERIFIED_TYPES, normalizeText, normalizedKeyword, buildVerifiedBrands, productCandidates,
  youtubeCandidates, mergeCandidates, discoveryPriority, productTypeIn };
