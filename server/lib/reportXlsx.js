'use strict';

/**
 * The downloadable dashboard: one workbook holding the numbers the superadmin
 * sees on screen, plus the visit list behind them.
 *
 * It is built from `computeInsights` and the same `buildVisitFilters` the
 * dashboard and its drill-downs use, so the workbook cannot disagree with the
 * screen — the reconciliation contract covers this file for free.
 *
 * Dates and times are written as gate-local text rather than Excel serial
 * dates: a serial date carries no timezone, so a reader in another zone would
 * see visits shift by hours. Text sorts and pivots correctly as written
 * (YYYY-MM-DD), and never lies about when someone arrived.
 */

const ExcelJS = require('exceljs');
const config = require('../config');
const { query } = require('../db');
const { buildVisitFilters } = require('./visitFilters');
const { computeInsights } = require('./insights');
const { VISIT_SELECT, decorate } = require('./visitQueries');

const TZ = config.timezone;
const HEADER_FILL = 'FFF1F5F9';   // slate-100
const TITLE_COLOUR = 'FF0F172A';  // slate-900
const MAX_ROWS = 20000;           // same cap as the CSV export

const localDate = (d) => (d ? new Date(d).toLocaleDateString('en-CA', { timeZone: TZ }) : '');
const localTime = (d) => (d ? new Date(d).toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false }) : '');
const localStamp = (d) => (d ? `${localDate(d)} ${localTime(d)}` : '');

