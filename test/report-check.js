'use strict';

/**
 * The workbook must not be able to disagree with the dashboard.
 *
 * It is built from the same `computeInsights` and `buildVisitFilters`, so this
 * is a guard against that wiring being replaced with a second "equivalent"
 * query later: for every range, the Summary total, the number of rows on the
 * Visits sheet, the per-day column and `countVisits` must all be the same
 * number. Read-only — safe to run against production.
 */

const path = require('path');
const SERVER = path.join(__dirname, '..', 'server');
const { buildReport } = require(path.join(SERVER, 'lib', 'reportXlsx'));
const { countVisits } = require(path.join(SERVER, 'lib', 'insights'));

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  if (got === want) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label} -- expected ${want}, got ${got}`); }
};

/** Reads a label/value pair out of the Summary sheet. */
function summaryValue(sheet, label) {
  let found = null;
  sheet.eachRow((row) => {
    if (String(row.getCell(1).value || '').trim() === label) found = row.getCell(2).value;
  });
  return found;
}

function dataRows(sheet) {
  // rowCount includes the header; blank trailing rows are not added by us.
  return sheet.rowCount - 1;
}

async function main() {
  for (const preset of ['today', '7d', '30d', 'all']) {
    console.log(`--- ${preset} ---`);
    const { workbook } = await buildReport({ preset });
    const summary = workbook.getWorksheet('Summary');
    const visitsSheet = workbook.getWorksheet('Visits');
    const perPeriod = workbook.getWorksheet('Per day') || workbook.getWorksheet('Per week');

    const total = summaryValue(summary, 'Visits');
    const counted = await countVisits({ preset, ...rangeOf(workbook) });

    check(`${preset}: Visits sheet has one row per counted visit`, dataRows(visitsSheet), total);

    let seriesTotal = 0;
    perPeriod.eachRow((row, i) => { if (i > 1) seriesTotal += Number(row.getCell(3).value) || 0; });
    check(`${preset}: per-period column sums to the total`, seriesTotal, total);

    const approved = summaryValue(summary, 'Let in (approved)');
    const rejected = summaryValue(summary, 'Turned away (rejected)');
    const pending = summaryValue(summary, 'Still waiting for a decision');
    check(`${preset}: approved + rejected + waiting = visits`, approved + rejected + pending, total);

    check(`${preset}: total matches countVisits`, counted.total, total);
  }

  console.log(`\nREPORT checked=${pass + fail} passed=${pass} failed=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

/** The range the workbook actually used, read back off its own file name. */
function rangeOf(workbook) {
  const summary = workbook.getWorksheet('Summary');
  const line = String(summary.getRow(2).getCell(1).value || '');
  const m = line.match(/^(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/);
  return m ? { preset: 'custom', from: m[1], to: m[2] } : {};
}

main().catch((err) => { console.error(err); process.exit(1); });
