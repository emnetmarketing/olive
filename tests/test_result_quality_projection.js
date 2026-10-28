const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { performance } = require("node:perf_hooks");
const { projectResult, projectJob, projectSnapshot } = require("../netlify/functions/result-quality-projection");
const { evaluateMatch } = require("../netlify/functions/product-matching");
const { digest } = require("../netlify/functions/period-publication");

function matched(keyword, item, override = {}) {
  return { item, ...evaluateMatch(keyword, item), matchingCandidateCount: 1, uniqueIdentification: false, additionalMatches: [], ...override };
}
function row(keyword, match, overrides = {}) {
  return { keyword, resultType: "domain_related_signal", match, estimatedSurgeCount: 9252, estimatedBaseline: 5099,
    riseRate: 181.4, peakRelativeLiftPct: 181.4, peakDailyLift: 9252.31, latestDataDate: "2026-10-26",
    trendFetchedAt: "2026-10-27T09:14:57.801Z", absoluteSurgePassed: true, relativeSurgePassed: true,
    trendSeries: [{ period: "2026-10-26", ratio: 100, estimated: 14350 }],
    marketConfidenceScore: 50, marketConfidenceGrade: "medium",
    marketConfidenceReasons: ["NAVER 절대·상대 급등 확인", "제품라인·성분·제품군 관련성 확인", "Search Ad 저장 클릭 관측 참고 · 집계기간 미확인"],
    marketConfidenceComponents: { naver: 36, relevance: 10, youtube: 0, searchAd: 4, news: 0 }, ...overrides };
}
function nail() {
  return row("네일", matched("네일", { product: "옵티팜 네일 리페어 패치 40매", brand: "" }), { relatedSignal: {
    signalType: "product_line", relatedBrand: "", relatedProductCount: 54,
    referenceProducts: [{ product: "티타니아 풋앤네일밤 100ml", brand: "" }, { product: "닥터지 블랙스네일 크림", brand: "" }],
    reason: "네일 관련 활성 상품 54건 확인", judgment: "제품/제품라인 관련 급등" } });
}
function freeze(value) { if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }
function loadHandler(name, mocks) {
  const file = path.resolve(__dirname, `../netlify/functions/${name}.js`), req = createRequire(file), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), { module, exports: module.exports, require: name => mocks[name] || req(name), console }, { filename: file });
  return module.exports.handler;
}

