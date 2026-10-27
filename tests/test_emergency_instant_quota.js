const test = require("node:test");
const assert = require("node:assert/strict");
const quota = require("../netlify/functions/trend-api-quota");

const NOW = new Date("2026-10-27T07:00:00.000Z");
const clone = value => value == null ? value : structuredClone(value);
const JOB = { jobId: "emergency-instant", mode: "instant", state: "running", fastPath: false,
  collectionScope: "search-trend-only", targetDataDate: "2026-10-26", createdAt: "2026-10-27T06:59:00.000Z",
  startDate: "2026-09-28", endDate: "2026-10-27", queryStartDate: "2026-09-27", surgeThreshold: 500, matchThreshold: 70 };
const APPROVAL = { maxAttempts: 1000, expiresAt: "2026-10-27T15:00:00.000Z",
  officialObservation: { observedAt: "2026-10-27T06:56:57.000Z", month: "2026-10", monthlyLimit: 50000,
    used: 27283, remaining: 22717, internalMonthlyBaseline: 11244 }, automaticReserve: 8763, safetyReserve: 12000 };
function memoryStore(initial) {
  const records = new Map(); let revision = 0;
  if (initial) records.set(quota.USAGE_KEY, { data: clone(initial), etag: String(++revision) });
  return { records, before: null,
    async get(key) { return clone(records.get(key)?.data || null); },
    async getWithMetadata(key) { return clone(records.get(key) || null); },
    async setJSON(key, data, condition = {}) {
      await this.before?.(key, data);
      const current = records.get(key);
      if (condition.onlyIfNew && current || condition.onlyIfMatch && condition.onlyIfMatch !== current?.etag) return { modified: false };
      records.set(key, { data: clone(data), etag: String(++revision) }); return { modified: true };
    }
  };
}
function usage() {
  return { version: 1, date: "2026-10-27", month: "2026-10", daily: { searchTrend: 1000, searchTrendHttp200: 1000 },
    monthly: { searchTrend: 11244, searchTrendHistorical: 7, searchTrendHttp200: 11234, searchTrendHttpOther: 10 }, exhausted: {},
    jobs: {}, invocations: {}, preservedMarker: "not-a-quota-reset" };
}
async function fixture({ initial = usage(), approval = APPROVAL, job = JOB } = {}) {
  const store = memoryStore(initial);
  await quota.provisionEmergencyGrant(job, clone(approval), { store, now: NOW });
  return { store, job, options: { store, now: NOW, jobId: job.jobId, invocationId: "worker-first", cumulative: true,
    source: "automatic", enforceBudget: { emergencyJob: job } } };
}

test("operator-only approval preserves true global counters and keeps the official discrepancy unclassified", async () => {
  const { store } = await fixture(); const saved = await store.get(quota.USAGE_KEY);
  assert.deepEqual(saved.daily, usage().daily); assert.deepEqual(saved.monthly, usage().monthly);
  assert.equal(saved.preservedMarker, "not-a-quota-reset");
  const grant = saved.emergencyInstantGrants[JOB.jobId];
  assert.equal(grant.officialObservation.unclassifiedDifference, 16039);
  assert.equal(grant.officialObservation.scopeAssumption, "production-app-as-approved-by-user");
  assert.equal(quota.statusFor(saved, "searchTrend", 0, NOW).remaining, 0);
  assert.equal(quota.historicalRemaining(saved, NOW).safetyReserve, 28000);
  assert.equal(quota.historicalRemaining(saved, NOW).remaining, 1993);
  const status = quota.emergencyStatus(saved, JOB, NOW);
  assert.equal(status.exists, true); assert.equal(status.eligible, true); assert.equal(status.remaining, 1000);
  assert.equal(status.officialRemainingAdjusted, 22717); assert.equal(status.automaticReserve, 8763);
  assert.equal(status.safetyReserve, 12000); assert.equal(status.uncertainReserve, 0);
});

