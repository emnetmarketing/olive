const { connectLambda, getStore } = require("@netlify/blobs");
const { normalizeSearchAdObservation } = require("./search-ad-observation");

const STORE_NAME = "today-early-signals";
const KEY = "current-v1";
function connect(event) { if (event?.blobs) connectLambda(event); }
function store() { return getStore(STORE_NAME); }
function normalize(value) { return String(value || "").normalize("NFC").toLocaleLowerCase("ko-KR").replace(/[^0-9a-z가-힣]/g, ""); }
const kstDateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" });
function kstDate(value = Date.now()) { return kstDateFormatter.format(new Date(value)); }
function ratio(delta, previous) { return previous > 0 ? Math.round(delta / previous * 10000) / 100 : null; }

function buildEarlySignals(items, history, now = new Date().toISOString(), options = {}) {
  const nowMs = Date.parse(now), sixHours = 6 * 3600000;
  const historyMap = new Map((history?.items || []).map((item) => [item.normalizedKeyword, item]));
  const output = new Map();
  for (const item of items || []) {
    const key = item.normalizedKeyword || normalize(item.keyword); if (!key) continue;
    const sources = [...new Set(item.discoverySource || [])]; const previousRecord = historyMap.get(key) || {};
    const videos = (item.youtubeEvidence || []).filter((video) => Number.isFinite(Date.parse(video.publishedAt)));
    const youtubeCurrent = videos.filter((video) => nowMs - Date.parse(video.publishedAt) >= 0 && nowMs - Date.parse(video.publishedAt) < sixHours).length;
    const youtubePrevious = videos.filter((video) => nowMs - Date.parse(video.publishedAt) >= sixHours && nowMs - Date.parse(video.publishedAt) < sixHours * 2).length;
    const youtubeDelta = youtubeCurrent - youtubePrevious;
    const search = normalizeSearchAdObservation(item.searchAdEvidence || {});
    const searchDelta = search.delta;
    const firstSeenAt = item.discoveredAt || previousRecord.firstSeenAt || item.lastSeenAt || null;
    const firstSeenToday = firstSeenAt && kstDate(firstSeenAt) === kstDate(now);
    const searchObservedAt = search.observedAt || search.lastSeenAt || null;
    const searchObservationIsCurrent = !options.requireFreshSource || (Number.isFinite(Date.parse(searchObservedAt)) && kstDate(searchObservedAt) === kstDate(now));
    const youtubeTemporal = youtubeCurrent > 0; const searchTemporal = searchObservationIsCurrent && sources.includes("searchad-new-query")
      && (search.isNewlyObserved || firstSeenToday || searchDelta > 0);
    if (!youtubeTemporal && !searchTemporal) continue;
    const context = Boolean(item.relatedBrand && (item.relatedProductType || item.relatedProductLine));
    let score = 0; const reasons = [];
    if (firstSeenToday) { score += 20; reasons.push("오늘 처음 발견"); }
    if (youtubeCurrent > 0) { score += Math.min(30, youtubeCurrent * 10); reasons.push(`최근 6시간 YouTube ${youtubeCurrent}건`); }
    if (youtubeDelta > 0) { score += 10; reasons.push(`직전 6시간 대비 YouTube +${youtubeDelta}건`); }
    if (searchTemporal) { score += 20; reasons.push(search.isNewlyObserved || firstSeenToday
      ? "Search Ad 신규 발견 · 저장 광고 관측 참고" : "Search Ad 저장 관측 변화 확인"); }
    if (searchObservationIsCurrent && searchDelta > 0) { score += Math.min(20, 5 + Math.round(Math.log10(searchDelta + 1) * 5));
      reasons.push(`이전 저장 관측 대비 Search Ad 노출 +${searchDelta} · 집계기간 미확인`); }
    const temporalSources = Number(youtubeTemporal) + Number(searchTemporal);
    if (temporalSources > 1) { score += 15; reasons.push("복수 source 동시 감지"); }
    if (context) { score += 15; reasons.push(`${item.relatedBrand} · ${item.relatedProductLine || item.relatedProductType} 문맥 확인`); }
    if (Number(item.productMatchScore || 0) >= 40) { score += 10; reasons.push(`상품 일치율 ${Number(item.productMatchScore)}%`); }
    if (previousRecord.everSurged) { score += 5; reasons.push("이전 NAVER 상승 이력"); }
    score = Math.min(100, score); if (score < 25) continue;
    const signal = { keyword: item.keyword, normalizedKeyword: key, earlySignalDate: kstDate(now), detectedAt: now, firstSeenAt, lastSeenAt: item.lastSeenAt || now,
      todayEarlySignalScore: score, strength: score >= 70 ? "strong" : score >= 45 ? "rising" : "watch", reasons, sources,
      relatedBrand: item.relatedBrand || "", relatedProductType: item.relatedProductType || "", relatedProductLine: item.relatedProductLine || "",
      productMatchScore: Number(item.productMatchScore || 0), relatedProduct: item.relatedProduct || "",
      comparisons: { youtube: videos.length ? { method: "recent_6h_vs_previous_6h", current: youtubeCurrent, previous: youtubePrevious, delta: youtubeDelta, deltaRate: ratio(youtubeDelta, youtubePrevious) } : null,
        searchAd: searchObservationIsCurrent && sources.includes("searchad-new-query") ? search : null },
      previousNaverState: { everSurged: Boolean(previousRecord.everSurged), resultType: previousRecord.lastResultType || null,
        estimatedSurgeCount: previousRecord.lastEstimatedSurgeCount ?? null }, confirmation: null };
    const old = output.get(key); if (!old || signal.todayEarlySignalScore > old.todayEarlySignalScore) output.set(key, signal);
  }
  return [...output.values()].sort((a, b) => b.todayEarlySignalScore - a.todayEarlySignalScore || Date.parse(b.detectedAt) - Date.parse(a.detectedAt));
}

