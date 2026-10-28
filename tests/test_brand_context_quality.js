const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../netlify/functions/market-discovery-core');
const early = require('../netlify/functions/today-early-signal-cache');
const { projectBrandContext } = require('../netlify/functions/brand-context');
const now = '2026-10-27T18:01:59.220Z';
const cases = [
  ['아이유산균', '아이', '유산균', '유산균 추천 전에 수험생 아이 유산균, 균수 많으면 더 비쌀까?'],
  ['맛있는영양제', '맛있는', '영양제', '맛있는 영양제 추천 30대 여성이 뽑은 비타민'],
  ['워터선크림', '워터', '선크림', '펠드아포테케 에어리 워터 선크림 솔직 후기']
];
function stored(keyword, expression, type) {
  return { keyword, relatedBrand: expression, relatedProductType: type, relatedProduct: '', productMatchScore: 0,
    earlySignalDate: '2026-10-28', detectedAt: now, firstSeenAt: '2026-10-27T18:01:36.886Z',
    todayEarlySignalScore: 55, strength: 'rising', reasons: ['오늘 처음 발견', '최근 6시간 YouTube 1건',
      '직전 6시간 대비 YouTube +1건', `${expression} · ${type} 문맥 확인`],
    comparisons: { youtube: { current: 1, previous: 0, delta: 1, deltaRate: null }, searchAd: null } };
}
for (const [keyword, expression, type, title] of cases) {
  test(`${keyword}: title prefix is not verified brand, stored 55 becomes 40 without changing source`, () => {
    const source = stored(keyword, expression, type), before = JSON.stringify(source);
    const result = early.projectStoredSignal(source);
    assert.equal(result.relatedBrand, ''); assert.equal(result.relatedExpression, expression);
    assert.equal(result.brandContextStatus, 'unverified'); assert.equal(result.todayEarlySignalScore, 40);
    assert.equal(result.strength, 'watch'); assert.match(result.reasons.join(' '), /브랜드 미확인/);
    assert.equal(result.detectedAt, now); assert.deepEqual(result.comparisons, source.comparisons);
    assert.equal(JSON.stringify(source), before); assert.deepEqual(early.projectStoredSignal(result), result);
    const candidates = core.youtubeCandidates([{ videoId: keyword, channelId: 'fixture', title, description: title,
      publishedAt: '2026-10-27T13:00:00Z' }], []);
    const candidate = candidates.find(row => row.keyword === keyword);
    assert.ok(candidate); assert.equal(candidate.relatedBrand, ''); assert.equal(candidate.relatedExpression, expression);
  });
}
test('explicit brand is retained even when its label is a generic-looking word', () => {
  const products = [{ brand: '워터', product: '워터 선크림', adGroupId: 'one' }];
  const items = core.youtubeCandidates([{ videoId: 'v', channelId: 'c', title: '워터 선크림 리뷰', description: '워터 선크림', publishedAt: now }], products);
  assert.equal(items[0].relatedBrand, '워터'); assert.equal(items[0].brandEvidence.verified, true);
  const source = { ...stored('워터선크림', '워터', '선크림'), brandEvidence: items[0].brandEvidence };
  assert.equal(early.projectStoredSignal(source).todayEarlySignalScore, 55);
  assert.equal(early.projectStoredSignal(source).relatedBrand, '워터');
});
test('repetition across ad groups is lexical context only, not independent brand evidence', () => {
  const products = [{ product: '맛있는 영양제', adGroupId: 'a' }, { product: '맛있는 유산균', adGroupId: 'b' }];
  assert.equal(core.buildVerifiedBrands(products).size, 0);
  const candidate = core.productCandidates(products).find(row => row.keyword === '맛있는영양제');
  assert.ok(candidate); assert.equal(candidate.relatedBrand, ''); assert.equal(candidate.relatedExpression, '맛있는');
  assert.equal(projectBrandContext({ relatedBrand: '맛있는', productEvidence: [{ source: 'product-cache', brand: '맛있는', productCount: 20 }] }).relatedBrand, '');
});
test('new signals award brand context points only with explicit evidence', () => {
  const item = { keyword: '아이유산균', relatedBrand: '아이', relatedProductType: '유산균', discoverySource: ['youtube'],
    discoveredAt: now, youtubeEvidence: [{ publishedAt: now }] };
  const [unverified] = early.buildEarlySignals([item], { items: [] }, now);
  assert.equal(unverified.todayEarlySignalScore, 40); assert.equal(unverified.brandContextPoints, 0);
  const [verified] = early.buildEarlySignals([{ ...item, brandEvidence: { verified: true, source: 'explicit-product-brand', label: '아이' } }], { items: [] }, now);
  assert.equal(verified.todayEarlySignalScore, 55); assert.equal(verified.brandContextPoints, 15);
});
test('capped legacy score removes only unsupported brand component and does not drop rows', () => {
  const source = { ...stored('어떤크림', '어떤', '크림'), todayEarlySignalScore: 100,
    reasons: ['오늘 처음 발견', '최근 6시간 YouTube 3건', '직전 6시간 대비 YouTube +3건',
      'Search Ad 신규 발견 · 저장 광고 관측 참고', '복수 source 동시 감지', '어떤 · 크림 문맥 확인'],
    comparisons: { youtube: { current: 3, previous: 0, delta: 3 }, searchAd: null } };
  const result = early.projectStoredSignal(source);
  assert.equal(result.todayEarlySignalScore, 95); // 20+30+10+20+15, not blindly 100-15.
  const cache = { jobId: 'same', generatedAt: now, items: [source], history: [source] };
  assert.equal(early.projectCache(cache).items.length, 1); assert.equal(early.projectCache(cache).jobId, 'same');
});