test("normal and Historical requests never inherit the emergency override", async () => {
  const { store } = await fixture();
  await assert.rejects(quota.recordUsageBatch({ searchTrend: { calls: 1 } }, { store, now: NOW,
    jobId: "ordinary", invocationId: "ordinary-worker", cumulative: true, enforceBudget: {} }), { code: "QUOTA_BUDGET_EXHAUSTED" });
  await quota.recordUsageBatch({ searchTrend: { calls: 2, historicalCalls: 2 } }, { store, now: NOW,
    jobId: "period", invocationId: "period-worker", cumulative: true, enforceBudget: { historical: true } });
  const saved = await store.get(quota.USAGE_KEY);
  assert.equal(saved.emergencyInstantGrants[JOB.jobId].used, 0); assert.equal(saved.monthly.searchTrendHistorical, 9);
  assert.equal(quota.emergencyStatus(saved, JOB, NOW).officialRemainingAdjusted, 22715);
});

test("one grant atomically reserves attempts including retries and failed HTTP before dispatch", async () => {
  const { store, options } = await fixture();
  await quota.recordUsageBatch({ searchTrend: { calls: 1 } }, options);
  let saved = await store.get(quota.USAGE_KEY);
  assert.equal(saved.emergencyInstantGrants[JOB.jobId].used, 1); assert.equal(saved.daily.searchTrend, 1001);
  assert.equal(saved.monthly.searchTrend, 11245); assert.equal(saved.daily.searchTrendHttp200, 1000);
  await quota.recordUsageBatch({ searchTrend: { calls: 3, retries: 2, httpOther: 1, http429: 1, http200: 1 } }, options);
  saved = await store.get(quota.USAGE_KEY);
  assert.equal(saved.emergencyInstantGrants[JOB.jobId].used, 3); assert.equal(saved.daily.searchTrend, 1003);
  assert.equal(saved.daily.searchTrendRetries, 2); assert.equal(saved.daily.searchTrendHttpOther, 1);
  assert.equal(saved.daily.searchTrendHttp429, 1); assert.equal(saved.daily.searchTrendHttp200, 1001);
  assert.equal(saved.monthly.searchTrendHistorical, 7);
});

test("the 1000-attempt cap includes a first probe and cannot be exceeded by another continuation", async () => {
  const { store, options } = await fixture();
  await quota.recordUsageBatch({ searchTrend: { calls: 1, http200: 1 } }, options);
  await quota.recordUsageBatch({ searchTrend: { calls: 999, retries: 9, http200: 990, httpOther: 9 } }, { ...options, invocationId: "worker-next" });
  await assert.rejects(quota.recordUsageBatch({ searchTrend: { calls: 1 } }, { ...options, invocationId: "worker-over-cap" }), { code: "QUOTA_BUDGET_EXHAUSTED" });
  const saved = await store.get(quota.USAGE_KEY);
  assert.equal(saved.emergencyInstantGrants[JOB.jobId].used, 1000); assert.equal(saved.daily.searchTrend, 2000);
  assert.equal(saved.monthly.searchTrend, 12244); assert.equal(saved.jobs[JOB.jobId].metricsByType.searchTrend.calls, 1000);
  assert.equal(quota.emergencyStatus(saved, JOB, NOW).remaining, 0);
});

test("concurrent attempts share one CAS limit instead of each receiving the full grant", async () => {
  const { store, options } = await fixture({ approval: { ...APPROVAL, maxAttempts: 3 } });
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, n) => quota.recordUsageBatch({ searchTrend: { calls: 1 } },
    { ...options, invocationId: `worker-${n}` })));
  assert.equal(results.filter(x => x.status === "fulfilled").length, 3);
  assert.equal(results.filter(x => x.status === "rejected" && x.reason.code === "QUOTA_BUDGET_EXHAUSTED").length, 5);
  const saved = await store.get(quota.USAGE_KEY);
  assert.equal(saved.emergencyInstantGrants[JOB.jobId].used, 3); assert.equal(saved.monthly.searchTrend, 11247);
});

