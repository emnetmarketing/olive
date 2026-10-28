const assert = require('node:assert/strict');
const test = require('node:test');
const { hasEvidenceTerm, brandEvidence, buildVerifiedBrandCatalog, buildProductIndex, findBestMatch, evaluateMatch } = require('../netlify/functions/product-matching');
const analysis = require('../netlify/functions/trend-analysis-background')._test;

test('interior syllable collisions are not product evidence; legitimate compounds remain usable', () => {
  for (const value of ['스네일 크림', '블랙스네일 앰플마스크', '닥터지 로얄 블랙스네일 크림']) {
    assert.equal(hasEvidenceTerm(value, '네일'), false, value);
  }
  for (const value of ['네일 리페어 패치', '젤네일', '네일아트', '티타니아 풋앤네일밤100ml']) {
    assert.equal(hasEvidenceTerm(value, '네일'), true, value);
  }
  // The rule also rejects other accidental suffixes, rather than blacklisting
  // one query or one product. A known joined product compound is still valid.
  assert.equal(hasEvidenceTerm('튤립 향수', '립'), false);
  assert.equal(hasEvidenceTerm('알밤', '밤'), false);
  assert.equal(hasEvidenceTerm('립밤', '립'), true);
  assert.equal(hasEvidenceTerm('블러파우더', '파우더'), true);
  assert.equal(hasEvidenceTerm('트윈 립', '트윈립'), true);
  assert.equal(hasEvidenceTerm('사전트윈립', '트윈립'), false);
});

test('saved nail reference failure reproduces without changing NAVER metrics', () => {
  // Read-only saved-result reproduction: the previous related-products list
  // selected black-snail products because the Korean title contains "네일".
  const products = [
    { product: '옵티팜 네일 리페어 패치 40매', brand: '', productId: 'nail-patch' },
    { product: '티타니아 풋앤네일밤100ml', brand: '', productId: 'nail-balm' },
    { product: '닥터지 로얄 블랙스네일 앰플마스크', brand: '', productId: 'snail-mask' },
    { product: '닥터지 블랙스네일 옴므 크림', brand: '', productId: 'snail-cream' },
  ];
  const candidate = { keyword: '네일', category: 'beauty', estimatedSurgeCount: 7031,
    relativeLiftPct: 420, peakDailyLift: 7031, latestDataDate: '2026-10-26' };
  const before = structuredClone(candidate);
  const match = findBestMatch(candidate.keyword, products, buildProductIndex(products));
  const signal = analysis.buildDomainRelatedSignal(candidate, match, products);
  assert.equal(signal.relatedProductCount, 2);
  assert.deepEqual(signal.referenceProducts.map(item => item.productId), ['nail-patch', 'nail-balm']);
  assert.equal(signal.referenceProducts.some(item => item.product.includes('스네일')), false);
  assert.deepEqual(candidate, before);
});

test('repeated title prefixes and ad groups never establish a verified brand', () => {
  for (const [prefix, type, query] of [['아이', '유산균', '아이유산균'], ['맛있는', '영양제', '맛있는영양제'], ['워터', '선크림', '워터선크림']]) {
    const products = [
      { product: `${prefix} ${type} 30정`, brand: '', adGroupId: 'a' },
      { product: `${prefix} ${type} 60정`, brand: '', adGroupId: 'b' },
    ];
    const index = buildProductIndex(products);
    assert.equal(index.verifiedBrands.size, 0);
    assert.equal(index.brandPositions.size, 0);
    const match = evaluateMatch(query, products[0], index);
    assert.equal(match.signals.brandMatch, false, query);
    assert.equal(match.signals.brandVerified, false, query);
    assert.equal(match.signals.brandEvidenceSource, 'inferred-prefix', query);
    assert.equal(analysis.buildBrandOrCategorySignal({ keyword: query, category: 'health' }, { ...match, item: products[0] }, products), null);
    assert.equal(brandEvidence(products[0], index).verified, false);
  }
});

test('explicit product brand or independent explicit catalogue corroboration remains verified', () => {
  const products = [
    { product: '라카 퍼펙트 트윈 립', brand: '라카', productId: 'explicit' },
    { product: '라카 프루티 글램 틴트', brand: '', productId: 'catalog-confirmed' },
    { product: '다른라카 퍼펙트 크림', brand: '', productId: 'substring-only' },
  ];
  const catalog = buildVerifiedBrandCatalog(products);
  assert.equal(brandEvidence(products[0], catalog).source, 'explicit');
  assert.equal(brandEvidence(products[1], catalog).source, 'catalog-confirmed');
  assert.equal(brandEvidence(products[2], catalog).verified, false);
  const index = buildProductIndex(products);
  const match = findBestMatch('라카', products, index);
  assert.equal(match.signals.brandMatch, true);
  const signal = analysis.buildBrandOrCategorySignal({ keyword: '라카', category: 'beauty' }, match, products);
  assert.deepEqual(signal.referenceProducts.map(item => item.productId), ['explicit', 'catalog-confirmed']);
  assert.equal(signal.brandVerified, true);
});

test('legacy discovery relatedBrand text is not a verified analysis context', () => {
  const candidate = analysis.marketCandidateForAnalysis({ keyword: '아이', relatedBrand: '아이', relatedProductType: '크림',
    discoverySource: ['product-cache'], monthlySearchStatus: 'available', monthlyTotalSearches: 100 });
  assert.equal(candidate.relatedBrand, '');
  assert.equal(candidate.relatedExpression, '아이');
  assert.equal(candidate.brandEvidence.verified, false);
  const products = [{ product: '아이 크림', brand: '' }];
  const match = findBestMatch(candidate.keyword, products, buildProductIndex(products));
  assert.equal(analysis.classifySurgeResult(candidate, match, products, 40).resultType, null);
  const verified = analysis.marketCandidateForAnalysis({ keyword: '라카', relatedBrand: '라카', relatedProductType: '립',
    brandEvidence: { verified: true, source: 'explicit-product-brand', label: '라카' }, discoverySource: ['product-cache'] });
  assert.equal(verified.relatedBrand, '라카');
  assert.equal(verified.brandEvidence.verified, true);
});

test('explicit brand fields remain valid even when their label is also a descriptive word', () => {
  for (const label of ['워터', '아이', '프리미엄', '크림']) {
    const products = [{ brand: label, product: `${label} 보습 세럼` }, { brand: '', product: `${label} 수분 로션` }];
    const index = buildProductIndex(products);
    assert.equal(brandEvidence(products[0], index).verified, true, label);
    assert.equal(brandEvidence(products[1], index).source, 'catalog-confirmed', label);
    assert.equal(index.brandPositions.has(label), true, label);
    assert.equal(evaluateMatch(label, products[0], index).signals.brandMatch, true, label);
  }
});

test('matching quality checks are deterministic, local-only projections', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('External API not allowed'); };
  try {
    const products = [{ product: '옵티팜 네일 리페어 패치 40매', brand: '' }, { product: '블랙스네일 크림', brand: '' }];
    const input = JSON.stringify(products);
    const index = buildProductIndex(products);
    const first = findBestMatch('네일', products, index);
    assert.deepEqual(findBestMatch('네일', products, index), first);
    analysis.buildDomainRelatedSignal({ keyword: '네일', category: 'beauty' }, first, products);
    assert.equal(JSON.stringify(products), input);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previousFetch; }
});
