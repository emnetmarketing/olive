// Read-boundary projection only. Never write this view back to a Job, snapshot,
// cache or publication manifest: their original hashes remain authoritative.
const { createHash } = require("node:crypto");
const { evaluateMatch, hasEvidenceTerm, brandEvidence, buildVerifiedBrandCatalog, compact } = require("./product-matching");
const { grade } = require("./market-confidence");
const VERSION = 1;
// Same canonical representation as immutable publication hashes, without
// importing storage code into this pure display module.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const hash = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const finite = value => value != null && Number.isFinite(Number(value));
const RELEVANCE_REASON = /^(상품 직접 매칭|성분·농도 기준 상품 관련성|브랜드 직접 관련성|제품라인·성분·제품군 관련성|브랜드·제품 선행 문맥|상품 선행 문맥|검증된 시장·상품 문맥|저장 Search Ad 신규 유입 근거|브랜드 미확인)/;

function referenceKey(item) { return `${compact(item?.product)}|${compact(item?.brand)}`; }
function savedProducts(row) {
  const seen = new Set();
  return [...(row.relatedSignal?.referenceProducts || []), row.match?.item,
    ...(row.match?.additionalMatches || []).map(match => match.item)].filter(item => {
    if (!item?.product) return false;
    const key = referenceKey(item); if (seen.has(key)) return false; seen.add(key); return true;
  });
}
function revalidateMatch(keyword, match, brands) {
  if (!match?.item?.product) return match || null;
  const evaluated = evaluateMatch(keyword, match.item, brands);
  const signals = evaluated.signals;
  const specific = Boolean(signals.ingredientMatch && signals.concentrationMatch
    || signals.brandMatch && signals.productLineMatch || signals.productNameMatch
    || signals.productLineMatch && signals.specMatch);
  const scope = signals.ingredientMatch && signals.concentrationMatch && !signals.brandMatch
    ? "ingredient_concentration" : signals.brandMatch && specific ? "verified_brand_product"
      : specific || signals.productLineMatch || signals.ingredientMatch ? "product_context" : "unverified";
  const uniqueIdentification = Boolean(match.uniqueIdentification && signals.brandMatch && signals.productLineMatch
    && (signals.specMatch || signals.concentrationMatch || signals.productNameMatch) && Number(match.matchingCandidateCount || 1) === 1);
  const score = uniqueIdentification && Number(match.score) === 100 ? 100
    : finite(match.score) ? Math.min(Number(match.score), evaluated.score) : evaluated.score;
  return { ...match, ...evaluated, score,
    uniqueIdentification,
    identificationScope: scope,
    ...(Array.isArray(match.additionalMatches) ? { additionalMatches: match.additionalMatches.map(entry => revalidateMatch(keyword, entry, brands)) } : {}) };
}
function relationEvidence(row, match, products, brands) {
  const signals = match?.signals || {};
  const relatedBrand = String(row.relatedSignal?.relatedBrand || "");
  const verifiedBrand = products.map(item => brandEvidence(item, brands)).find(evidence => evidence.verified
    && (relatedBrand ? compact(evidence.value) === compact(relatedBrand) : signals.brandMatch && evidence.value === signals.brandEvidenceValue)
    && (hasEvidenceTerm(row.keyword, evidence.value) || compact(row.keyword).startsWith(evidence.value)));
  const terms = [...new Set([...(signals.productLineMatches || []), ...(signals.ingredientMatches || []), ...(signals.typeMatches || [])])];
  const references = products.filter(item => {
    if (verifiedBrand && brandEvidence(item, brands).verified && brandEvidence(item, brands).value === verifiedBrand.value) return true;
    return terms.some(term => hasEvidenceTerm(item.product, term));
  });
  const specific = Boolean(signals.ingredientMatch && signals.concentrationMatch || signals.brandMatch && signals.productLineMatch
    || signals.productNameMatch || signals.productLineMatch && signals.specMatch);
  const domain = Boolean(references.length && (signals.productLineMatch || signals.ingredientMatch
    || signals.productTypeMatch && !signals.genericOnlyMatch));
  return { specific, domain, references, verifiedBrand, terms };
}
function correctedType(row, evidence) {
  if (row.resultType === "product_match" && evidence.specific) return row.resultType;
  if (row.resultType === "domain_related_signal" && evidence.domain) return row.resultType;
  if (row.resultType === "brand_or_category_signal" && evidence.verifiedBrand) return row.resultType;
  if (row.resultType === "low_intensity_early_signal" && (evidence.verifiedBrand
    || row.relatedSignal?.signalType === "strong_product_match" && evidence.specific)) return row.resultType;
  if (row.resultType === "ratio_only_market_signal" && (evidence.verifiedBrand || evidence.specific || evidence.domain
    || storedNewQuerySource(row))) return row.resultType;
  if (evidence.verifiedBrand) return "brand_or_category_signal";
  if (evidence.domain) return "domain_related_signal";
  return "unverified_context_signal";
}
function storedNewQuerySource(row) {
  return [...(row.sources || []), ...(row.discoverySource || [])].includes("searchad-new-query");
}
function relevanceFor(row) {
  if (row.resultType === "product_match") return Math.round(14 + Math.max(0, Math.min(100, Number(row.match?.score || 0))) * .08);
  return ({ brand_or_category_signal: 14, domain_related_signal: 10, low_intensity_early_signal: 12, ratio_only_market_signal: 8 })[row.resultType] || 0;
}
function relevanceReason(row) {
  if (row.resultType === "product_match") return row.match?.identificationScope === "ingredient_concentration"
    ? `성분·농도 기준 상품 관련성 ${Math.round(row.match.score)}% · 특정 브랜드 단독 식별 아님`
    : `상품 직접 매칭 ${Math.round(row.match?.score || 0)}%`;
  if (row.resultType === "low_intensity_early_signal" && !row.match?.signals?.brandMatch) return "상품 선행 문맥 확인 · 브랜드 식별 근거 아님";
  if (row.resultType === "ratio_only_market_signal" && storedNewQuerySource(row) && !row.match?.signals?.brandMatch
    && row.match?.identificationScope === "unverified") return "저장 Search Ad 신규 유입 근거 확인 · 브랜드 식별 근거 아님";
  return ({ brand_or_category_signal: "브랜드 직접 관련성 확인", domain_related_signal: "제품라인·성분·제품군 관련성 확인",
    low_intensity_early_signal: "브랜드·제품 선행 문맥 확인", ratio_only_market_signal: "검증된 시장·상품 문맥 확인" })[row.resultType] || "";
}
function correctConfidence(source, projected, prefix, warnings) {
  const scoreKey = `${prefix}Score`, gradeKey = `${prefix}Grade`, reasonsKey = `${prefix}Reasons`, componentsKey = `${prefix}Components`;
  if (!(scoreKey in source) && !(componentsKey in source)) return;
  const prior = source[componentsKey], desired = relevanceFor(projected);
  const reason = relevanceReason(projected);
  if (Array.isArray(source[reasonsKey])) {
    let inserted = false;
    projected[reasonsKey] = source[reasonsKey].flatMap(value => {
      if (!RELEVANCE_REASON.test(String(value))) return [value];
      if (inserted || !reason) return []; inserted = true; return [reason];
    });
  }
  if (!finite(prior?.relevance) || !finite(source[scoreKey])) {
    if (source.resultType !== projected.resultType) {
      warnings.push("저장된 신뢰도 세부 점수 없음 · 관련성 점수 보정 불가");
      projected[scoreKey] = null; projected[gradeKey] = null;
    }
    return;
  }
  // A read-only correction may remove unsupported points, never award new ones
  // on a smaller, saved-reference-only evidence set. All other components stay.
  const relevance = Math.min(Number(prior.relevance), desired);
  projected[componentsKey] = { ...prior, relevance };
  const values = Object.values(prior), sum = values.reduce((total, value) => total + Number(value), 0);
  const verifiedBreakdown = values.every(finite) && Math.max(0, Math.min(100, Math.round(sum))) === Number(source[scoreKey]);
  if (relevance !== Number(prior.relevance) && !verifiedBreakdown) {
    warnings.push("저장된 신뢰도 합계와 세부 점수가 일치하지 않아 점수 보정 불가");
    projected[scoreKey] = null; projected[gradeKey] = null; return;
  }
  projected[scoreKey] = relevance === Number(prior.relevance) ? source[scoreKey]
    : Math.max(0, Math.min(100, Math.round(sum - Number(prior.relevance) + relevance)));
  projected[gradeKey] = grade(projected[scoreKey]);
}
function projectResult(row) {
  if (!row || typeof row !== "object" || row.qualityProjection?.version === VERSION) return row;
  // Compact rows and legacy rows lacking saved matching evidence cannot be
  // safely reinterpreted. Their full Job is used by projectSnapshot when present.
  if (!row.match?.item?.product && !row.relatedSignal) return row;
  const products = savedProducts(row), brands = buildVerifiedBrandCatalog(products);
  const match = revalidateMatch(row.keyword, row.match, brands);
  const evidence = relationEvidence(row, match, products, brands);
  const resultType = correctedType(row, evidence);
  const output = { ...row, match, resultType };
  const warnings = [];
  if (resultType === "unverified_context_signal") warnings.push("브랜드 미확인 참고 신호 · 상품 식별 근거 미검증");
  else if (row.relatedSignal?.relatedBrand && !evidence.verifiedBrand) warnings.push("브랜드 미확인 · 저장된 상품 또는 시장 근거만 표시");
  if (match?.identificationScope === "ingredient_concentration") warnings.push("성분·농도 관련 상품 · 특정 브랜드 단독 식별 아님");
  if (row.relatedSignal) output.relatedSignal = { ...row.relatedSignal,
    signalType: resultType === "unverified_context_signal" ? "unverified_context"
      : resultType === "domain_related_signal" ? match?.signals?.ingredientMatch ? "ingredient" : match?.signals?.productLineMatch ? "product_line" : "category"
        : resultType === "ratio_only_market_signal" && !evidence.verifiedBrand ? "market_context" : row.relatedSignal.signalType,
    relatedBrand: evidence.verifiedBrand?.label || "",
    relatedProductCount: null, verifiedReferenceCount: evidence.references.length,
    countScope: "stored_references_only", referenceProducts: evidence.references,
    judgment: resultType === "unverified_context_signal" ? "브랜드 미확인 참고 신호"
      : resultType === "domain_related_signal" ? "제품라인·성분·제품군 관련 신호"
        : resultType === "ratio_only_market_signal" && !evidence.verifiedBrand ? "저장 시장·상품 근거 참고 신호" : row.relatedSignal.judgment,
    reason: evidence.references.length ? `저장 참고 상품 ${evidence.references.length}건에서 관련성 확인 · 전체 상품 수 미재집계`
      : "저장된 상품·브랜드 근거 재검증 불충분 · 전체 상품 수 미재집계" };
  correctConfidence(row, output, "marketConfidence", warnings);
  correctConfidence(row, output, "periodMarketConfidence", warnings);
  const removedReferenceCount = (row.relatedSignal?.referenceProducts || []).filter(item =>
    !evidence.references.some(reference => referenceKey(reference) === referenceKey(item))).length;
  const corrections = { classificationChanged: row.resultType !== output.resultType,
    matchScoreChanged: row.match?.score !== output.match?.score,
    unsupportedBrandRemoved: Boolean(row.relatedSignal?.relatedBrand && !output.relatedSignal?.relatedBrand
      || row.match?.signals?.brandMatch && !output.match?.signals?.brandMatch),
    removedReferenceCount,
    confidenceChanged: row.marketConfidenceScore !== output.marketConfidenceScore || row.periodMarketConfidenceScore !== output.periodMarketConfidenceScore };
  output.qualityProjection = { version: VERSION, scope: "stored_evidence_only", sourceResultHash: hash(row),
    sourceResultType: row.resultType, sourceRelatedProductCount: row.relatedSignal?.relatedProductCount ?? null,
    displayWarning: [...new Set(warnings)].join(" / "),
    brandStatus: evidence.verifiedBrand ? "verified" : "unverified", corrections, sourcePreserved: true,
    projectedResultHash: hash(output) };
  return output;
}
function projectJob(job) {
  if (!job || !Array.isArray(job.results) || job.qualityProjection?.version === VERSION) return job;
  const results = job.results.map(projectResult);
  return { ...job, results, qualityProjection: { version: VERSION, scope: "stored_evidence_only",
    sourceResultsHash: job.resultsHash || hash(job.results), projectedResultsHash: hash(results),
    changedCount: results.filter(row => Object.values(row.qualityProjection?.corrections || {}).some(Boolean)).length,
    presentationChangedCount: results.filter((row, index) => displaySignature(row) !== displaySignature(job.results[index])).length,
    sourcePreserved: true } };
}
function displaySignature(row) {
  return JSON.stringify([row.resultType, row.match?.score, row.match?.reason, row.match?.uniqueIdentification,
    row.match?.identificationScope, row.relatedSignal, row.marketConfidenceScore, row.marketConfidenceReasons,
    row.periodMarketConfidenceScore, row.periodMarketConfidenceReasons]);
}
function projectSnapshot(snapshot, job) {
  if (!snapshot || !Array.isArray(snapshot.items) || snapshot.qualityProjection?.version === VERSION) return snapshot;
  const sameJob = job?.jobId === snapshot.jobId && job.mode === snapshot.mode && Array.isArray(job.results)
    && ["startDate", "endDate", "queryStartDate"].every(key => !job[key] || !snapshot[key] || job[key] === snapshot[key])
    && job.results.length === snapshot.items.length && job.results.every((row, index) => row.keyword === snapshot.items[index].keyword);
  const fullRows = snapshot.items.every(row => row.match || row.relatedSignal);
  if (!sameJob && !fullRows) return { ...snapshot, qualityProjection: { version: VERSION,
    status: "source_job_unavailable", displayWarning: "원본 분석 결과를 읽지 못해 상품·브랜드 근거 재검증 불가 · 저장된 요약 표시", sourcePreserved: true } };
  const projected = sameJob ? projectJob(job).results : snapshot.items.map(projectResult);
  const items = snapshot.items.map((item, index) => {
    const row = projected[index];
    if (item.match || item.relatedSignal) return row;
    return { ...item, resultType: row.resultType, relatedBrand: row.relatedSignal?.relatedBrand || row.match?.item?.brand || "",
      matchScore: Number(row.match?.score || 0), productMatchScore: Number(row.match?.score || 0),
      marketConfidenceScore: row.marketConfidenceScore ?? null, marketConfidenceGrade: row.marketConfidenceGrade || null,
      marketConfidenceReasons: row.marketConfidenceReasons || [], qualityProjection: row.qualityProjection };
  });
  return { ...snapshot, items, qualityProjection: { version: VERSION, scope: "stored_evidence_only",
    sourceSnapshotHash: hash(snapshot), projectedItemsHash: hash(items), sourcePreserved: true } };
}
module.exports = { VERSION, projectResult, projectJob, projectSnapshot };