test('same-expression explicit product proof survives a later lexical source merge', () => {
  const previous = { keyword: '워터선크림', normalizedKeyword: '워터선크림', relatedBrand: '워터', relatedProductType: '선크림',
    brandEvidence: { verified: true, source: 'explicit-product-brand', label: '워터' },
    productEvidence: [{ brand: '워터', brandVerified: true, brandEvidenceSource: 'explicit-product-brand' }],
    discoveredAt: '2026-10-27T00:00:00Z', youtubeEvidence: [{ publishedAt: '2026-10-27T00:00:00Z' }] };
  const incoming = { keyword: '워터선크림', normalizedKeyword: '워터선크림', relatedBrand: '', relatedExpression: '워터',
    brandEvidence: { verified: false, source: 'lexical-expression', label: null }, relatedProductType: '선크림' };
  const before = JSON.stringify([previous, incoming]);
  const [result] = core.mergeCandidates([previous], [incoming], now);
  assert.equal(result.relatedBrand, '워터'); assert.equal(result.brandEvidence.verified, true);
  assert.deepEqual(result.productEvidence, previous.productEvidence);
  assert.deepEqual(result.youtubeEvidence, previous.youtubeEvidence);
  assert.equal(result.discoveredAt, previous.discoveredAt);
  assert.equal(JSON.stringify([previous, incoming]), before);
  const conflict = projectBrandContext({ ...result, relatedBrand: '다른', relatedExpression: '워터', brandEvidence: null });
  assert.equal(conflict.relatedBrand, ''); assert.equal(conflict.brandEvidence.verified, false);
});

test('capped score with missing or contradictory YouTube observations remains unknown, not zero-filled', () => {
  const source = { ...stored('아이유산균', '아이', '유산균'), todayEarlySignalScore: 100,
    reasons: ['오늘 처음 발견', '최근 6시간 YouTube 3건', '직전 6시간 대비 YouTube +3건',
      'Search Ad 신규 발견 · 저장 광고 관측 참고', '복수 source 동시 감지', '아이 · 유산균 문맥 확인'] };
  for (const comparisons of [undefined, { youtube: null }, { youtube: { current: 0 } }]) {
    const result = early.projectStoredSignal({ ...source, comparisons });
    assert.equal(result.todayEarlySignalScore, null); assert.equal(result.originalEarlySignalScore, 100);
    assert.equal(result.strength, 'unverified'); assert.match(result.scoreWarning, /분리 불가/);
    assert.equal(result.detectedAt, now); assert.deepEqual(result.comparisons, comparisons);
  }
  assert.equal(early.projectStoredSignal({ ...stored('아이유산균', '아이', '유산균'), todayEarlySignalScore: null }).todayEarlySignalScore, null);
});

