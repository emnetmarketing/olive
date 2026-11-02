(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KstTimePresentation = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const TIME_ZONE = "Asia/Seoul";
  const EXCEL_TIMESTAMP_FORMAT = "yyyy-mm-dd hh:mm:ss";
  // Reuse one explicit-zone formatter. Never use the host/browser default zone.
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  function instant(value) {
    if (value == null || value === "") return null;
    if (!(value instanceof Date) && typeof value !== "number"
      && !(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value))) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  function parts(value) {
    const date = instant(value);
    if (!date) return null;
    return Object.fromEntries(formatter.formatToParts(date).filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  }
  function formatKstTimestamp(value, missing = "—") {
    if (value == null || value === "") return missing;
    const p = parts(value);
    return p ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}` : "시간대 미확인";
  }
  function toKstExcelDate(value) {
    const p = parts(value);
    // Excel date serials have no timezone. Encode Seoul wall-clock components
    // as a UTC-backed Date solely at the Excel boundary, never in stored data.
    return p ? new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)) : null;
  }
  function toDateOnlyExcelDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
  }
  function formatDateOnly(value, missing = "—") {
    return toDateOnlyExcelDate(value) ? value : missing;
  }
  return { TIME_ZONE, EXCEL_TIMESTAMP_FORMAT, formatKstTimestamp, toKstExcelDate, toDateOnlyExcelDate, formatDateOnly };
});
