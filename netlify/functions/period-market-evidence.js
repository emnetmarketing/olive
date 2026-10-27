const { calculateMarketConfidence } = require("./market-confidence");
const { normalizeSearchAdObservation } = require("./search-ad-observation");

function normalize(value) { return String(value || "").normalize("NFC").toLocaleLowerCase("ko-KR").replace(/[^0-9a-z가-힣]/g, ""); }
function numeric(value) { return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null; }
function kstDate(value) { return value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(value)) : null; }
function inclusiveDays(startDate, endDate) { return Math.max(1, Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1); }
function availability(records, expectedDays) {
  if (!records.length) return "no_data";
  return new Set(records.map((item) => item.earlySignalDate)).size < expectedDays ? "partial" : "available";
}
function ratio(delta, previous) { return previous > 0 ? Math.round(delta / previous * 10000) / 100 : null; }

function buildPeriodMarketEvidence(keyword, startDate, endDate, history = []) {
  const key = normalize(keyword); const expectedDays = inclusiveDays(startDate, endDate);
  const records = (history || []).filter((item) => item.normalizedKeyword === key
    && item.earlySignalDate >= startDate && item.earlySignalDate <= endDate)
    .sort((a, b) => a.earlySignalDate.localeCompare(b.earlySignalDate) || String(a.detectedAt || "").localeCompare(String(b.detectedAt || "")));
  const youtubeRecords = records.filter((item) => item.comparisons?.youtube);
  const youtubePairs = youtubeRecords.map((item) => ({ current: numeric(item.comparisons.youtube.current), previous: numeric(item.comparisons.youtube.previous) }))
    .filter((item) => item.current !== null && item.previous !== null);
  const youtubeCurrent = youtubePairs.length ? youtubePairs.reduce((sum, item) => sum + item.current, 0) : null;
  const youtubePrevious = youtubePairs.length ? youtubePairs.reduce((sum, item) => sum + item.previous, 0) : null;
  const youtubeDelta = youtubeCurrent !== null && youtubePrevious !== null ? youtubeCurrent - youtubePrevious : null;

  const searchRecords = records.filter((item) => item.comparisons?.searchAd);
  // Reused publication timestamps are not new observations. Compare only
  // timestamped source observations; a first-ever legacy default 0 is unknown.
  const observations = [...new Map(searchRecords.map(item => {
    const value = normalizeSearchAdObservation(item.comparisons.searchAd, { firstSeenAt: item.firstSeenAt });
    return [value.observedAt || `unknown:${item.detectedAt || item.earlySignalDate}`, value];
  })).values()].sort((a, b) => String(a.observedAt || "").localeCompare(String(b.observedAt || "")));
  const measured = observations.filter(item => item.observedAt);
  const firstSearch = measured[0]; const lastSearch = measured.at(-1) || observations.at(-1);
  const baseline = firstSearch?.previousObservationAvailable ? {
    previous: firstSearch.previous, previousClicks: firstSearch.previousClicks, previousObservedAt: firstSearch.previousObservedAt
  } : measured.length >= 2 ? {
    previous: firstSearch.current, previousClicks: firstSearch.currentClicks, previousObservedAt: firstSearch.observedAt
  } : {};
  const searchObservation = normalizeSearchAdObservation({ ...baseline, current: lastSearch?.current, currentClicks: lastSearch?.currentClicks,
    observedAt: lastSearch?.observedAt, observationWindow: lastSearch?.observationWindow, method: "stored_refresh_snapshots_in_period" });
  const firstSeenAt = records.map((item) => item.firstSeenAt).filter(Boolean).sort()[0] || null;
  const newQuery = records.some((item) => (item.sources || []).includes("searchad-new-query")
    && kstDate(item.firstSeenAt) >= startDate && kstDate(item.firstSeenAt) <= endDate);
  const sources = [...new Set(records.flatMap((item) => item.sources || []))];
  const missing = [];
  const youtubeAvailability = availability(youtubeRecords, expectedDays); const searchAdAvailability = availability(searchRecords, expectedDays);
  if (youtubeAvailability === "no_data") missing.push("YouTube 기간 데이터 없음");
  else if (youtubeAvailability === "partial") missing.push("YouTube 일부 기간만 존재");
  if (searchAdAvailability === "no_data") missing.push("Search Ad 기간 데이터 없음");
  else if (searchAdAvailability === "partial") missing.push("Search Ad 일부 기간만 존재");
  return { startDate, endDate, source: "stored-early-signal-history", observedDates: [...new Set(records.map((item) => item.earlySignalDate))], sources,
    youtube: { availability: youtubeAvailability, method: "stored_6h_observations_in_period", current: youtubeCurrent, previous: youtubePrevious,
      delta: youtubeDelta, deltaRate: youtubeDelta === null ? null : ratio(youtubeDelta, youtubePrevious) },
    searchAd: { ...searchObservation, availability: searchAdAvailability, newQuery, firstSeenAt },
    dataAvailability: missing.length ? (records.length ? "partial" : "no_data") : "available", dataGaps: missing };
}

function calculatePeriodMarketConfidence(row, evidence, surgeThreshold) {
  const periodRow = { ...row, earlyMarketEvidence: evidence?.youtube?.availability !== "no_data" ? { comparisons: { youtube: evidence.youtube } } : null,
    searchAdNewQuery: Boolean(evidence?.searchAd?.newQuery), searchAdImpressionDelta: evidence?.searchAd?.delta,
    searchAdObservation: evidence?.searchAd || null,
    searchAdClicks30d: Math.max(0, Number(evidence?.searchAd?.clickDelta || 0)), discoverySource: evidence?.sources || [], marketSourceConfidence: 0, shoppingRise: null, news: null };
  const confidence = calculateMarketConfidence(periodRow, surgeThreshold);
  if (!periodRow.searchAdNewQuery && !(Number(periodRow.searchAdImpressionDelta || 0) > 0) && periodRow.searchAdClicks30d > 0) {
    confidence.marketConfidenceReasons = confidence.marketConfidenceReasons.map((reason) => reason === "Search Ad 저장 클릭 관측 참고 · 집계기간 미확인"
      ? `저장 광고 관측 대비 Search Ad 클릭 +${periodRow.searchAdClicks30d} · 집계기간 미확인` : reason);
  }
  return { periodMarketConfidenceScore: confidence.marketConfidenceScore, periodMarketConfidenceGrade: confidence.marketConfidenceGrade,
    periodMarketConfidenceReasons: confidence.marketConfidenceReasons, periodMarketConfidenceComponents: confidence.marketConfidenceComponents };
}

module.exports = { buildPeriodMarketEvidence, calculatePeriodMarketConfidence, normalize, kstDate, inclusiveDays, availability };
