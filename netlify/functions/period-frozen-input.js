const { normalizedKeyword } = require('./trend-series-cache');

// The selection has already been computed from the complete candidate,
// discovery and surge stores. Freeze the values actually used by the next
// calculation, including misses/empty series, without copying the entire
// protection history into each Job. Keep the complete, original record for
// each selected series (including historical windows). Never concatenate ratios.
function freezePeriodCalculationInputs({ job, calculationVersion, candidateCache, marketCache, productCache,
  priorSignals, selection, surgeHistoryCache, seriesCache, earlyCache, collectionSummary }) {
  const candidates = [...selection.selected, ...selection.ratioOnly];
  const selectedSeries = new Map(), selectedSignals = new Map();
  for (const c of candidates) {
    const key = normalizedKeyword(c.keyword), entry = seriesCache.entries.get(key);
    if (entry && !selectedSeries.has(key)) selectedSeries.set(key, entry);
    if (priorSignals.has(c.keyword)) selectedSignals.set(c.keyword, { ...priorSignals.get(c.keyword), keyword: c.keyword });
  }
  return {
    calculationVersion, candidateCache, selection, productCache, collectionSummary,
    sourceMetadata: { frozenAt: new Date().toISOString(), candidateRefreshedAt: candidateCache.refreshedAt || null,
      candidateVersion: candidateCache.version ?? null, productRefreshedAt: productCache.refreshedAt || null,
      productVersion: productCache.version ?? null, discoveryRefreshedAt: marketCache?.refreshedAt || null,
      earlyGeneratedAt: earlyCache?.generatedAt || null, seriesUpdatedAt: seriesCache.manifest?.updatedAt || null,
      startDate: job.startDate, endDate: job.endDate, queryStartDate: job.queryStartDate },
    marketCache: { frozenItemCount: marketCache?.items?.length || 0 },
    priorSignalCache: { items: [...selectedSignals.values()] },
    surgeHistoryCache: { manifest: surgeHistoryCache.manifest, records: [] },
    seriesCache: { manifest: seriesCache.manifest, entries: [...selectedSeries] },
    earlyCache: earlyCache ? { history: earlyCache.history || [] } : null
  };
}
module.exports = { freezePeriodCalculationInputs };
