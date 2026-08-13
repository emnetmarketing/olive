const PRODUCT_TYPES = new Set(["크림", "세럼", "앰플", "에센스", "토너", "로션", "쿠션", "선크림", "클렌저", "클렌징", "샴푸", "트리트먼트", "마스크", "팩", "립", "향수", "파운데이션", "유산균", "비타민", "영양제", "프로틴", "단백질", "쉐이크", "콜라겐", "오메가3", "밴드", "보호대", "탈취제"]);
const INGREDIENTS = new Set(["나이아신아마이드", "레티놀", "비타민c", "비타민씨", "pdrn", "히알루론산", "콜라겐", "마그네슘", "유산균", "프로바이오틱스", "프리바이오틱스", "글루타치온", "병풀", "시카", "세라마이드", "판테놀", "비오틴", "아연", "철분", "루테인", "밀크씨슬", "오메가3", "단백질", "베르베린"]);
const GENERIC_WORDS = new Set(["효과", "효능", "추천", "사용법", "가격", "후기", "기획", "세트", "증정", "단독", "공식", "제품", "상품", "케어", "데일리", "프리미엄", "더블"]);

function compact(value) { return String(value || "").toLocaleLowerCase("ko-KR").replace(/[^0-9a-z가-힣]/g, ""); }
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

function evaluateMatch(keyword, item) {
  const product = String(item.product || ""); const brand = String(item.brand || "");
  const queryTokens = new Set(matchTokens(keyword)); const productTokens = new Set(matchTokens(`${brand} ${product}`));
  const explicitBrandTokens = matchTokens(brand);
  const firstProductToken = matchTokens(product)[0] || "";
  const compactQuery = compact(keyword); const compactProduct = compact(product);
  const compactPrefixBrand = !explicitBrandTokens.length && !/\s/.test(String(keyword || "").trim())
    && compactQuery && compactProduct.startsWith(compactQuery)
    && ![...queryTokens].some((token) => PRODUCT_TYPES.has(token) || INGREDIENTS.has(token) || GENERIC_WORDS.has(token));
  const inferredBrandToken = !compactPrefixBrand && !explicitBrandTokens.length && firstProductToken
    && (queryTokens.has(firstProductToken) || compactQuery.startsWith(compact(firstProductToken)))
    && !PRODUCT_TYPES.has(firstProductToken) && !INGREDIENTS.has(firstProductToken) && !GENERIC_WORDS.has(firstProductToken)
    ? firstProductToken : "";
  const brandTokens = new Set(explicitBrandTokens.length ? explicitBrandTokens : (compactPrefixBrand ? [...queryTokens] : (inferredBrandToken ? [inferredBrandToken] : [])));
  const brandCompact = compact(brand || (compactPrefixBrand ? keyword : inferredBrandToken));
  const brandMatch = Boolean(brandCompact && compact(keyword).includes(brandCompact));
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

  const signals = { brandMatch, inferredBrandMatch: Boolean(inferredBrandToken || compactPrefixBrand), productLineMatch, productNameMatch, ingredientMatch, concentrationMatch,
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
  items.forEach((item, position) => { for (const token of indexKeys(`${item.brand || ""} ${item.product || ""}`)) {
    if (!index.has(token)) index.set(token, []); if (index.get(token).length < 500) index.get(token).push(position);
  } });
  return index;
}
function findBestMatch(keyword, items, index) {
  const positionScores = new Map();
  for (const token of indexKeys(keyword)) for (const position of index.get(token) || []) positionScores.set(position, Number(positionScores.get(position) || 0) + 1);
  const shortlist = [...positionScores].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 500).map(([position]) => items[position]);
  const evaluated = shortlist.map((item, order) => ({ item, candidate: item.product, order, ...evaluateMatch(keyword, item) }))
    .sort((a, b) => b.score - a.score || a.order - b.order);
  if (!evaluated.length) return null;
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

module.exports = { PRODUCT_TYPES, INGREDIENTS, compact, matchTokens, indexKeys, auxiliarySimilarity, evaluateMatch, buildProductIndex, findBestMatch };
