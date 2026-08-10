const {
  accounts, isActive, searchAdGet, productFromAd, uniqueProducts,
  readStatus, writeStatus, store, CACHE_KEY
} = require("./search-ad-cache");

const CONCURRENCY = 4;
const PROGRESS_INTERVAL = 20;
const CHECKPOINT_INTERVAL = 100;
const INVOCATION_BUDGET_MS = 11 * 60 * 1000;

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

async function loadGroups(account, metrics) {
  const campaigns = await searchAdGet(account, "/ncc/campaigns", undefined, metrics);
  const shoppingCampaigns = (Array.isArray(campaigns) ? campaigns : []).filter((campaign) => {
    const type = String(campaign.campaignTp || campaign.type || "").toUpperCase();
    return ["SHOPPING", "CATALOG", "SHOPPING_BRAND"].some((value) => type.includes(value)) && isActive(campaign);
  });
  const groups = [];
  for (const campaign of shoppingCampaigns) {
    const response = await searchAdGet(account, "/ncc/adgroups", { nccCampaignId: campaign.nccCampaignId }, metrics);
    for (const group of Array.isArray(response) ? response : []) {
      if (isActive(group)) groups.push({ campaign, group });
    }
  }
  return groups;
}

async function updateProgress(jobId, patch) {
  const current = await readStatus();
  if (current?.jobId !== jobId || current.state !== "running") throw new Error("동기화 작업 소유권을 확인할 수 없습니다.");
  return writeStatus({ ...current, ...patch, updatedAt: new Date().toISOString() });
}

