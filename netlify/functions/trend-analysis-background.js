const { connect, readJob, writeJob } = require("./trend-analysis-cache");
const { readCandidateCache } = require("./keyword-candidate-cache");
const { readCache: readProductCache } = require("./search-ad-cache");

const API_HUB = "https://naverapihub.apigw.ntruss.com";
const CATEGORY_IDS = { beauty: "50000002", health: "50000023" };
const MAX_ACTIVE_CANDIDATES = 5000;

function chunks(values, size) { const out = []; for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size)); return out; }
async function responseJson(response, name) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${name} 호출 실패: HTTP ${response.status} · ${payload.errMsg || payload.errorMessage || payload.message || "응답 오류"}`);
  return payload;
}
async function api(path, { method = "GET", params, body } = {}) {
  const id = String(process.env.NAVER_CLIENT_ID || "").trim();
  const secret = String(process.env.NAVER_CLIENT_SECRET || "").trim();
  if (!id || !secret) throw new Error("NAVER API HUB 인증정보가 없습니다.");
  const url = new URL(path, API_HUB);
  Object.entries(params || {}).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await fetch(url, { method, headers: {
    "X-NCP-APIGW-API-KEY-ID": id, "X-NCP-APIGW-API-KEY": secret,
    ...(body ? { "Content-Type": "application/json" } : {})
  }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) });
  return responseJson(response, path);
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
function estimate(data, monthly, startDate) {
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
    points = points.slice(-30);
  }
  const sum = points.reduce((total, point) => total + point.ratio, 0);
  return points.map((point) => ({ ...point, estimated: sum > 0 ? monthly * point.ratio / sum : 0 }));
}
function periodMetrics(series, startDate, endDate) {
  const selected = series.filter((point) => point.period >= startDate && point.period <= endDate);
  const n = selected.length; const window = n <= 3 ? 1 : n <= 7 ? 2 : n <= 14 ? 3 : 7;
  const baseline = median(selected.slice(0, window).map((point) => point.estimated));
  const recent = average(selected.slice(-window).map((point) => point.estimated));
  let peakLift = 0, peakValue = 0;
  for (let i = window; i < n; i += 1) {
    const before = median(selected.slice(Math.max(0, i - window), i).map((point) => point.estimated));
    const after = average(selected.slice(i, Math.min(n, i + window)).map((point) => point.estimated));
    peakLift = Math.max(peakLift, after - before); peakValue = Math.max(peakValue, after);
  }
  const endLift = recent - baseline;
  return { baseline, latest: recent, peakValue: Math.max(peakValue, ...selected.map((point) => point.estimated), 0), surgeCount: Math.max(0, endLift, peakLift), endLift, peakLift, latestPeriod: selected.at(-1)?.period, series: selected };
}
function instantMetrics(series) {
  const latestPoint = series.at(-1); const baselineValues = series.slice(-8, -1).map((point) => point.estimated);
  const baseline = median(baselineValues), latest = Number(latestPoint?.estimated || 0);
  return { baseline, latest, peakValue: latest, surgeCount: Math.max(0, latest - baseline), endLift: latest - baseline, peakLift: latest - baseline, latestPeriod: latestPoint?.period, series: series.slice(-8) };
}
function slope(values) { if (values.length < 2) return 0; const n = values.length, sx = n * (n - 1) / 2, sy = values.reduce((a, b) => a + b, 0); let sxy = 0, sx2 = 0; values.forEach((y, x) => { sxy += x * y; sx2 += x * x; }); return (n * sxy - sx * sy) / Math.max(1, n * sx2 - sx * sx); }

exports.handler = async (event) => {
  connect(event);
  let input; try { input = JSON.parse(event.body || "{}"); } catch { return; }
  let job = await readJob(input.jobId) || input.job;
  if (!job?.jobId || job.state !== "running") return;
  const persist = async (patch) => { job = { ...job, ...patch, updatedAt: new Date().toISOString() }; await writeJob(job.jobId, job); };
  const started = Date.now();
  try {
    const [candidateCache, productCache] = await Promise.all([readCandidateCache(), readProductCache()]);
    const eligible = candidateCache.candidates.filter((item) => Number(item.monthlyTotalSearches || 0) >= job.surgeThreshold)
      .sort((a, b) => Number(b.impressions30d || 0) - Number(a.impressions30d || 0) || Number(b.monthlyTotalSearches || 0) - Number(a.monthlyTotalSearches || 0))
      .slice(0, MAX_ACTIVE_CANDIDATES);
    if (!eligible.length) throw new Error("급등수 기준을 계산할 수 있는 월간 검색량 후보가 없습니다.");
    await persist({ message: `검색어트렌드 조회 중 · 0 / ${eligible.length.toLocaleString("ko-KR")}`, totalCandidates: eligible.length, progress: 5 });
    const trendMap = new Map(); let processed = 0;
    for (const requestBatch of chunks(chunks(eligible, 5), 5)) {
      const results = await Promise.all(requestBatch.map((batch) => api("/search-trend/v1/search", { method: "POST", body: {
        startDate: job.queryStartDate, endDate: job.endDate, timeUnit: "date",
        keywordGroups: batch.map((item) => ({ groupName: item.keyword, keywords: [item.keyword] }))
      } })));
      for (const payload of results) for (const result of payload.results || []) trendMap.set(result.title, result.data || []);
      processed += requestBatch.reduce((sum, batch) => sum + batch.length, 0);
      await persist({ message: `검색어트렌드 조회 중 · ${processed.toLocaleString("ko-KR")} / ${eligible.length.toLocaleString("ko-KR")}`, progress: 5 + Math.round(processed / eligible.length * 35) });
    }
    await persist({ message: "키워드별 쇼핑 트렌드 조회 중", progress: 42 });
    const shoppingMap = new Map(); processed = 0;
    for (const category of ["beauty", "health"]) {
      const categoryItems = eligible.filter((item) => item.category === category);
      for (const requestBatch of chunks(chunks(categoryItems, 5), 5)) {
        const results = await Promise.all(requestBatch.map((batch) => api("/shopping/v1/category/keywords", { method: "POST", body: {
          startDate: job.queryStartDate, endDate: job.endDate, timeUnit: "date", category: CATEGORY_IDS[category],
          keyword: batch.map((item) => ({ name: item.keyword, param: [item.keyword] }))
        } })));
        for (const payload of results) for (const result of payload.results || []) shoppingMap.set(result.title, result.data || []);
        processed += requestBatch.reduce((sum, batch) => sum + batch.length, 0);
        await persist({ message: `키워드별 쇼핑 트렌드 조회 중 · ${processed.toLocaleString("ko-KR")} / ${eligible.length.toLocaleString("ko-KR")}`, progress: 42 + Math.round(processed / eligible.length * 30) });
      }
    }
    await persist({ message: "추정 급등수 계산 및 상품 매칭 중", progress: 75 });
    const productIndex = buildIndex(productCache.items);
    const rows = [];
    for (const candidate of eligible) {
      const series = estimate(trendMap.get(candidate.keyword), Number(candidate.monthlyTotalSearches), job.queryStartDate);
      if (!series.length) continue;
      const metrics = job.mode === "instant" ? instantMetrics(series) : periodMetrics(series, job.startDate, job.endDate);
      if (metrics.surgeCount < job.surgeThreshold) continue;
      const match = bestMatch(candidate.keyword, productCache.items, productIndex);
      if (!match || match.score < job.matchThreshold) continue;
      const shopping = shoppingMap.get(candidate.keyword) || [];
      const shoppingRatios = shopping.map((point) => Number(point.ratio || 0));
      rows.push({ keyword: candidate.keyword, category: candidate.category, monthlySearches: candidate.monthlyTotalSearches,
        estimatedBaseline: Math.round(metrics.baseline), estimatedLatest: Math.round(metrics.latest), estimatedPeak: Math.round(metrics.peakValue),
        estimatedSurgeCount: Math.round(metrics.surgeCount), riseRate: metrics.baseline > 0 ? (metrics.surgeCount / metrics.baseline * 100) : null,
        endLift: Math.round(metrics.endLift), peakLift: Math.round(metrics.peakLift), latestDataDate: metrics.latestPeriod,
        trendSeries: metrics.series, trendSlope: slope(metrics.series.map((point) => point.estimated)),
        shoppingTrend: shopping, shoppingRise: shoppingRatios.length > 1 ? shoppingRatios.at(-1) - median(shoppingRatios.slice(-8, -1)) : 0,
        newSearchAdQuery: candidate.sources.includes("searchad-query"), searchAdImpressions30d: candidate.impressions30d,
        match, sources: candidate.sources, news: null });
    }
    rows.sort((a, b) => b.estimatedSurgeCount - a.estimatedSurgeCount || b.shoppingRise - a.shoppingRise || b.trendSlope - a.trendSlope);
    await persist({ message: "상위 급등 검색어 뉴스 확인 중", progress: 90 });
    const newsResults = await Promise.allSettled(rows.slice(0, 20).map(async (row) => {
      const payload = await api("/search/v1/news", { params: { query: row.keyword, display: 3, start: 1, sort: "date" } });
      return { keyword: row.keyword, total: Number(payload.total || 0), items: (payload.items || []).slice(0, 3) };
    }));
    newsResults.forEach((result) => { if (result.status === "fulfilled") { const row = rows.find((item) => item.keyword === result.value.keyword); if (row) row.news = result.value; } });
    const latestDataDate = [...trendMap.values()].flatMap((data) => (data || []).map((point) => point.period)).filter(Boolean).sort().at(-1) || null;
    await persist({ state: "completed", message: "분석 완료", progress: 100, completedAt: new Date().toISOString(), durationMs: Date.now() - started,
      latestDataDate, searchAdCount: productCache.items.length, analyzedCandidateCount: eligible.length, resultCount: rows.length, results: rows, errors: [] });
  } catch (error) {
    await persist({ state: "failed", message: "분석 실패", failedAt: new Date().toISOString(), durationMs: Date.now() - started, errors: [error.message] });
  }
};

exports._test = { estimate, periodMetrics, instantMetrics, similarity, buildIndex, bestMatch, median };