test("same cumulative receipt retries and response updates never double-debit a reserved call", async () => {
  const { store, options } = await fixture();
  await quota.recordUsageBatch({ searchTrend: { calls: 5 } }, options);
  await quota.recordUsageBatch({ searchTrend: { calls: 5, http200: 5 } }, options);
  await quota.recordUsageBatch({ searchTrend: { calls: 5, http200: 5 } }, options);
  const saved = await store.get(quota.USAGE_KEY);
  assert.equal(saved.emergencyInstantGrants[JOB.jobId].used, 5); assert.equal(saved.daily.searchTrend, 1005);
  assert.equal(saved.daily.searchTrendHttp200, 1005);
});

test("a committed reservation survives an ambiguous response without duplicate accounting", async () => {
  const { store, options } = await fixture(); const write = store.setJSON.bind(store); let lose = true;
  store.setJSON = async (...args) => { const result = await write(...args); if (lose && result.modified) { lose = false; throw new Error("lost response"); } return result; };
  await assert.rejects(quota.recordUsageBatch({ searchTrend: { calls: 1 } }, options), /lost response/);
  await quota.recordUsageBatch({ searchTrend: { calls: 1 } }, options);
  const saved = await store.get(quota.USAGE_KEY);
  assert.equal(saved.emergencyInstantGrants[JOB.jobId].used, 1); assert.equal(saved.daily.searchTrend, 1001);
});

test("all internal calls since the official baseline reduce official safe availability", async () => {
  const initial = usage(); initial.monthly.searchTrend += 1800;
  const { store, options } = await fixture({ initial });
  let saved = await store.get(quota.USAGE_KEY), status = quota.emergencyStatus(saved, JOB, NOW);
  assert.equal(status.internalUsageSinceObservation, 1800); assert.equal(status.officialRemainingAdjusted, 20917);
  assert.equal(status.remaining, 154);
  await quota.recordUsageBatch({ searchTrend: { calls: 154 } }, options);
  await assert.rejects(quota.recordUsageBatch({ searchTrend: { calls: 155 } }, options), { code: "QUOTA_BUDGET_EXHAUSTED" });
  saved = await store.get(quota.USAGE_KEY);
  assert.equal(quota.emergencyStatus(saved, JOB, NOW).remaining, 0); assert.equal(saved.emergencyInstantGrants[JOB.jobId].used, 154);
});

test("uncertain reserve is protected once rather than duplicated at approval and request time", async () => {
  const initial = usage(); initial.monthly.searchTrendHistoricalUncertainReserve = 1000;
  const { store, options } = await fixture({ initial });
  let saved = await store.get(quota.USAGE_KEY);
  assert.equal(quota.emergencyStatus(saved, JOB, NOW).uncertainReserve, 1000);
  assert.equal(quota.emergencyStatus(saved, JOB, NOW).remaining, 954);
  saved.monthly.searchTrendHistoricalUncertainReserve = 1100; await store.setJSON(quota.USAGE_KEY, saved);
  assert.equal(quota.emergencyStatus(await store.get(quota.USAGE_KEY), JOB, NOW).remaining, 854);
  await quota.recordUsageBatch({ searchTrend: { calls: 854 } }, options);
  await assert.rejects(quota.recordUsageBatch({ searchTrend: { calls: 855 } }, options), { code: "QUOTA_BUDGET_EXHAUSTED" });
});

test("grant remains identifiable after expiry and permits only delayed response accounting", async () => {
  const { store, options } = await fixture();
  await quota.recordUsageBatch({ searchTrend: { calls: 1 } }, options);
  const expired = new Date(APPROVAL.expiresAt);
  const status = quota.emergencyStatus(await store.get(quota.USAGE_KEY), JOB, expired);
  assert.equal(status.exists, true); assert.equal(status.eligible, false); assert.equal(status.remaining, 0);
  await quota.recordUsageBatch({ searchTrend: { calls: 1, http200: 1 } }, { ...options, now: expired });
  await assert.rejects(quota.recordUsageBatch({ searchTrend: { calls: 2, http200: 1 } }, { ...options, now: expired }), { code: "QUOTA_BUDGET_EXHAUSTED" });
  const saved = await store.get(quota.USAGE_KEY);
  assert.equal(saved.emergencyInstantGrants[JOB.jobId].used, 1); assert.equal(saved.monthly.searchTrendHttp200, 11235);
});

