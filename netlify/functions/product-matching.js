const PRODUCT_TYPES = new Set(["크림", "세럼", "앰플", "에센스", "토너", "로션", "쿠션", "선크림", "클렌저", "클렌징", "샴푸", "트리트먼트", "마스크", "팩", "립", "향수", "파운데이션", "유산균", "비타민", "영양제", "프로틴", "단백질", "쉐이크", "콜라겐", "오메가3", "밴드", "보호대", "탈취제"]);
const VERIFIED_CONTEXT_PRODUCT_TYPES = new Set([...PRODUCT_TYPES, "립밤", "파우더"]);
const INGREDIENTS = new Set(["나이아신아마이드", "레티놀", "비타민c", "비타민씨", "pdrn", "히알루론산", "콜라겐", "마그네슘", "유산균", "프로바이오틱스", "프리바이오틱스", "글루타치온", "병풀", "시카", "세라마이드", "판테놀", "비오틴", "아연", "철분", "루테인", "밀크씨슬", "오메가3", "단백질", "베르베린"]);
const GENERIC_WORDS = new Set(["효과", "효능", "추천", "사용법", "가격", "후기", "기획", "세트", "증정", "단독", "공식", "제품", "상품", "케어", "데일리", "프리미엄", "더블"]);
// Compounds are recognized by semantic word boundaries, never by an arbitrary
// interior substring. These are reusable product/body/form words, not a query
// blacklist (e.g. a two-syllable suffix inside an unrelated word is not proof).
const COMPOUND_WORDS = new Set([...PRODUCT_TYPES, ...INGREDIENTS, ...GENERIC_WORDS,
  "네일", "아트", "젤", "팁", "리무버", "밤", "풋", "앤", "패치", "오일", "워터", "핸드", "바디", "헤어",
  "스킨", "블러", "파우더", "선", "미스트", "손톱", "발톱", "영양", "보습", "수분", "톤업", "틴트", "글로스", "글로우", "브러시", "브러쉬"]);

function compact(value) { return String(value || "").toLocaleLowerCase("ko-KR").replace(/[^0-9a-z가-힣]/g, ""); }
const COMPOUND_LOOKUP = new Set([...COMPOUND_WORDS].map(compact).filter(Boolean));
const COMPOUND_PARTS = [...COMPOUND_LOOKUP];
function matchTokens(value) {
  return String(value || "").toLocaleLowerCase("ko-KR")
    .replace(/([가-힣a-z])([0-9])/g, "$1 $2").replace(/([0-9])([가-힣a-z])/g, "$1 $2")
    .replace(/[^0-9a-z가-힣]+/g, " ").trim().split(/\s+/).filter((token) => token.length >= 2 || /^\d+$/.test(token));
}
function koreanNgrams(value) {
  const token = String(value || ""); const keys = [];
  if (!/^[가-힣]{2,}$/.test(token)) return keys;
  for (let size = 2; size <= Math.min(4, token.length); size += 1) for (let index = 0; index <= token.length - size; index += 1) keys.push(`#${token.slice(index, index + size)}`);
  return keys;
}
function compoundTokens(value) {
  return String(value || "").toLocaleLowerCase("ko-KR")
    .replace(/([가-힣a-z])([0-9])/g, "$1 $2").replace(/([0-9])([가-힣a-z])/g, "$1 $2")
    .replace(/[^0-9a-z가-힣]+/g, " ").trim().split(/\s+/).filter(Boolean);
}
function adjacentCompounds(tokens) {
  const compounds = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const left = tokens[index], right = tokens[index + 1];
    if (/^[가-힣]+$/.test(left) && /^[가-힣]+$/.test(right) && left.length + right.length >= 3) compounds.push({ value: left + right, parts: [left, right] });
  }
  return compounds;
}
function indexKeys(value) {
  const tokens = matchTokens(value); const keys = new Set(tokens);
  for (const token of tokens) for (const key of koreanNgrams(token)) keys.add(key);
  for (const compound of adjacentCompounds(compoundTokens(value))) for (const key of koreanNgrams(compound.value)) keys.add(key);
  return [...keys];
}
function levenshtein(left, right) {
  const a = compact(left), b = compact(right), row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) { let previous = row[0]; row[0] = i; for (let j = 1; j <= b.length; j += 1) {
    const saved = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1)); previous = saved;
  } }
  return row[b.length];
}
function auxiliarySimilarity(left, right) {
  const a = compact(left), b = compact(right), size = Math.max(a.length, b.length);
  return size ? Math.max(0, (1 - levenshtein(a, b) / size) * 100) : 0;
}
function intersects(left, right) { return [...left].filter((token) => right.has(token)); }

