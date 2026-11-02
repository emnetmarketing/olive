const test = require('node:test');
const assert = require('node:assert/strict');
const { zipEntries, verifyKstWorkbook, prepareKstFixture, prepareData, workbookCells } = require('../scripts/verify-packaged-functions.cjs');
const { toBuffer } = require('../netlify/functions/unified-excel');

async function fixtureWorkbook() {
  const { instant, target } = prepareData();
  const fixture = { ...prepareKstFixture(instant, target), generatedAt: '2026-10-31T15:02:03.456Z' };
  const bytes = await toBuffer({ ...fixture, instantJob: fixture.instant, periodJob: fixture.period, periodRequest: fixture.period });
  return { fixture, files: new Map(zipEntries(bytes).map(entry => [entry.name, entry.bytes.toString('utf8')])) };
}

test('package XLSX gate verifies timestamp serials, formats and labels without shifting date-only cells', async () => {
  const { fixture, files } = await fixtureWorkbook();
  const result = verifyKstWorkbook(files, fixture);
  assert.equal(result.timestampCellsKst, true); assert.equal(result.dateOnlyCellsUnshifted, true);
  assert.equal(result.checked.length, 13);
  const discovered = result.checked.find(item => item.sheet === '01_오늘 급상승 신호' && item.cell === 'D2');
  const encoded = new Date((discovered.serial - 25569) * 86400000).toISOString();
  assert.equal(encoded, '2026-11-01T00:00:02.000Z');
  assert.equal(workbookCells(files, '07_선택기간분석').get('C12'), fixture.period.results[0].keyword);
});

test('package XLSX gate rejects the original UTC timestamp serial even if KST labels are present', async () => {
  const { fixture, files } = await fixtureWorkbook();
  const xml = files.get('xl/worksheets/sheet2.xml');
  const broken = xml.replace(/(<c r="D2"[^>]*>\s*<v>)([^<]+)(<\/v>)/, (_, prefix, number, suffix) => `${prefix}${Number(number) - 9 / 24}${suffix}`);
  assert.notEqual(broken, xml);
  files.set('xl/worksheets/sheet2.xml', broken);
  assert.throws(() => verifyKstWorkbook(files, fixture), /D2 must encode KST/);
});

test('package XLSX gate rejects adding a timezone offset to a date-only cell', async () => {
  const { fixture, files } = await fixtureWorkbook();
  const xml = files.get('xl/worksheets/sheet2.xml');
  const broken = xml.replace(/(<c r="K2"[^>]*>\s*<v>)([^<]+)(<\/v>)/, (_, prefix, number, suffix) => `${prefix}${Number(number) + 9 / 24}${suffix}`);
  assert.notEqual(broken, xml);
  files.set('xl/worksheets/sheet2.xml', broken);
  assert.throws(() => verifyKstWorkbook(files, fixture), /K2 must preserve date-only/);
});
