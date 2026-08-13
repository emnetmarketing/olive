const { connect, readCandidateCache } = require("./keyword-candidate-cache");
const { estimate, periodMetrics, median } = require("./trend-analysis-background")._test;

const API_HUB = "https://naverapihub.apigw.ntruss.com";
const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  body: JSON.stringify(body)
});

function normalizeKeyword(value) {
  return String(value || "").toLocaleLowerCase("ko-KR").replace(/[^0-9a-z가-힣]/g, "");
}

function isoDate(date) { return date.toISOString().slice(0, 10); }
function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }

function validateDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

async function fetchTrend(keyword, queryStartDate, endDate) {
  const id = String(process.env.NAVER_CLIENT_ID || "").trim();
  const secret = String(process.env.NAVER_CLIENT_SECRET || "").trim();
  if (!id || !secret) throw new Error("NAVER API HUB 인증정보가 없습니다.");
  const response = await fetch(`${API_HUB}/search-trend/v1/search`, {
    method: "POST",
    headers: {
      "X-NCP-APIGW-API-KEY-ID": id,
      "X-NCP-APIGW-API-KEY": secret,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      startDate: queryStartDate,
      endDate,
      timeUnit: "date",
      keywordGroups: [{ groupName: keyword, keywords: [keyword] }]
    }),
    signal: AbortSignal.timeout(25000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`검색어트렌드 호출 실패: HTTP ${response.status} · ${payload.errMsg || payload.errorMessage || payload.message || "응답 오류"}`);
  }
  return { status: response.status, data: payload.results?.[0]?.data || [] };
}

function calculationRows(series, startDate, endDate) {
  const selected = series.filter((point) => point.period >= startDate && point.period <= endDate);
  return selected.map((point) => {
    const index = series.findIndex((item) => item.period === point.period);
    const prior = index >= 0 ? series.slice(Math.max(0, index - 7), index).map((item) => item.estimated) : [];
    const baseline = median(prior);
    return { ...point, baseline: prior.length ? baseline : null, lift: prior.length ? point.estimated - baseline : null };
  });
}

function buildDiagnostic(keyword, candidate, trend, startDate, endDate, queryStartDate) {
  const monthlyTotalSearches = Number(candidate.monthlyTotalSearches || 0);
  const series = estimate(trend.data, monthlyTotalSearches, queryStartDate);
  const metrics = periodMetrics(series, startDate, endDate);
  const rows = calculationRows(series, startDate, endDate);
  const peakRow = rows.filter((row) => row.lift !== null).sort((a, b) => b.lift - a.lift)[0] || null;
  return {
    keyword,
    normalizedKeyword: normalizeKeyword(keyword),
    apiHttpStatus: trend.status,
    requestedPeriod: { startDate, endDate },
    apiQueryPeriod: { startDate: queryStartDate, endDate },
    monthlyPcSearches: Number(candidate.monthlyPcSearches || 0),
    monthlyMobileSearches: Number(candidate.monthlyMobileSearches || 0),
    monthlyTotalSearches,
    ratioSum: series.reduce((sum, point) => sum + Number(point.ratio || 0), 0),
    windowDays: rows.length <= 3 ? 1 : rows.length <= 7 ? 2 : rows.length <= 14 ? 3 : 7,
    rows,
    peak: peakRow ? {
      date: peakRow.period,
      ratio: peakRow.ratio,
      estimatedSearches: peakRow.estimated,
      baseline: peakRow.baseline,
      peakLift: peakRow.lift
    } : null,
    periodBaseline: metrics.baseline,
    periodLatestAverage: metrics.latest,
    peakLift: metrics.peakLift,
    peakDailyLift: metrics.peakDailyLift,
    sustainedLift: metrics.sustainedLift,
    endLift: metrics.endLift,
    estimatedSurgeCount: metrics.surgeCount,
    latestDataDate: metrics.latestPeriod
  };
}

exports.handler = async (event) => {
  connect(event);
  if (event.httpMethod !== "POST") return json(405, { error: "POST 요청만 허용됩니다." });
  try {
    const input = JSON.parse(event.body || "{}");
    const keywords = [...new Set((Array.isArray(input.keywords) ? input.keywords : [input.keyword])
      .map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 2);
    const startDate = String(input.startDate || "").trim();
    const endDate = String(input.endDate || "").trim();
    if (!keywords.length || !validateDate(startDate) || !validateDate(endDate) || startDate > endDate) {
      return json(400, { error: "검색어와 올바른 시작일/종료일이 필요합니다." });
    }
    const queryStart = new Date(`${endDate}T00:00:00Z`);
    queryStart.setUTCDate(queryStart.getUTCDate() - 30);
    const queryStartDate = isoDate(queryStart);
    const cache = await readCandidateCache();
    const byNormalized = new Map((cache.candidates || []).map((item) => [normalizeKeyword(item.keyword), item]));
    const diagnostics = [];
    for (const keyword of keywords) {
      const candidate = byNormalized.get(normalizeKeyword(keyword));
      if (!candidate || candidate.monthlyTotalSearches === null || candidate.monthlyTotalSearches === undefined) {
        return json(404, { error: `월간검색량이 있는 후보를 찾지 못했습니다: ${keyword}` });
      }
      const trend = await fetchTrend(keyword, queryStartDate, endDate);
      diagnostics.push(buildDiagnostic(keyword, candidate, trend, startDate, endDate, queryStartDate));
    }
    return json(200, { readOnly: true, calculationSource: "trend-analysis-background._test", diagnostics });
  } catch (error) {
    return json(500, { error: error.message || "Trend 진단 실패" });
  }
};

exports._test = { normalizeKeyword, calculationRows, buildDiagnostic };