test("terminal closure is idempotent, cannot reopen and permits outstanding HTTP counter updates", async () => {
  const { store, options } = await fixture();
  await quota.recordUsageBatch({ searchTrend: { calls: 1 } }, options);
  const closed = await quota.closeEmergencyGrant(JOB.jobId, { store, now: NOW, reason: "completed" });
  assert.deepEqual(await quota.closeEmergencyGrant(JOB.jobId, { store, now: new Date(NOW.getTime() + 1000), reason: "failed" }), closed);
  assert.equal((await quota.provisionEmergencyGrant(JOB, APPROVAL, { store, now: NOW })).state, "closed");
  assert.equal(quota.emergencyStatus(await store.get(quota.USAGE_KEY), JOB, NOW).reason, "grant-closed");
  await quota.recordUsageBatch({ searchTrend: { calls: 1, httpOther: 1 } }, options);
  await assert.rejects(quota.recordUsageBatch({ searchTrend: { calls: 2, httpOther: 1 } }, options), { code: "QUOTA_BUDGET_EXHAUSTED" });
  assert.equal((await store.get(quota.USAGE_KEY)).emergencyInstantGrants[JOB.jobId].used, 1);
});

test("wrong identity, target, window, thresholds, scope and terminal states fail closed", async () => {
  const { store } = await fixture(), saved = await store.get(quota.USAGE_KEY);
  for (const patch of [{ mode: "period" }, { fastPath: true }, { historicalCollection: true }, { collectionScope: "all" },
    { targetDataDate: "2026-10-25" }, { startDate: "2026-09-01" }, { endDate: "2026-10-26" }, { queryStartDate: "2026-09-01" },
    { createdAt: "2026-10-27T06:58:00Z" }, { surgeThreshold: 1 }, { matchThreshold: 1 },
    { state: "completed" }, { state: "failed" }, { state: "interrupted" }]) {
    const status = quota.emergencyStatus(saved, { ...JOB, ...patch }, NOW);
    assert.equal(status.exists, true, JSON.stringify(patch)); assert.equal(status.eligible, false, JSON.stringify(patch));
  }
  assert.equal(quota.emergencyStatus(saved, { ...JOB, jobId: "other" }, NOW).exists, false);
});

test("month rollover and accounting regression cannot reuse a prior approved grant", async () => {
  const { store } = await fixture(); const saved = await store.get(quota.USAGE_KEY);
  const november = new Date("2026-10-31T15:00:00Z"), reset = quota.normalizeUsage(saved, november);
  assert.equal(quota.emergencyStatus(reset, JOB, november).remaining, 0);
  assert.equal(quota.emergencyStatus(reset, JOB, november).exists, true);
  saved.monthly.searchTrend = 11243;
  assert.equal(quota.emergencyStatus(saved, JOB, NOW).reason, "grant-accounting-invalid");
});

test("operator approval cannot exceed 1000, lower reserve, extend expiry or replace the day's Job", async () => {
  for (const patch of [{ maxAttempts: 1001 }, { maxAttempts: 0 }, { safetyReserve: 11999 }, { automaticReserve: 8762 },
    { expiresAt: "2026-10-27T15:00:01Z" }, { expiresAt: "2026-10-27T06:59:59Z" }]) {
    const store = memoryStore(usage());
    await assert.rejects(quota.provisionEmergencyGrant(JOB, { ...APPROVAL, ...patch }, { store, now: NOW }));
    assert.equal((await store.get(quota.USAGE_KEY)).emergencyInstantGrants, undefined);
  }
  const { store } = await fixture();
  await assert.rejects(quota.provisionEmergencyGrant(JOB, { ...APPROVAL, maxAttempts: 999 }, { store, now: NOW }), { code: "EMERGENCY_GRANT_IMMUTABLE" });
  await assert.rejects(quota.provisionEmergencyGrant({ ...JOB, jobId: "second" }, APPROVAL, { store, now: NOW }), { code: "EMERGENCY_GRANT_ALREADY_PROVISIONED" });
});