test('legacy single-source confidence removes inferred brand bonus only with exact saved evidence', () => {
  const source = { keyword: '아이유산균', normalizedKeyword: '아이유산균', relatedBrand: '아이', relatedProductType: '유산균',
    sourceConfidence: 69, discoverySource: ['youtube'], discoveredAt: now, lastSeenAt: now,
    evidence: [{ source: 'youtube', titleHits: 1, descriptionHits: 1, videoCount: 1, channelCount: 1, confidence: 69 }] };
  const before = JSON.stringify(source), result = projectBrandContext(source);
  assert.equal(result.sourceConfidence, 57); assert.equal(result.originalSourceConfidence, 69);
  assert.equal(result.sourceConfidenceQuality.removedBrandPoints, 12);
  assert.equal(result.sourceConfidenceQuality.status, 'corrected_inferred_brand');
  assert.deepEqual(result.evidence, source.evidence); assert.equal(result.discoveredAt, now); assert.equal(result.lastSeenAt, now);
  assert.deepEqual(projectBrandContext(result), result); assert.equal(JSON.stringify(source), before);
  const [merged] = core.mergeCandidates([source], [{ ...result, sourceConfidenceQuality: { version: 1, status: 'current_scored_evidence', brandPoints: 0 } }], now);
  assert.equal(merged.sourceConfidence, 57, 'legacy max must not restore the removed 12 points');
});

test('unreconstructable legacy confidence stays unknown downstream, with original score preserved', () => {
  const source = { keyword: '맛있는영양제', normalizedKeyword: '맛있는영양제', relatedBrand: '맛있는', relatedProductType: '영양제',
    sourceConfidence: 90, discoverySource: ['youtube', 'product-cache'], discoveredAt: now, lastSeenAt: now,
    evidence: [{ source: 'youtube', confidence: 90 }] };
  const result = projectBrandContext(source);
  assert.equal(result.sourceConfidence, null); assert.equal(result.originalSourceConfidence, 90);
  assert.equal(result.sourceConfidenceQuality.status, 'unverified_legacy_brand_component');
  assert.deepEqual(projectBrandContext(result), result);
  const analysis = require('../netlify/functions/trend-analysis-background')._test;
  const candidate = analysis.marketCandidateForAnalysis(source);
  assert.equal(candidate.sourceConfidence, null); assert.equal(candidate.relatedBrand, '');
  assert.equal(candidate.priorityScore, core.discoveryPriority(result));
  const [merged] = core.mergeCandidates([source], [{ ...result, sourceConfidence: 57,
    sourceConfidenceQuality: { version: 1, status: 'current_scored_evidence', brandPoints: 0 } }], now);
  assert.equal(merged.sourceConfidence, null); assert.equal(merged.originalSourceConfidence, 90);
  const rows = [source, { ...source, keyword: '두번째', normalizedKeyword: '두번째' }].map(projectBrandContext);
  assert.deepEqual(rows.map(row => row.keyword), ['맛있는영양제', '두번째']);
});

test('verified brand bonus remains intact and raw legacy context never earns the 30-point priority award', () => {
  const unverified = { keyword: '워터선크림', relatedBrand: '워터', relatedProductType: '선크림', sourceConfidence: 69,
    discoveredAt: now, discoverySource: ['youtube'] };
  const base = core.discoveryPriority({ ...unverified, relatedBrand: '' }, Date.parse(now));
  assert.equal(core.discoveryPriority(unverified, Date.parse(now)), base);
  const verified = { ...unverified, brandEvidence: { verified: true, source: 'explicit-product-brand', label: '워터' } };
  assert.equal(core.discoveryPriority(verified, Date.parse(now)), base + 30);
  assert.equal(projectBrandContext(verified).sourceConfidence, 69);
});