function segmentedProductWords(value) {
  if (!value) return true;
  const reached = new Set([0]);
  for (let at = 0; at < value.length; at++) if (reached.has(at)) {
    for (const token of COMPOUND_PARTS) if (value.startsWith(token, at)) reached.add(at + token.length);
  }
  return reached.has(value.length);
}
function hasEvidenceTerm(value, term) {
  const needle = compact(term);
  if (!needle) return false;
  const words = compoundTokens(value);
  if (words.some(word => compact(word) === needle)) return true;
  if (adjacentCompounds(words).some(word => compact(word.value) === needle)) return true;
  // Only known vocabulary supports splitting a joined token. Arbitrary brand
  // or product-line fragments still require exact token/adjacent-token proof.
  if (!COMPOUND_LOOKUP.has(needle)) return false;
  return words.some(word => {
    const text = compact(word);
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1))
      if (segmentedProductWords(text.slice(0, at)) && segmentedProductWords(text.slice(at + needle.length))) return true;
    return false;
  });
}
function buildVerifiedBrandCatalog(items) {
  const brands = new Map();
  for (const item of items || []) {
    const value = compact(item?.brand);
    if (!value) continue;
    if (!brands.has(value)) brands.set(value, { value, label: String(item.brand), source: "explicit", verified: true });
  }
  return brands;
}
function brandEvidence(item, index) {
  const explicit = compact(item?.brand);
  if (explicit)
    return { value: explicit, label: String(item.brand), source: "explicit", verified: true };
  const first = String(item?.product || "").trim().split(/\s+/)[0] || "", value = compact(first);
  const catalog = index?.verifiedBrands || index;
  if (catalog instanceof Map && catalog.has(value))
    return { value, label: catalog.get(value)?.label || first, source: "catalog-confirmed", verified: true };
  if (!value || PRODUCT_TYPES.has(value) || INGREDIENTS.has(value) || GENERIC_WORDS.has(value))
    return { value: "", label: "", source: "none", verified: false };
  return { value, label: first, source: "inferred-prefix", verified: false };
}