test("invalid observation arithmetic and insufficient official remainder cannot create an approval", async () => {
  for (const patch of [{ remaining: 22718 }, { used: 50001, remaining: -1 }, { month: "2026-09" },
    { observedAt: "2026-10-28T01:00:00Z" }, { internalMonthlyBaseline: 11245 }]) {
    const store = memoryStore(usage());
    await assert.rejects(quota.provisionEmergencyGrant(JOB, { ...APPROVAL,
      officialObservation: { ...APPROVAL.officialObservation, ...patch } }, { store, now: NOW }));
  }
  const store = memoryStore(usage());
  await assert.rejects(quota.provisionEmergencyGrant(JOB, { ...APPROVAL, safetyReserve: 28000 }, { store, now: NOW }), { code: "EMERGENCY_GRANT_UNAVAILABLE" });
});

test("provider exhaustion and foreign metric reservations remain blocked", async () => {
  const { store, options } = await fixture(); let saved = await store.get(quota.USAGE_KEY);
  saved.exhausted.searchTrend = true; await store.setJSON(quota.USAGE_KEY, saved);
  assert.equal(quota.emergencyStatus(saved, JOB, NOW).eligible, false);
  assert.equal(quota.emergencyStatus(saved, JOB, NOW).reason, "provider-exhausted");
  await assert.rejects(quota.recordUsageBatch({ searchTrend: { calls: 1 } }, options), { code: "QUOTA_BUDGET_EXHAUSTED" });
  for (const metrics of [{ shoppingInsight: { calls: 1 } }, { news: { calls: 1 } }, { searchTrend: { calls: 1, historicalCalls: 1 } }])
    await assert.rejects(quota.recordUsageBatch(metrics, options), { code: "EMERGENCY_GRANT_INVALID" });
  await assert.rejects(quota.recordUsageBatch({ searchTrend: { calls: 1 } }, { ...options, jobId: "wrong" }), { code: "EMERGENCY_GRANT_INVALID" });
  assert.equal((await store.get(quota.USAGE_KEY)).emergencyInstantGrants[JOB.jobId].used, 0);
});

test("closure winning the reservation CAS prevents a late worker from spending", async () => {
  const { store, options } = await fixture(); let collide = true;
  store.before = async (key, data) => {
    if (collide && data.emergencyInstantGrants?.[JOB.jobId]?.used === 1) {
      collide = false;
      await quota.closeEmergencyGrant(JOB.jobId, { store, now: NOW, reason: "failed" });
    }
  };
  await assert.rejects(quota.recordUsageBatch({ searchTrend: { calls: 1 } }, options), { code: "QUOTA_BUDGET_EXHAUSTED" });
  const saved = await store.get(quota.USAGE_KEY);
  assert.equal(saved.emergencyInstantGrants[JOB.jobId].state, "closed");
  assert.equal(saved.emergencyInstantGrants[JOB.jobId].used, 0); assert.equal(saved.daily.searchTrend, 1000);
});

test("concurrent operator provisioning allows one Job only and keeps identical retries idempotent", async () => {
  const store = memoryStore(usage());
  const results = await Promise.allSettled([JOB, { ...JOB, jobId: "second" }].map(job => quota.provisionEmergencyGrant(job, APPROVAL, { store, now: NOW })));
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(results.filter(x => x.status === "rejected" && x.reason.code === "EMERGENCY_GRANT_ALREADY_PROVISIONED").length, 1);
  const first = results.find(x => x.status === "fulfilled").value;
  assert.deepEqual(await quota.provisionEmergencyGrant({ ...JOB, jobId: first.jobId }, APPROVAL, { store, now: NOW }), first);
  assert.equal(Object.keys((await store.get(quota.USAGE_KEY)).emergencyInstantGrants).length, 1);
});

