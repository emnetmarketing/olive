// A title prefix/repeated ad-group is lexical evidence, not a verified brand.
// Pure projection: source timestamps, keywords and source observations are retained.
const { compact } = require('./product-matching');
const VERIFIED_SOURCES = new Set(['explicit-product-brand', 'catalog-confirmed']);
function verifiedBrandEvidence(item) {
  const label = compact(item?.relatedBrand || item?.relatedExpression);
  const evidence = item?.brandEvidence;
  if (!label) return null;
  if (evidence?.verified === true && VERIFIED_SOURCES.has(evidence.source)
    && compact(evidence.label) === label) return evidence;
  const proof = (item.productEvidence || []).find(value => value?.brandVerified === true
    && value.brandEvidenceSource === 'explicit-product-brand' && compact(value.brand) === label);
  return proof ? { verified: true, source: 'explicit-product-brand', label: proof.brand } : null;
}
function hasVerifiedBrand(item) { return Boolean(verifiedBrandEvidence(item)); }
function projectLegacySourceConfidence(item) {
  if (item.sourceConfidenceQuality?.version === 1 || hasVerifiedBrand(item) || !item.relatedExpression
    || item.sourceConfidence == null || !Number.isFinite(Number(item.sourceConfidence))) return item;
  const sources = [...new Set(item.discoverySource || [])];
  if (!sources.includes('youtube')) return item;
  const records = (item.evidence || []).filter(value => value?.source === 'youtube');
  const oldScore = Number(item.sourceConfidence), evidence = records[0];
  const numeric = key => evidence?.[key] != null && Number.isInteger(Number(evidence[key])) && Number(evidence[key]) >= 0;
  // Legacy merge uses a maximum across source scores and may also add repeated
  // source bonuses. Only an exact, single-source scored record proves which
  // +12 component was present. Otherwise retain the raw value as unverified.
  if (sources.length === 1 && records.length === 1
    && ['titleHits', 'descriptionHits', 'videoCount', 'channelCount', 'confidence'].every(numeric)) {
    const base = 38 + Number(evidence.titleHits) * 14 + Number(evidence.descriptionHits) * 5
      + Math.max(0, Number(evidence.videoCount) - 1) * 12 + Math.max(0, Number(evidence.channelCount) - 1) * 12;
    if (oldScore === Number(evidence.confidence) && oldScore === Math.min(100, base + 12)) {
      const score = Math.min(100, base);
      return { ...item, sourceConfidence: score, originalSourceConfidence: oldScore,
        sourceConfidenceQuality: { version: 1, status: 'corrected_inferred_brand',
          removedBrandPoints: oldScore - score, basis: 'saved_single_youtube_scored_evidence' } };
    }
  }
  return { ...item, sourceConfidence: null, originalSourceConfidence: oldScore,
    sourceConfidenceQuality: { version: 1, status: 'unverified_legacy_brand_component',
    warning: '기존 출처 신뢰도 · 추정 브랜드 가점의 정확한 분리 근거 부족(원점수 보존)' } };
}
function projectBrandContext(item = {}) {
  const proof = verifiedBrandEvidence(item);
  if (proof) return { ...item, relatedBrand: item.relatedBrand || proof.label, brandEvidence: proof, brandContextStatus: 'verified' };
  const expression = item.relatedExpression || item.relatedBrand || '';
  return projectLegacySourceConfidence({ ...item, relatedBrand: '', relatedExpression: expression,
    brandContextStatus: expression ? 'unverified' : 'none',
    brandEvidence: { verified: false, source: expression ? 'lexical-expression' : 'none', label: null } });
}
module.exports = { hasVerifiedBrand, projectBrandContext, projectLegacySourceConfidence };