function evaluateMatch(keyword, item, index) {
  const product = String(item.product || ""); const brand = String(item.brand || "");
  const queryTokens = new Set(matchTokens(keyword)); const productTokens = new Set(matchTokens(`${brand} ${product}`));
  const explicitBrandTokens = matchTokens(brand);
  const firstProductToken = matchTokens(product)[0] || "";
  const compactQuery = compact(keyword); const compactProduct = compact(product);
  const compactPrefixBrand = !explicitBrandTokens.length && !/\s/.test(String(keyword || "").trim())
    && compactQuery && compactProduct.startsWith(compactQuery)
    && ![...queryTokens].some((token) => PRODUCT_TYPES.has(token) || INGREDIENTS.has(token) || GENERIC_WORDS.has(token));
  const queryStartsWithKnownIngredient = [...INGREDIENTS, "비타민"].some((value) => compactQuery.startsWith(compact(value)) && compact(value).length > compact(firstProductToken).length);
  const inferredBrandToken = !queryStartsWithKnownIngredient && !compactPrefixBrand && !explicitBrandTokens.length && firstProductToken
    && (queryTokens.has(firstProductToken) || compactQuery.startsWith(compact(firstProductToken)))
    && !PRODUCT_TYPES.has(firstProductToken) && !INGREDIENTS.has(firstProductToken) && !GENERIC_WORDS.has(firstProductToken)
    ? firstProductToken : "";
  const brandTokens = new Set(explicitBrandTokens.length ? explicitBrandTokens : (compactPrefixBrand ? [...queryTokens] : (inferredBrandToken ? [inferredBrandToken] : [])));
  const brandCompact = compact(brand || (compactPrefixBrand ? keyword : inferredBrandToken));
  const evidence = brandEvidence(item, index);
  const brandMatch = Boolean(evidence.verified && evidence.value
    && (queryTokens.has(evidence.value) || compactQuery.startsWith(evidence.value)));
  const matchedTokens = intersects(queryTokens, productTokens);
  const ingredientTokens = new Set([...queryTokens].filter((token) => INGREDIENTS.has(token)));
  const productIngredientTokens = new Set([...productTokens].filter((token) => INGREDIENTS.has(token)));
  const ingredientMatches = intersects(ingredientTokens, productIngredientTokens);
  const typeMatches = intersects(new Set([...queryTokens].filter((token) => PRODUCT_TYPES.has(token))), new Set([...productTokens].filter((token) => PRODUCT_TYPES.has(token))));
  const numberMatches = intersects(new Set([...queryTokens].filter((token) => /^\d+(?:\.\d+)?$/.test(token))), new Set([...productTokens].filter((token) => /^\d+(?:\.\d+)?$/.test(token))));
  const productLineTokens = new Set([...productTokens].filter((token) => !brandTokens.has(token) && !PRODUCT_TYPES.has(token) && !INGREDIENTS.has(token)
    && !GENERIC_WORDS.has(token) && !/^\d+(?:\.\d+)?$/.test(token)));
  const compoundLineMatches = adjacentCompounds(compoundTokens(product)).filter((compound) => compactQuery.includes(compact(compound.value))
    && compound.parts.some((token) => productLineTokens.has(token))
    && !compound.parts.every((token) => PRODUCT_TYPES.has(token) || GENERIC_WORDS.has(token))).map((compound) => compound.value);
  const productLineMatches = [...new Set([...intersects(queryTokens, productLineTokens), ...compoundLineMatches])];
  const meaningfulQuery = [...queryTokens].filter((token) => !GENERIC_WORDS.has(token));
  const identifiedCompacts = [...new Set([brandMatch ? brandCompact : "", ...compoundLineMatches.map(compact), ...matchedTokens.map(compact)].filter(Boolean))];
  const identifiedCharacters = identifiedCompacts.reduce((sum, value) => sum + (compactQuery.includes(value) ? value.length : 0), 0);
  const tokenCoverage = compoundLineMatches.length && compactQuery ? Math.min(1, identifiedCharacters / compactQuery.length)
    : meaningfulQuery.length ? matchedTokens.filter((token) => meaningfulQuery.includes(token)).length / meaningfulQuery.length : 0;
  const ingredientMatch = ingredientMatches.length > 0;
  const concentrationMatch = ingredientMatch && numberMatches.length > 0;
  const productTypeMatch = typeMatches.length > 0;
  const productLineMatch = productLineMatches.length > 0;
  const specMatches = matchedTokens.filter((token) => !brandTokens.has(token)
    && (/^\d+(?:\.\d+)?$/.test(token) || /^[a-z]+\d+$/i.test(token)));
  const specMatch = specMatches.length > 0;
  const identifyingMatches = new Set([...productLineMatches, ...ingredientMatches, ...numberMatches, ...specMatches]);
  const productNameMatch = tokenCoverage >= .8 && meaningfulQuery.length >= 2 && identifyingMatches.size >= 1;
  const genericOnlyMatch = matchedTokens.length > 0 && meaningfulQuery.every((token) => PRODUCT_TYPES.has(token) || GENERIC_WORDS.has(token))
    || (meaningfulQuery.length === 1 && ingredientMatch && !concentrationMatch);
  const charSimilarity = auxiliarySimilarity(keyword, product);

  let score = tokenCoverage * 25 + Math.min(10, charSimilarity * .1);
  if (brandMatch) score += 18;
  if (productLineMatch) score += 22;
  if (ingredientMatch) score += 22;
  if (concentrationMatch) score += 22;
  if (productTypeMatch) score += 10;
  if (specMatch) score += 15;
  if (productNameMatch) score += 15;
  if (brandMatch && productLineMatch) score += 15;
  if (ingredientMatch && concentrationMatch) score += 18;
  if (ingredientMatch && productTypeMatch) score += 10;
  if (brandMatch && productTypeMatch) score += 8;
  if (identifyingMatches.size >= 3) score += 8;
  if (brandMatch && !productLineMatch && !ingredientMatch && !productTypeMatch && !specMatch) score = Math.min(score, 38);
  if (genericOnlyMatch) score = Math.min(score, PRODUCT_TYPES.has(meaningfulQuery[0]) ? 28 : 42);
  const rawScore = Math.max(0, Math.round(score));
  if (ingredientMatch && concentrationMatch && !brandMatch && !productLineMatch) score = Math.min(rawScore, 94);
  else score = Math.min(rawScore, 99);
  score = Math.max(0, Math.round(score));

  const signals = { brandMatch, brandVerified: evidence.verified, brandEvidenceSource: evidence.source, brandEvidenceValue: evidence.value,
    inferredBrandMatch: Boolean(!evidence.verified && (inferredBrandToken || compactPrefixBrand)), productLineMatch, productNameMatch, ingredientMatch, concentrationMatch,
    productTypeMatch, specMatch, tokenCoverage: Math.round(tokenCoverage * 100), genericOnlyMatch,
    matchedTokens, productLineMatches, ingredientMatches, concentrationMatches: numberMatches, typeMatches, specMatches,
    levenshteinSimilarity: Math.round(charSimilarity) };
  let judgment = "관련성 낮음"; const reasons = [];
  if (ingredientMatch && concentrationMatch) reasons.push("성분 + 농도 일치");
  if (brandMatch && productLineMatch) reasons.push("브랜드 + 제품라인 일치");
  else if (brandMatch && productTypeMatch) reasons.push("브랜드 + 제품군 일치");
  else if (brandMatch) reasons.push("브랜드만 일치 / 특정 제품 식별 근거 부족");
  if (ingredientMatch && productTypeMatch && !concentrationMatch) reasons.push("성분 + 제품군 일치");
  if (productLineMatch && !brandMatch) reasons.push("제품라인 일치");
  if (specMatch && !concentrationMatch) reasons.push("규격·모델 특징 일치");
  if (genericOnlyMatch && productTypeMatch) reasons.push("제품군만 일치 / 특정 상품 식별력 낮음");
  if (signals.inferredBrandMatch) reasons.push("상품명 접두어 유사 / 브랜드 미검증");
  if (!reasons.length && matchedTokens.length) reasons.push(`핵심 토큰 ${matchedTokens.join(", ")} 일치`);
  if (brandMatch && productLineMatch && (productNameMatch || specMatch)) judgment = "매우 강한 매칭";
  else if ((ingredientMatch && concentrationMatch) || (brandMatch && productLineMatch) || (productNameMatch && identifyingMatches.size >= 2)) judgment = "강한 매칭";
  else if (brandMatch && !productLineMatch && !productTypeMatch && !ingredientMatch) judgment = "브랜드 관련";
  else if (genericOnlyMatch && productTypeMatch) judgment = "제품군 관련";
  else if (score >= 50 && !genericOnlyMatch) judgment = "관련 있음";
  else if (score >= 25) judgment = "약한 관련";
  return { score, rawScore, signals, judgment, reason: reasons.join(" / ") || "식별 가능한 공통 특징 부족" };
}