exports.handler = async (event) => {
  let jobId = "";
  try { jobId = String(JSON.parse(event.body || "{}").jobId || ""); } catch { return; }
  const initial = await readStatus();
  if (!jobId || initial?.jobId !== jobId || initial.state !== "running") return;

  const metrics = { apiCalls: Number(initial.apiCalls || 0), retries: Number(initial.retries || 0) };
  const started = Date.parse(initial.startedAt) || Date.now();
  const invocationStarted = Date.now();
  const jobKey = `jobs/${jobId}`;
  const checkpoint = await store().get(jobKey, { type: "json" }) || {};
  const allItems = Array.isArray(checkpoint.items) ? checkpoint.items : [];
  const accountCounts = checkpoint.accountCounts || {};
  let totalAdgroups = Number(checkpoint.totalAdgroups || 0);
  let processedAdgroups = Number(checkpoint.processedAdgroups || 0);
  let totalCreatives = Number(checkpoint.totalCreatives || 0);
  let eligibleProducts = Number(checkpoint.eligibleProducts || 0);

  try {
    const configuredAccounts = accounts();
    const plans = [];
    for (const account of configuredAccounts) plans.push({ account, groups: await loadGroups(account, metrics) });
    totalAdgroups = plans.reduce((sum, plan) => sum + plan.groups.length, 0);
    const plannedStatus = await readStatus();
    for (const plan of plans) plannedStatus.accountProgress[String(plan.account.number)].total = plan.groups.length;
    await writeStatus({
      ...plannedStatus, totalAdgroups, apiCalls: metrics.apiCalls, retries: metrics.retries,
      message: `Search Ad 상품 동기화 중 · ${processedAdgroups.toLocaleString("ko-KR")} / ${totalAdgroups.toLocaleString("ko-KR")} 광고그룹 처리`,
      updatedAt: new Date().toISOString()
    });

    for (let accountIndex = 0; accountIndex < plans.length; accountIndex += 1) {
      if (accountIndex < Number(checkpoint.accountIndex || 0)) continue;
      const { account, groups } = plans[accountIndex];
      const status = await readStatus();
      status.apiCalls = metrics.apiCalls;
      status.retries = metrics.retries;
      status.message = `${account.label} 상품 소재 조회 중`;
      await writeStatus({ ...status, updatedAt: new Date().toISOString() });

      const accountItems = allItems.filter((item) => item.accountNumber === account.number);
      const startGroupIndex = accountIndex === Number(checkpoint.accountIndex || 0) ? Number(checkpoint.groupIndex || 0) : 0;
      for (let groupIndex = startGroupIndex; groupIndex < groups.length; groupIndex += CONCURRENCY) {
        const batch = groups.slice(groupIndex, groupIndex + CONCURRENCY);
        const results = await Promise.allSettled(batch.map(async ({ group }) => {
          const ads = await searchAdGet(account, "/ncc/ads", { nccAdgroupId: group.nccAdgroupId }, metrics);
          return { group, ads: Array.isArray(ads) ? ads : [] };
        }));
        for (const result of results) {
          if (result.status === "rejected") throw result.reason;
          totalCreatives += result.value.ads.length;
          for (const ad of result.value.ads) {
            const item = productFromAd(account, result.value.group, ad);
            if (item) {
              accountItems.push(item);
              eligibleProducts += 1;
            }
          }
        }
        processedAdgroups += batch.length;
        if (processedAdgroups % PROGRESS_INTERVAL < batch.length || processedAdgroups === totalAdgroups) {
          const current = await readStatus();
          current.accountProgress[String(account.number)].processed += batch.length;
          await updateProgress(jobId, {
            processedAdgroups, totalAdgroups, accountProgress: current.accountProgress,
            apiCalls: metrics.apiCalls, retries: metrics.retries,
            message: `Search Ad 상품 동기화 중 · ${processedAdgroups.toLocaleString("ko-KR")} / ${totalAdgroups.toLocaleString("ko-KR")} 광고그룹 처리`
          });
        } else {
          const current = await readStatus();
          current.accountProgress[String(account.number)].processed += batch.length;
          await writeStatus({ ...current, processedAdgroups, apiCalls: metrics.apiCalls, retries: metrics.retries, updatedAt: new Date().toISOString() });
        }
        const nextGroupIndex = groupIndex + batch.length;
        const nextCheckpoint = {
          items: allItems.concat(accountItems.filter((item) => !allItems.includes(item))), accountCounts,
          accountIndex, groupIndex: nextGroupIndex, processedAdgroups, totalAdgroups, totalCreatives, eligibleProducts,
          totalsRecorded: Object.fromEntries(plans.map((plan) => [plan.account.number, true]))
        };
        if (processedAdgroups % CHECKPOINT_INTERVAL < batch.length || Date.now() - invocationStarted >= INVOCATION_BUDGET_MS) {
          await store().setJSON(jobKey, nextCheckpoint);
        }
        if (Date.now() - invocationStarted >= INVOCATION_BUDGET_MS) {
          await updateProgress(jobId, { message: `Search Ad 상품 동기화 계속 진행 중 · ${processedAdgroups.toLocaleString("ko-KR")} / ${totalAdgroups.toLocaleString("ko-KR")} 광고그룹 처리` });
          const baseUrl = String(process.env.URL || "").replace(/\/$/, "");
          const response = await fetch(`${baseUrl}/.netlify/functions/search-ad-refresh-background`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId })
          });
          if (!response.ok && response.status !== 202) throw new Error(`후속 Background Function 시작 실패: HTTP ${response.status}`);
          return;
        }
      }
      const unique = uniqueProducts(accountItems);
      accountCounts[account.label] = unique.length;
      const otherAccounts = allItems.filter((item) => item.accountNumber !== account.number);
      allItems.length = 0;
      allItems.push(...otherAccounts, ...unique);
      await store().setJSON(jobKey, {
        items: allItems, accountCounts, accountIndex: accountIndex + 1, groupIndex: 0,
        processedAdgroups, totalAdgroups, totalCreatives, eligibleProducts,
        totalsRecorded: Object.fromEntries(plans.map((plan) => [plan.account.number, true]))
      });
    }

    const unique = uniqueProducts(allItems);
    const refreshedAt = new Date().toISOString();
    const cache = {
      version: 1, refreshedAt, items: unique,
      uniqueProducts: unique.length, accountCounts,
      processedAdgroups, totalAdgroups, totalCreatives,
      beforeDeduplication: eligibleProducts,
      apiCalls: metrics.apiCalls, retries: metrics.retries,
      durationMs: Date.now() - started
    };
    await store().setJSON(CACHE_KEY, cache);
    await store().delete(jobKey);
    await writeStatus({
      ...await readStatus(), state: "completed", message: "Search Ad 상품 동기화 완료",
      updatedAt: refreshedAt, completedAt: refreshedAt, processedAdgroups, totalAdgroups,
      accountCounts, uniqueProducts: unique.length, totalCreatives,
      beforeDeduplication: eligibleProducts, apiCalls: metrics.apiCalls,
      retries: metrics.retries, durationMs: cache.durationMs, errors: []
    });
  } catch (error) {
    const failedAt = new Date().toISOString();
    await writeStatus({
      ...await readStatus(), state: "failed", message: "Search Ad 상품 동기화 실패",
      updatedAt: failedAt, failedAt, processedAdgroups, totalAdgroups,
      totalCreatives, beforeDeduplication: eligibleProducts, apiCalls: metrics.apiCalls, retries: metrics.retries,
      durationMs: Date.now() - started,
      errors: [error.message || "알 수 없는 동기화 오류"]
    });
  }
};
