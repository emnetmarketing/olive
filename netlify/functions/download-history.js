const crypto = require("node:crypto");
const { connect, readHistory, appendHistory, writeFile, readFile } = require("./download-history-cache");
const { connect: connectAnalysis, readJob, readLastSuccess, readLastPartial } = require("./trend-analysis-cache");
const { connect: connectSnapshot, readLatest: readLatestSnapshot } = require("./signal-snapshot-cache");
const earlyCache = require("./today-early-signal-cache");
const { toBuffer } = require("./unified-excel");
const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
const compactDate = (value) => String(value || "").replaceAll("-", "");
function filenameFor(job) {
  if (job.mode === "instant") return `monitoring-result-instant-${compactDate(job.latestDataDate)}.xls`;
  return `monitoring-result-${compactDate(job.startDate)}-${compactDate(job.endDate)}.xls`;
}
function unifiedFilename(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(now).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return `monitoring-all-results-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}.xlsx`;
}
async function newest(mode) {
  const jobs = await Promise.all([readLastSuccess(mode).catch(() => null), readLastPartial(mode).catch(() => null)]);
  return jobs.filter(Boolean).sort((a, b) => Date.parse(b.completedAt || 0) - Date.parse(a.completedAt || 0))[0] || null;
}
exports.handler = async (event) => {
  connect(event); connectAnalysis(event); connectSnapshot(event); earlyCache.connect(event);
  try {
    if (event.httpMethod === "GET" && event.queryStringParameters?.downloadId) {
      const id = String(event.queryStringParameters.downloadId); const file = await readFile(id);
      if (!file) return json(404, { error: "저장된 통합 Excel 파일을 찾을 수 없습니다." });
      return json(200, { id, filename: (await readHistory()).find((item) => item.id === id)?.filename || "monitoring-all-results.xlsx", contentBase64: file.toString("base64") });
    }
    if (event.httpMethod === "GET") return json(200, { items: await readHistory() });
    if (event.httpMethod !== "POST") return json(405, { error: "GET/POST only." });
    const input = JSON.parse(event.body || "{}");
    if (input.downloadType === "unified_results") {
      const snapshot = await readLatestSnapshot("instant").catch(() => null);
      const instantJob = snapshot?.jobId ? await readJob(snapshot.jobId).catch(() => null) : await newest("instant");
      if (!instantJob?.jobId) return json(409, { error: "다운로드할 최신 자동 분석 결과가 없습니다." });
      const periodJob = await newest("period"); const early = await earlyCache.readCache(); const generatedAt = new Date().toISOString();
      const buffer = await toBuffer({ generatedAt, instantJob, periodJob, early, discoveries: Array.isArray(input.discoveries) ? input.discoveries.slice(0, 100) : [] });
      const id = crypto.randomUUID(); const filename = unifiedFilename(new Date(generatedAt));
      await writeFile(id, buffer);
      const item = await appendHistory({ id, mode: "unified", downloadType: "전체 결과 통합 Excel", dataDate: instantJob.latestDataDate || null,
        latestDataDate: instantJob.latestDataDate || null, sourceJobId: instantJob.jobId, periodJobId: periodJob?.jobId || null,
        createdAt: generatedAt, downloadedAt: generatedAt, filename, resultCount: Number(instantJob.results?.length || 0), status: "completed", downloadAvailable: true });
      return json(201, { ...item, contentBase64: buffer.toString("base64") });
    }
    const sourceJobId = String(input.sourceJobId || "");
    const job = await readJob(sourceJobId);
    if (!job || job.state !== "completed") return json(409, { error: "완료된 분석 Job만 다운로드 이력에 등록할 수 있습니다." });
    const item = await appendHistory({
      mode: job.mode, startDate: job.startDate || null, endDate: job.endDate || null,
      latestDataDate: job.latestDataDate || null, sourceJobId: job.jobId,
      downloadedAt: new Date().toISOString(), filename: filenameFor(job), resultCount: Number(job.resultCount || job.results?.length || 0)
    });
    return json(201, item);
  } catch (error) {
    return json(500, { error: error.message || "다운로드 이력 처리 실패" });
  }
};
exports._test = { filenameFor, unifiedFilename, newest };
