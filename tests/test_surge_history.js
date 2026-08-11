const assert = require("node:assert/strict");
const { upsertInstantHistory, deriveSurgeState, historyProtectionSignal, normalizeKeyword } = require("../netlify/functions/surge-history-cache");

function historyOf(values) {
  const records = new Map();
  for (const [date, surge] of values) upsertInstantHistory(records, [{ keyword: "테스트 검색어", latestDataDate: date,
    estimatedSurgeCount: surge, estimatedBaseline: 100, estimatedLatest: 100 + surge, monthlySearches: 10000 }], `job-${date}`, `${date}T12:00:00.000Z`);
  return records.get(normalizeKeyword("테스트 검색어"));
}

const continuous = deriveSurgeState(historyOf([["2026-08-10", 800], ["2026-08-11", 1248]]), 500, "2026-08-11");
assert.equal(continuous.surgeDaysCount, 2);
assert.equal(continuous.consecutiveSurgeDays, 2);
assert.deepEqual(continuous.statuses, ["2일 연속 급등", "급등 강화"]);

const resurged = deriveSurgeState(historyOf([["2026-08-09", 700], ["2026-08-10", 100], ["2026-08-11", 900]]), 500, "2026-08-11");
assert.equal(resurged.surgeDaysCount, 2);
assert.equal(resurged.consecutiveSurgeDays, 1);
assert.ok(resurged.statuses.includes("재급등"));

const gap = deriveSurgeState(historyOf([["2026-08-09", 700], ["2026-08-11", 900]]), 500, "2026-08-11");
assert.equal(gap.consecutiveSurgeDays, 1);
assert.equal(gap.dataGap, true);
assert.ok(gap.statuses.includes("데이터 공백"));

const upserted = new Map();
upsertInstantHistory(upserted, [{ keyword: "동일 날짜", latestDataDate: "2026-08-10", estimatedSurgeCount: 800 }], "morning", "2026-08-11T01:00:00.000Z");
upsertInstantHistory(upserted, [{ keyword: "동일 날짜", latestDataDate: "2026-08-10", estimatedSurgeCount: 1200 }], "afternoon", "2026-08-11T08:00:00.000Z");
upsertInstantHistory(upserted, [{ keyword: "동일 날짜", latestDataDate: "2026-08-10", estimatedSurgeCount: 700 }], "late-morning-worker", "2026-08-11T02:00:00.000Z");
const sameDate = upserted.get(normalizeKeyword("동일 날짜"));
assert.equal(sameDate.history.length, 1);
assert.equal(sameDate.history[0].estimatedSurgeCount, 1200);
assert.equal(sameDate.history[0].sourceJobId, "afternoon");

const thresholdHistory = historyOf([["2026-08-10", 800], ["2026-08-11", 1248]]);
const at500 = deriveSurgeState(thresholdHistory, 500, "2026-08-11");
const at1000 = deriveSurgeState(thresholdHistory, 1000, "2026-08-11");
assert.equal(at500.surgeDaysCount, 2);
assert.equal(at1000.surgeDaysCount, 1);
assert.equal(thresholdHistory.history[0].estimatedSurgeCount, 800);
assert.ok(historyProtectionSignal(thresholdHistory, 500).protectionPriority > 0);

console.log("Persistent daily surge history and status derivation OK");