function mergeCache(previous, signals, now = new Date().toISOString()) {
  const history = new Map((previous?.history || []).map((item) => [`${item.earlySignalDate}:${item.normalizedKeyword}`, item]));
  for (const signal of signals || []) { const key = `${signal.earlySignalDate}:${signal.normalizedKeyword}`; history.set(key, { ...history.get(key), ...signal, confirmation: history.get(key)?.confirmation || signal.confirmation }); }
  const cutoff = Date.parse(now) - 31 * 86400000; const records = [...history.values()].filter((item) => Date.parse(`${item.earlySignalDate}T00:00:00+09:00`) >= cutoff);
  return { version: 1, generatedAt: now, signalDate: kstDate(now), refreshIntervalHours: 6, items: records.filter((item) => item.earlySignalDate === kstDate(now)), history: records };
}

function freshness(cache, now = new Date().toISOString()) {
  const times = { youtube: cache?.sourceSuccessTimes?.youtube || null, searchAd: cache?.sourceSuccessTimes?.searchAd || null };
  const today = kstDate(now), nowMs = Date.parse(now);
  const youtubeFresh = Number.isFinite(Date.parse(times.youtube)) && nowMs - Date.parse(times.youtube) <= 6 * 3600000;
  const searchFresh = Number.isFinite(Date.parse(times.searchAd)) && kstDate(times.searchAd) === today;
  let status = !cache?.generatedAt ? "missing" : cache.signalDate !== today || (!youtubeFresh && !searchFresh) ? "stale"
    : youtubeFresh && searchFresh && !cache.sourcePartial && !(cache.sourceErrors || []).length ? "current" : "partial";
  return { signalDate: cache?.signalDate || null, generatedAt: cache?.generatedAt || null, status,
    sourceSuccessTimes: times, sourceErrors: cache?.sourceErrors || [],
    sourceObservationPolicy: cache?.sourceObservationPolicy || { searchAd: "refresh_observation_window_unspecified" } };
}

function confirmSignals(cache, traces, rows, latestDataDate) {
  if (!latestDataDate) return cache; const traceMap = new Map((traces || []).map((item) => [item.normalizedKeyword, item]));
  const resultMap = new Map((rows || []).map((item) => [normalize(item.keyword), item]));
  const update = (item) => {
    if (item.earlySignalDate >= latestDataDate || item.confirmation?.nextTrendDate >= latestDataDate) return item;
    const trace = traceMap.get(item.normalizedKeyword); if (!trace || !["valid", "empty"].includes(trace.searchTrendStatus)) return item;
    const result = resultMap.get(item.normalizedKeyword);
    return { ...item, confirmation: { nextTrendDate: latestDataDate, naverConfirmed: Boolean(result), confirmedSurge: result?.estimatedSurgeCount ?? null,
      confirmedRelativeRise: result?.peakRelativeLiftPct ?? null, resultType: result?.resultType || null, confirmedAt: new Date().toISOString() } };
  };
  const history = (cache?.history || []).map(update); const byKey = new Map(history.map((item) => [`${item.earlySignalDate}:${item.normalizedKeyword}`, item]));
  return { ...cache, history, items: (cache?.items || []).map((item) => byKey.get(`${item.earlySignalDate}:${item.normalizedKeyword}`) || item) };
}
function projectStoredSignal(signal) {
  const raw = signal?.comparisons?.searchAd;
  if (!raw) return signal;
  const comparison = normalizeSearchAdObservation(raw, { firstSeenAt: signal.firstSeenAt });
  const unverified = comparison.comparisonStatus === "unavailable" && (raw.previous != null || raw.previousClicks != null
    || Number(raw.delta || 0) > 0 || Number(raw.clickDelta || 0) > 0);
  const reasons = (signal.reasons || []).filter(reason => !(comparison.comparisonStatus === "unavailable"
    && /Search Ad/.test(reason) && /노출|클릭.*증가|증가/.test(reason)))
    .map(reason => reason === "Search Ad 신규 유입" ? "Search Ad 저장 광고 관측 참고 · 집계기간 미확인" : reason);
  if (unverified) reasons.push("Search Ad 이전 관측 없음 · 비교 불가");
  return { ...signal, comparisons: { ...signal.comparisons, searchAd: comparison }, reasons: [...new Set(reasons)],
    ...(unverified ? { scoreVerificationStatus: "legacy_unverified_comparison",
      scoreWarning: "기존 저장 점수 · 이전 Search Ad 비교 미검증(점수 재계산 안 됨)" } : {}) };
}
function projectCache(cache) {
  return { ...cache, items: (cache.items || []).map(projectStoredSignal), history: (cache.history || []).map(projectStoredSignal) };
}
async function readCache() { return await store().get(KEY, { type: "json" }).catch(() => null) || { version: 1, items: [], history: [] }; }
async function writeCache(value) { await store().setJSON(KEY, value); return value; }
module.exports = { connect, readCache, writeCache, buildEarlySignals, mergeCache, confirmSignals, freshness, normalize, kstDate, projectStoredSignal, projectCache, STORE_NAME, KEY };
