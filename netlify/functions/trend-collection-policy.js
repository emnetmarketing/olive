const DAY_MS = 86400000;

function ageDays(value, now = new Date()) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? Math.max(0, (now.getTime() - timestamp) / DAY_MS) : Infinity;
}

function candidateTier(candidate, priorSignal, now = new Date()) {
  const sources = candidate?.sources || candidate?.discoverySource || [];
  const discoveredAge = ageDays(candidate?.discoveredAt || candidate?.firstSeenAt, now);
  const recentSurge = Number(priorSignal?.estimatedSurgeCount || 0) > 0
    || Number(priorSignal?.consecutiveSurgeDays || 0) > 0
    || Number(priorSignal?.cumulativeSurgeDays || 0) > 0;
  const newMarket = Boolean(candidate?.marketDiscovery || sources.includes("youtube")
    || sources.includes("searchad-new-query") || candidate?.isNewSearchQuery);
  const strongContext = Boolean(candidate?.relatedBrand && (candidate?.relatedProductType || candidate?.relatedProductLine));
  if (newMarket || recentSurge || strongContext || discoveredAge <= 3) return "hot";
  if (discoveredAge <= 14 || Number(candidate?.impressionDelta || 0) > 0) return "warm";
  return "cold";
}

function tierIntervalDays(tier) { return tier === "hot" ? 1 : tier === "warm" ? 3 : 7; }

function isDueForCollection(candidate, priorSignal, cachedRecord, now = new Date()) {
  const tier = candidateTier(candidate, priorSignal, now);
  if (!cachedRecord?.fetchedAt) return { due: true, tier, ageDays: Infinity, intervalDays: tierIntervalDays(tier) };
  const age = ageDays(cachedRecord.fetchedAt, now); const intervalDays = tierIntervalDays(tier);
  return { due: age >= intervalDays, tier, ageDays: age, intervalDays };
}

function priorityWeight(tier) { return tier === "hot" ? 300000 : tier === "warm" ? 150000 : 0; }

module.exports = { ageDays, candidateTier, tierIntervalDays, isDueForCollection, priorityWeight };