test("saved reference projection rejects interior substring while preserving semantic nail products and unknown full total", () => {
  const input = freeze(nail()), before = JSON.stringify(input), output = projectResult(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(output.relatedSignal.referenceProducts.map(item => item.product), ["티타니아 풋앤네일밤 100ml", "옵티팜 네일 리페어 패치 40매"]);
  assert.equal(output.relatedSignal.relatedProductCount, null);
  assert.equal(output.relatedSignal.verifiedReferenceCount, 2);
  assert.equal(output.relatedSignal.countScope, "stored_references_only");
  assert.equal(output.resultType, "domain_related_signal");
  assert.equal(output.marketConfidenceScore, input.marketConfidenceScore);
  assert.match(output.relatedSignal.reason, /전체 상품 수 미재집계/);
  assert.equal(output.qualityProjection.sourceRelatedProductCount, 54);
});

test("ingredient plus concentration retains product_match and non-exclusive 90 score for two saved products", () => {
  const keyword = "나이아신아마이드20", first = { product: "주미소 나이아신아마이드 20% 세럼 40ml", brand: "" };
  const second = { product: "더마팩토리 나이아신아마이드20% 세럼 30ml", brand: "" };
  const input = row(keyword, matched(keyword, first, { score: 90, matchingCandidateCount: 2, additionalMatches: [matched(keyword, second, { score: 90 })] }), {
    resultType: "product_match", marketConfidenceScore: 54, marketConfidenceComponents: { naver: 26, relevance: 21, searchAd: 4, news: 3 },
    marketConfidenceReasons: ["NAVER 절대 급등 확인", "상품 직접 매칭 90%", "관련 뉴스 근거 확인"] });
  const output = projectResult(input);
  assert.equal(output.resultType, "product_match"); assert.equal(output.match.score, 90);
  assert.equal(output.match.matchingCandidateCount, 2); assert.equal(output.match.uniqueIdentification, false);
  assert.equal(output.match.identificationScope, "ingredient_concentration");
  assert.equal(output.match.additionalMatches[0].score, 90);
  assert.equal(output.marketConfidenceScore, 54);
  assert.match(output.marketConfidenceReasons[1], /특정 브랜드 단독 식별 아님/);
});

test("inferred prefix is not brand proof; only relevance points are removed in Instant and Period views", () => {
  const keyword = "가상브랜드", item = { product: "가상브랜드 크림 40ml", brand: "" };
  const input = row(keyword, matched(keyword, item, { score: 38 }), {
    resultType: "brand_or_category_signal", relatedSignal: { relatedBrand: keyword, relatedProductCount: 12, referenceProducts: [item] },
    marketConfidenceScore: 58, marketConfidenceComponents: { naver: 36, relevance: 14, youtube: 8, searchAd: 0 },
    marketConfidenceReasons: ["NAVER 절대·상대 급등 확인", "브랜드 직접 관련성 확인", "YouTube 언급 증가 +2"],
    periodMarketConfidenceScore: 40, periodMarketConfidenceGrade: "reference",
    periodMarketConfidenceComponents: { naver: 26, relevance: 14, youtube: 0 }, periodMarketConfidenceReasons: ["NAVER 절대 급등 확인", "브랜드 직접 관련성 확인"] });
  const output = projectResult(input);
  assert.equal(output.resultType, "unverified_context_signal"); assert.equal(output.relatedSignal.relatedBrand, "");
  assert.equal(output.marketConfidenceScore, 44); assert.equal(output.periodMarketConfidenceScore, 26);
  assert.equal(output.marketConfidenceComponents.youtube, 8); assert.equal(output.marketConfidenceComponents.naver, 36);
  assert.deepEqual(output.marketConfidenceReasons, ["NAVER 절대·상대 급등 확인", "YouTube 언급 증가 +2"]);
  for (const field of ["estimatedSurgeCount", "riseRate", "estimatedBaseline", "peakDailyLift", "absoluteSurgePassed", "latestDataDate", "trendFetchedAt", "trendSeries"])
    assert.deepEqual(output[field], input[field]);
  assert.match(output.qualityProjection.displayWarning, /브랜드 미확인/);
});

test("verified explicit brand and a previously unique product keep their valid classification and 100 score", () => {
  const keyword = "실제브랜드 리페어 40", item = { product: "실제브랜드 리페어 40ml", brand: "실제브랜드" };
  const input = row(keyword, matched(keyword, item, { score: 100, uniqueIdentification: true }), {
    resultType: "product_match", marketConfidenceScore: 58, marketConfidenceComponents: { naver: 36, relevance: 22 } });
  const output = projectResult(input);
  assert.equal(output.resultType, "product_match"); assert.equal(output.match.score, 100);
  assert.equal(output.match.uniqueIdentification, true); assert.equal(output.marketConfidenceScore, 58);
});

test("low-intensity strong-product branch retains independent ingredient/concentration relevance without a verified brand", () => {
  const keyword = "나이아신아마이드20", item = { product: "테스트 나이아신아마이드20% 세럼", brand: "" };
  const input = row(keyword, matched(keyword, item), { resultType: "low_intensity_early_signal",
    relatedSignal: { signalType: "strong_product_match", relatedBrand: "", relatedProductCount: 1, referenceProducts: [item] },
    marketConfidenceScore: 38, marketConfidenceComponents: { naver: 26, relevance: 12 },
    marketConfidenceReasons: ["NAVER 상승 확인", "브랜드·제품 선행 문맥 확인"] });
  const output = projectResult(input);
  assert.equal(output.resultType, "low_intensity_early_signal"); assert.equal(output.marketConfidenceScore, 38);
  assert.equal(output.marketConfidenceComponents.relevance, 12); assert.match(output.marketConfidenceReasons[1], /상품 선행 문맥/);
});

test("ratio-only stored new-query source and strong product evidence preserve their independent 8 points", () => {
  const item = { product: "가상브랜드 크림", brand: "" }, input = row("가상브랜드", matched("가상브랜드", item), {
    resultType: "ratio_only_market_signal", sources: ["searchad-new-query"],
    relatedSignal: { signalType: "market_context", relatedBrand: "가상브랜드", relatedProductCount: 1, referenceProducts: [item] },
    marketConfidenceScore: 34, marketConfidenceComponents: { naver: 26, relevance: 8 },
    marketConfidenceReasons: ["NAVER 상승 확인", "검증된 시장·상품 문맥 확인"] });
  const output = projectResult(input);
  assert.equal(output.resultType, "ratio_only_market_signal"); assert.equal(output.marketConfidenceScore, 34);
  assert.equal(output.relatedSignal.relatedBrand, ""); assert.match(output.marketConfidenceReasons[1], /저장 Search Ad 신규 유입 근거/);
  const keyword = "나이아신아마이드20", product = { product: "테스트 나이아신아마이드20% 세럼", brand: "" };
  const strong = projectResult({ ...input, keyword, sources: [], match: matched(keyword, product), relatedSignal: { signalType: "market_context", referenceProducts: [product] } });
  assert.equal(strong.resultType, "ratio_only_market_signal"); assert.equal(strong.marketConfidenceComponents.relevance, 8);
});

test("missing score breakdown is not invented and unsupported confirmed score is withheld with an explanation", () => {
  const keyword = "가상브랜드", item = { product: "가상브랜드 크림", brand: "" };
  const input = row(keyword, matched(keyword, item), { resultType: "brand_or_category_signal", marketConfidenceComponents: null });
  const output = projectResult(input);
  assert.equal(output.marketConfidenceScore, null); assert.equal(output.marketConfidenceGrade, null);
  assert.match(output.qualityProjection.displayWarning, /점수 보정 불가/);
});

test("capped confidence is recombined from verified components, not subtracted from its capped 100", () => {
  const keyword = "가상브랜드", item = { product: "가상브랜드 크림", brand: "" };
  const input = row(keyword, matched(keyword, item), { resultType: "brand_or_category_signal", marketConfidenceScore: 100,
    marketConfidenceComponents: { naver: 36, relevance: 14, youtube: 28, searchAd: 30 } });
  const output = projectResult(input);
  assert.equal(output.marketConfidenceScore, 94); assert.equal(output.marketConfidenceComponents.youtube, 28);
  const mismatch = projectResult({ ...input, marketConfidenceScore: 80 });
  assert.equal(mismatch.marketConfidenceScore, null); assert.match(mismatch.qualityProjection.displayWarning, /합계/);
});

test("projection is deterministic, idempotent, pure and preserves source Job identity, raw hash, order and dates", () => {
  const input = freeze({ jobId: "period-fixed", mode: "period", state: "completed", resultsHash: "original-authoritative-hash",
    startDate: "2026-10-01", endDate: "2026-10-16", completedAt: "2026-10-16T07:00:35Z", resultCount: 2, results: [nail(), row("무관", null)] });
  const output = projectJob(input);
  assert.equal(output.results.length, 2); assert.equal(output.resultCount, 2);
  assert.deepEqual(output.results.map(value => value.keyword), input.results.map(value => value.keyword));
  assert.equal(output.resultsHash, input.resultsHash); assert.equal(output.qualityProjection.sourceResultsHash, input.resultsHash);
  assert.deepEqual(projectJob(input), output); assert.strictEqual(projectJob(output), output);
  assert.strictEqual(projectResult(output.results[0]), output.results[0]);
  assert.equal(output.startDate, input.startDate); assert.equal(output.endDate, input.endDate); assert.equal(output.completedAt, input.completedAt);
  assert.equal(output.qualityProjection.changedCount, 1);
  assert.notEqual(output.qualityProjection.projectedResultsHash, input.resultsHash);
  assert.equal(output.qualityProjection.projectedResultsHash, digest(output.results));
  assert.equal(projectJob({ ...input, resultsHash: undefined }).qualityProjection.sourceResultsHash, digest(input.results));
  assert.equal(output.results[0].qualityProjection.sourceResultHash, digest(input.results[0]));
});

test("compact snapshot uses exact matching Job and order, never a different period or reordered Job", () => {
  const job = { jobId: "a", mode: "instant", startDate: "2026-09-28", endDate: "2026-10-27", results: [nail()] };
  const snapshot = { jobId: "a", mode: "instant", startDate: job.startDate, endDate: job.endDate, items: [{ keyword: "네일", estimatedSurgeCount: 9252, marketConfidenceScore: 50 }] };
  const good = projectSnapshot(snapshot, job);
  assert.equal(good.items[0].qualityProjection.sourceResultHash, projectJob(job).results[0].qualityProjection.sourceResultHash);
  assert.equal(good.items[0].estimatedSurgeCount, 9252);
  for (const wrong of [{ ...job, jobId: "b" }, { ...job, endDate: "2026-09-01" }, { ...job, results: [{ keyword: "다른키워드" }] }, null]) {
    const output = projectSnapshot(snapshot, wrong);
    assert.deepEqual(output.items, snapshot.items); assert.equal(output.qualityProjection.status, "source_job_unavailable");
    assert.match(output.qualityProjection.displayWarning, /재검증 불가/);
  }
});

test("public latest/status/snapshot endpoints project the same stored Job without writes or provider requests", async () => {
  const original = freeze({ jobId: "same", mode: "period", state: "completed", resultsHash: "kept", results: [nail()], resultCount: 1 });
  const cache = { connect() {}, readJob: async () => original, readLastPartial: async () => original, readLastSuccess: async () => original };
  const snapshot = { jobId: "same", mode: "period", items: original.results };
  const mocks = { "./trend-analysis-cache": cache, "./signal-snapshot-cache": { connect() {}, readLatest: async () => snapshot } };
  const event = { httpMethod: "GET", queryStringParameters: { mode: "period", jobId: "same" } };
  const latest = JSON.parse((await loadHandler("trend-analysis-latest", mocks)(event)).body);
  const status = JSON.parse((await loadHandler("trend-analysis-status", mocks)(event)).body);
  const signal = JSON.parse((await loadHandler("signal-snapshot-latest", mocks)(event)).body);
  assert.deepEqual(latest.results, status.results); assert.deepEqual(signal.items, latest.results);
  assert.equal(latest.resultsHash, "kept"); assert.equal(original.results[0].relatedSignal.relatedProductCount, 54);
});

test("compact instant snapshot and full API agree on identity, row order and shared quality fields", async () => {
  const original = freeze({ jobId: "same-instant", mode: "instant", state: "completed", resultsHash: "kept",
    startDate: "2026-09-28", endDate: "2026-10-27", results: [nail(), { ...nail(), keyword: "네일", rank: 2 }], resultCount: 2 });
  const cache = { connect() {}, readJob: async () => original, readLastPartial: async () => original, readLastSuccess: async () => original };
  const snapshot = { jobId: original.jobId, mode: original.mode, startDate: original.startDate, endDate: original.endDate,
    items: original.results.map(row => ({ keyword: row.keyword, resultType: row.resultType, estimatedSurgeCount: row.estimatedSurgeCount,
      marketConfidenceScore: row.marketConfidenceScore, marketConfidenceReasons: row.marketConfidenceReasons, productMatchScore: row.match.score })) };
  const mocks = { "./trend-analysis-cache": cache, "./signal-snapshot-cache": { connect() {}, readLatest: async () => snapshot } };
  const event = { httpMethod: "GET", queryStringParameters: { mode: "instant", jobId: original.jobId } };
  const full = JSON.parse((await loadHandler("trend-analysis-status", mocks)(event)).body);
  const compact = JSON.parse((await loadHandler("signal-snapshot-latest", mocks)(event)).body);
  assert.equal(compact.jobId, full.jobId); assert.equal(compact.mode, full.mode);
  assert.equal(compact.startDate, full.startDate); assert.equal(compact.endDate, full.endDate);
  assert.deepEqual(compact.items.map(row => row.keyword), full.results.map(row => row.keyword));
  compact.items.forEach((item, index) => {
    const row = full.results[index];
    for (const key of ["resultType", "estimatedSurgeCount", "marketConfidenceScore", "marketConfidenceGrade", "marketConfidenceReasons", "qualityProjection"])
      assert.deepEqual(item[key], row[key]);
    assert.equal(item.productMatchScore, row.match.score);
  });
});

test("every non-quality source field and non-relevance component is preserved verbatim", () => {
  const source = nail(), result = projectResult(source);
  const changedKeys = new Set(["match", "relatedSignal", "resultType", "marketConfidenceScore", "marketConfidenceGrade", "marketConfidenceReasons", "marketConfidenceComponents",
    "periodMarketConfidenceScore", "periodMarketConfidenceGrade", "periodMarketConfidenceReasons", "periodMarketConfidenceComponents"]);
  for (const [key, value] of Object.entries(source)) if (!changedKeys.has(key)) assert.deepEqual(result[key], value);
  for (const [key, value] of Object.entries(source.marketConfidenceComponents)) if (key !== "relevance") assert.equal(result.marketConfidenceComponents[key], value);
});

test("439-row projection stays bounded with one pass, shared immutable source series, and no embedded raw-result copies", () => {
  const source = nail(), job = { jobId: "439", mode: "period", results: Array.from({ length: 439 }, (_, index) => ({ ...source, keyword: source.keyword, rank: index + 1 })) };
  const started = performance.now(), output = projectJob(job), elapsed = performance.now() - started;
  assert.equal(output.results.length, 439); assert.deepEqual(output.results.map(row => row.rank), job.results.map(row => row.rank));
  for (const row of output.results) {
    assert.strictEqual(row.trendSeries, source.trendSeries);
    assert.equal(row.qualityProjection.rawResult, undefined); assert.ok(row.relatedSignal.referenceProducts.length <= 3);
  }
  assert.ok(JSON.stringify(output).length < JSON.stringify(job).length * 2.5);
  assert.ok(elapsed < 10000, `bounded projection took ${elapsed}ms`);
});