function buildProductIndex(items) {
  const index = new Map();
  const brandPositions = new Map();
  index.verifiedBrands = buildVerifiedBrandCatalog(items);
  items.forEach((item, position) => { for (const token of indexKeys(`${item.brand || ""} ${item.product || ""}`)) {
    if (!index.has(token)) index.set(token, []); if (index.get(token).length < 500) index.get(token).push(position);
  }
    const evidence = brandEvidence(item, index);
    const brand = evidence.verified ? evidence.value : "";
    if (brand) {
      if (!brandPositions.has(brand)) brandPositions.set(brand, []);
      brandPositions.get(brand).push(position);
    }
  });
  index.brandPositions = brandPositions;
  return index;
}
function detectQueryBrand(keyword, index) {
  const query = compact(keyword);
  if (!query || !index?.brandPositions) return "";
  return [...index.brandPositions.keys()]
    .filter((brand) => query.startsWith(brand))
    .sort((a, b) => b.length - a.length)[0] || "";
}

function detectVerifiedBrandProductContext(keyword, item, index) {
  const query = compact(keyword);
  const brand = detectQueryBrand(keyword, index);
  if (!query || !brand || !query.startsWith(brand) || query === brand) return null;
  const suffix = query.slice(brand.length);
  const productTypes = [...VERIFIED_CONTEXT_PRODUCT_TYPES].map(compact).filter((type) => type.length >= 2)
    .sort((left, right) => right.length - left.length);
  const productType = productTypes.find((type) => suffix === type) || "";
  if (!productType) return null;
  const evidence = brandEvidence(item, index);
  const itemBrand = evidence.verified ? evidence.value : "";
  const product = compact(item?.product);
  if (itemBrand !== brand || !hasEvidenceTerm(item?.product, productType)) return null;
  return { brand, productType, normalizedParts: [brand, productType] };
}
function findBestMatch(keyword, items, index) {
  const positionScores = new Map();
  for (const token of indexKeys(keyword)) for (const position of index.get(token) || []) positionScores.set(position, Number(positionScores.get(position) || 0) + 1);
  const queryBrand = detectQueryBrand(keyword, index);
  for (const position of index.brandPositions?.get(queryBrand) || []) {
    positionScores.set(position, Number(positionScores.get(position) || 0) + 1000);
  }
  const shortlist = [...positionScores].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 500).map(([position]) => items[position]);
  let evaluated = shortlist.map((item, order) => ({ item, candidate: item.product, order, ...evaluateMatch(keyword, item, index) }))
    .sort((a, b) => b.score - a.score || a.order - b.order);
  if (!evaluated.length) return null;
  if (queryBrand) {
    const sameBrand = evaluated.filter((entry) => {
      const evidence = brandEvidence(entry.item, index);
      const itemBrand = evidence.verified ? evidence.value : "";
      return itemBrand === queryBrand;
    });
    if (sameBrand.length) evaluated = sameBrand;
  }
  const bestBase = evaluated[0];
  const strongMatches = evaluated.filter((entry) => entry.score >= 60 && entry.score >= bestBase.score - 5
    && (entry.signals.ingredientMatch && entry.signals.concentrationMatch
      || entry.signals.brandMatch && entry.signals.productLineMatch
      || entry.signals.productNameMatch));
  const matchingCandidateCount = Math.max(1, strongMatches.length);
  const adjustScore = (entry) => {
    const signals = entry.signals;
    const uniqueIdentification = matchingCandidateCount === 1 && signals.brandMatch && signals.productLineMatch
      && (signals.specMatch || signals.concentrationMatch || signals.productNameMatch) && signals.tokenCoverage >= 80;
    if (uniqueIdentification) return 100;
    if (signals.ingredientMatch && signals.concentrationMatch && !signals.brandMatch && !signals.productLineMatch) {
      const cap = matchingCandidateCount === 1 ? 94 : Math.max(84, 92 - (matchingCandidateCount - 1) * 2);
      return Math.min(entry.score, cap);
    }
    if (matchingCandidateCount > 1) return Math.min(entry.score, Math.max(86, 96 - (matchingCandidateCount - 1) * 2));
    return Math.min(entry.score, 99);
  };
  const ranked = (strongMatches.length ? strongMatches : [bestBase]).map((entry) => ({ ...entry, score: adjustScore(entry) }));
  const best = ranked[0];
  return { ...best, matchingCandidateCount, uniqueIdentification: best.score === 100,
    additionalMatches: ranked.slice(1, 6).map(({ item, candidate, score, judgment, reason, signals }) => ({ item, candidate, score, judgment, reason, signals })) };
}

module.exports = { PRODUCT_TYPES, INGREDIENTS, compact, matchTokens, indexKeys, auxiliarySimilarity, evaluateMatch, buildProductIndex,
  detectQueryBrand, detectVerifiedBrandProductContext, findBestMatch, hasEvidenceTerm, brandEvidence, buildVerifiedBrandCatalog };