test("date-only official reports preserve unknown capture time separately from actual operator recording time", async () => {
  const officialObservation = { ...APPROVAL.officialObservation, observedAt: undefined,
    observedDateKST: "2026-10-27", exactObservedAt: null, recordedAt: NOW.toISOString() };
  const { store, options } = await fixture({ approval: { ...APPROVAL, officialObservation } });
  let saved = await store.get(quota.USAGE_KEY), observation = saved.emergencyInstantGrants[JOB.jobId].officialObservation;
  assert.equal(observation.observedAt, null); assert.equal(observation.exactObservedAt, null);
  assert.equal(observation.observedDateKST, "2026-10-27"); assert.equal(observation.recordedAt, NOW.toISOString());
  assert.equal(observation.observationPrecision, "date"); assert.equal(observation.internalMonthlyBaseline, 11244);
  assert.equal(observation.unclassifiedDifference, 16039);
  await quota.recordUsageBatch({ searchTrend: { calls: 2 } }, options);
  saved = await store.get(quota.USAGE_KEY);
  assert.equal(quota.emergencyStatus(saved, JOB, NOW).officialRemainingAdjusted, 22715);
  const retried = await quota.provisionEmergencyGrant(JOB, { ...APPROVAL, officialObservation },
    { store, now: new Date(NOW.getTime() + 60000) });
  assert.equal(retried.officialObservation.recordedAt, NOW.toISOString()); assert.equal(retried.used, 2);
});

test("date-only approval may record server time but cannot manufacture an exact observation time", async () => {
  const officialObservation = { ...APPROVAL.officialObservation, observedAt: undefined,
    observedDateKST: "2026-10-27", exactObservedAt: null };
  const { store } = await fixture({ approval: { ...APPROVAL, officialObservation } });
  const before = (await store.get(quota.USAGE_KEY)).emergencyInstantGrants[JOB.jobId];
  assert.equal(before.officialObservation.exactObservedAt, null);
  assert.equal(before.officialObservation.recordedAt, NOW.toISOString());
  const again = await quota.provisionEmergencyGrant(JOB, { ...APPROVAL, officialObservation },
    { store, now: new Date(NOW.getTime() + 60000) });
  assert.deepEqual(again, before);
  for (const change of [{ observedDateKST: "2026-10-26" }, { observedDateKST: undefined },
    { recordedAt: "2026-10-27T08:00:00Z" }, { observedAt: NOW.toISOString() },
    { exactObservedAt: "invalid" }, { exactObservedAt: "2026-10-26T00:00:00Z" }]) {
    await assert.rejects(quota.provisionEmergencyGrant(JOB, { ...APPROVAL,
      officialObservation: { ...officialObservation, ...change } }, { store: memoryStore(usage()), now: NOW }),
    { code: "EMERGENCY_GRANT_INVALID" });
  }
});

test("legacy exact observation timestamps and explicit exact timestamps retain their actual precision", async () => {
  const legacy = await fixture();
  const first = (await legacy.store.get(quota.USAGE_KEY)).emergencyInstantGrants[JOB.jobId].officialObservation;
  assert.equal(first.observedAt, APPROVAL.officialObservation.observedAt);
  assert.equal(first.exactObservedAt, APPROVAL.officialObservation.observedAt);
  assert.equal(first.observedDateKST, "2026-10-27"); assert.equal(first.observationPrecision, "instant");
  const explicit = await fixture({ approval: { ...APPROVAL, officialObservation: {
    ...APPROVAL.officialObservation, observedAt: undefined, observedDateKST: "2026-10-27",
    exactObservedAt: APPROVAL.officialObservation.observedAt } } });
  const second = (await explicit.store.get(quota.USAGE_KEY)).emergencyInstantGrants[JOB.jobId].officialObservation;
  assert.deepEqual(second, first);
});