/** "4m 12s" — the same shape the dashboard prints for a wait. */
function duration(seconds) {
  if (seconds === null || seconds === undefined) return '';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;
const STATUS_LABEL = {
  PENDING: 'Waiting for approval',
  APPROVED: 'Approved, not checked in',
  REJECTED: 'Rejected',
  INSIDE: 'Inside',
  CHECKED_OUT: 'Checked out',
};

/** Header row + widths + freeze, applied the same way on every sheet. */
function table(sheet, columns, rows) {
  sheet.columns = columns.map((c) => ({ key: c.key, width: c.width || 16 }));
  const header = sheet.addRow(columns.map((c) => c.label));
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  header.alignment = { vertical: 'middle' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of rows) sheet.addRow(r);
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return sheet;
}

/** Summary sheet: section headings and label/value pairs, no table chrome. */
function keyValueSheet(sheet, title, subtitle, sections) {
  sheet.columns = [{ width: 38 }, { width: 18 }];

  const t = sheet.addRow([title]);
  t.font = { bold: true, size: 14, color: { argb: TITLE_COLOUR } };
  const s = sheet.addRow([subtitle]);
  s.font = { color: { argb: 'FF64748B' } };
  sheet.addRow([]);

  for (const section of sections) {
    const h = sheet.addRow([section.title]);
    h.font = { bold: true };
    h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    for (const [label, value] of section.rows) {
      const row = sheet.addRow([label, value]);
      if (typeof value === 'number') row.getCell(2).numFmt = '#,##0';
    }
    sheet.addRow([]);
  }
}

/**
 * Builds the workbook for a set of dashboard filters (the query string the
 * dashboard itself is showing) and returns { workbook, filename }.
 */
async function buildReport(q = {}) {
  const insights = await computeInsights(q);
  const range = insights.range;

  // The visit list for the same range, ordered oldest first so the sheet reads
  // like a logbook.
  const { where, params } = buildVisitFilters({ ...q, from: range.from, to: range.to });
  const { rows } = await query(
    `${VISIT_SELECT} ${where} ORDER BY v.created_at ASC LIMIT ${MAX_ROWS}`,
    params
  );
  const visits = rows.map(decorate);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'GatePass';
  wb.created = new Date();

  /* ------------------------------------------------------------- summary */
  const t = insights.totals;
  keyValueSheet(
    wb.addWorksheet('Summary'),
    'GatePass — visitor report',
    `${range.from} to ${range.to} (${range.days} day${range.days === 1 ? '' : 's'}) · generated ${localStamp(new Date())}`,
    [
      {
        title: 'Visits',
        rows: [
          ['Visits', t.visits.value],
          ['People (including members)', t.people.value],
          ['Different visitors', t.unique_visitors.value],
          ['Came more than once', t.repeat_visitors.value],
          ['Let in (approved)', t.approved.value],
          ['Turned away (rejected)', t.rejected.value],
          ['Still waiting for a decision', t.pending.value],
          ['Typical wait for a decision', duration(t.median_decision.seconds)],
        ],
      },
      {
        title: 'At the gate right now',
        rows: [
          ['Inside now', insights.live.inside_now.value],
          ['Waiting for approval', insights.live.waiting.value],
          ['Waiting more than 10 minutes', insights.live.unattended.value],
        ],
      },
      {
        title: 'Records the gate didn’t finish',
        rows: [
          ['Approved but never checked in', insights.attention.never_checked_in.value],
          ['Marked as left automatically after 24h', insights.attention.auto_checked_out.value],
        ],
      },
      {
        title: 'Where visitors came from',
        rows: [
          ['Different organisations', insights.organisations.distinct],
          ...insights.from_types.map((f) => [
            { COMPANY: 'Company', GOVERNMENT: 'Government entity', PRIVATE: 'Private', NONE: 'Not recorded' }[f.from_type],
            f.visits.value,
          ]),
        ],
      },
    ]
  );

  /* -------------------------------------------------------------- visits */
  table(
    wb.addWorksheet('Visits'),
    [
      { label: 'Date', key: 'date', width: 12 },
      { label: 'Time in', key: 'time', width: 10 },
      { label: 'Visitor', key: 'name', width: 24 },
      { label: 'Phone', key: 'phone', width: 14 },
      { label: 'Visiting from', key: 'fromType', width: 16 },
      { label: 'Company / entity', key: 'fromDetail', width: 26 },
      { label: 'Members', key: 'members', width: 9 },
      { label: 'Came to see', key: 'host', width: 22 },
      { label: 'Purpose', key: 'purpose', width: 28 },
      { label: 'Status', key: 'status', width: 22 },
      { label: 'Logged by', key: 'loggedBy', width: 18 },
      { label: 'Decided by', key: 'decidedBy', width: 18 },
      { label: 'Decided at', key: 'decidedAt', width: 20 },
      { label: 'Wait for decision', key: 'wait', width: 16 },
      { label: 'Reason if rejected', key: 'reason', width: 26 },
      { label: 'Checked in', key: 'in', width: 20 },
      { label: 'Checked out', key: 'out', width: 20 },
      { label: 'Checked out automatically', key: 'auto', width: 22 },
      { label: 'Visit ID', key: 'id', width: 38 },
    ],
    visits.map((v) => [
      localDate(v.created_at),
      localTime(v.created_at),
      v.full_name,
      v.phone || '',
      v.from_type_label || '',
      v.from_detail || '',
      v.companion_count,
      v.host_display || '',
      v.purpose || '',
      STATUS_LABEL[v.status] || v.status,
      v.logged_by_name || '',
      v.approved_by_name || '',
      localStamp(v.decision_at),
      v.decision_at ? duration((new Date(v.decision_at) - new Date(v.created_at)) / 1000) : '',
      v.rejection_reason || '',
      localStamp(v.checked_in_at),
      localStamp(v.checked_out_at),
      v.checkout_auto ? 'Yes' : '',
      v.id,
    ])
  );

  /* ---------------------------------------------------------- how busy */
  table(
    wb.addWorksheet(range.bucket === 'week' ? 'Per week' : 'Per day'),
    [
      { label: range.bucket === 'week' ? 'Week starting' : 'Date', key: 'start', width: 16 },
      { label: 'Week ending', key: 'end', width: 16 },
      { label: 'Visits', key: 'visits', width: 10 },
      { label: 'People', key: 'people', width: 10 },
    ],
    insights.series.map((b) => [b.start, b.end === b.start ? '' : b.end, b.visits.value, b.people])
  );

  // The heatmap, flattened two ways: the totals people actually read off it.
  const byDow = new Map();
  const byHour = new Map();
  for (const cell of insights.heatmap) {
    byDow.set(cell.dow, (byDow.get(cell.dow) || 0) + cell.visits.value);
    byHour.set(cell.hour, (byHour.get(cell.hour) || 0) + cell.visits.value);
  }
  const busiest = wb.addWorksheet('Busiest times');
  table(busiest, [
    { label: 'Weekday', key: 'day', width: 14 },
    { label: 'Visits', key: 'visits', width: 10 },
  ], WEEKDAYS.map((name, i) => [name, byDow.get(i + 1) || 0]));
  busiest.addRow([]);
  const hourHeader = busiest.addRow(['Hour of day', 'Visits']);
  hourHeader.font = { bold: true };
  hourHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  for (let h = 0; h < 24; h += 1) busiest.addRow([hourLabel(h), byHour.get(h) || 0]);
  busiest.autoFilter = null; // two stacked tables; a filter would only span one

  /* ------------------------------------------------------ the breakdowns */
  table(
    wb.addWorksheet('Organisations'),
    [
      { label: 'Type', key: 'type', width: 20 },
      { label: 'Organisation', key: 'label', width: 34 },
      { label: 'Visits', key: 'visits', width: 10 },
    ],
    insights.organisations.top.map((o) => [
      o.from_type === 'GOVERNMENT' ? 'Government entity' : 'Company',
      o.label,
      o.visits.value,
    ])
  );

  table(
    wb.addWorksheet('Came to see'),
    [
      { label: 'Name', key: 'label', width: 28 },
      { label: 'Staff member', key: 'staff', width: 14 },
      { label: 'Visits', key: 'visits', width: 10 },
    ],
    insights.hosts.map((h) => [h.label, h.is_staff ? 'Yes' : 'No', h.visits.value])
  );

  table(
    wb.addWorksheet('Decisions by admin'),
    [
      { label: 'Admin', key: 'name', width: 24 },
      { label: 'Role', key: 'role', width: 14 },
      { label: 'Decisions', key: 'total', width: 12 },
      { label: 'Approved', key: 'approved', width: 12 },
      { label: 'Rejected', key: 'rejected', width: 12 },
      { label: 'Typical time to decide', key: 'median', width: 22 },
    ],
    insights.deciders.map((d) => [
      d.name, d.role, d.total.value, d.approved.value, d.rejected.value, duration(d.median_seconds),
    ])
  );

  table(
    wb.addWorksheet('Logged by guard'),
    [
      { label: 'Guard', key: 'name', width: 24 },
      { label: 'Visitors logged', key: 'visits', width: 16 },
    ],
    insights.guards.map((g) => [g.name, g.visits.value])
  );

  table(
    wb.addWorksheet('Frequent visitors'),
    [
      { label: 'Visitor', key: 'name', width: 26 },
      { label: 'Phone', key: 'phone', width: 14 },
      { label: 'Visits', key: 'visits', width: 10 },
      { label: 'Last visit', key: 'last', width: 20 },
    ],
    insights.frequent.map((f) => [f.full_name, f.phone || '', f.visits.value, localStamp(f.last_visit_at)])
  );

  return {
    workbook: wb,
    filename: `gatepass-report-${range.from}-to-${range.to}.xlsx`,
    visitCount: visits.length,
    truncated: visits.length === MAX_ROWS,
  };
}

module.exports = { buildReport };
