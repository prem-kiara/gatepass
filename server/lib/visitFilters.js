'use strict';

/**
 * The one filter vocabulary for visits.
 *
 * Every number on the superadmin dashboard and every drill-down list behind it
 * is computed from this builder. That is what makes a drill-down trustworthy:
 * a bucket that says "12" hands back the exact parameters whose WHERE clause
 * produced it, so opening it cannot return 11. If you add a dashboard
 * breakdown, add its dimension here and group by the expression exported below
 * — never write a second, "equivalent" predicate somewhere else.
 *
 * All dates and clock times are gate-local (config.timezone). A visit logged at
 * 11pm IST belongs to that day, not to tomorrow's UTC date.
 */

const config = require('../config');
const { str, uuid, oneOf, isoDate, ValidationError } = require('./validate');

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'INSIDE', 'CHECKED_OUT'];
const FROM_TYPES = ['COMPANY', 'PRIVATE', 'GOVERNMENT', 'NONE'];
const OUTCOMES = ['approved', 'rejected', 'pending', 'decided'];
const LIVE = ['inside_now', 'waiting', 'unattended'];
const STALE = ['auto_checked_out'];
const SORTS = ['recent', 'oldest', 'wait_desc'];

// Group-by expressions. Dashboard breakdowns GROUP BY exactly these, and the
// matching filter below compares against exactly these, so the two agree.
// `$TZ` is substituted with the bound timezone parameter.
const EXPR = {
  localDate: '(v.created_at AT TIME ZONE $TZ::text)::date',
  dow: 'EXTRACT(ISODOW FROM v.created_at AT TIME ZONE $TZ::text)::int',
  hour: 'EXTRACT(HOUR FROM v.created_at AT TIME ZONE $TZ::text)::int',
  // NULLIF folds '' and NULL into one "no detail" group.
  fromDetailKey: "NULLIF(lower(btrim(v.from_detail)), '')",
  hostNameKey: "lower(btrim(v.host_name))",
};

const OUTCOME_SQL = {
  approved: "v.status IN ('APPROVED', 'INSIDE', 'CHECKED_OUT')",
  rejected: "v.status = 'REJECTED'",
  pending: "v.status = 'PENDING'",
  decided: "v.status <> 'PENDING'",
};

function intInRange(value, field, min, max) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(`${field} must be a whole number from ${min} to ${max}.`, field);
  }
  return n;
}

/** Parses and validates every supported filter from a query-string object. */
function parseVisitFilters(q = {}) {
  const f = {
    from: isoDate(q.from, 'From date'),
    to: isoDate(q.to, 'To date'),
    status: oneOf(q.status, 'Status', STATUSES),
    outcome: oneOf(q.outcome, 'Outcome', OUTCOMES),
    approved_by: uuid(q.approved_by, 'Decided by'),
    logged_by: uuid(q.logged_by, 'Logged by'),
    visitor_id: uuid(q.visitor_id, 'Visitor'),
    from_type: oneOf(q.from_type, 'Visiting from', FROM_TYPES),
    from_detail: str(q.from_detail, 'Organisation', { max: 200 }),
    // "They said Company but didn't say which" — a bucket of its own on the
    // person page, so it needs a filter of its own to drill into.
    no_detail: q.no_detail === '1' || q.no_detail === 1 || q.no_detail === true,
    host_admin_id: uuid(q.host_admin_id, 'Host'),
    host_name: str(q.host_name, 'Host', { max: 150 }),
    dow: intInRange(q.dow, 'Weekday', 1, 7),
    hour: intInRange(q.hour, 'Hour', 0, 23),
    live: oneOf(q.live, 'Live view', LIVE),
    stale: oneOf(q.stale, 'Needs attention', STALE),
    q: str(q.q, 'Search', { max: 100 }),
  };
  if (f.from && f.to && f.from > f.to) {
    throw new ValidationError('The start date must be on or before the end date.', 'from');
  }
  return f;
}

/**
 * Builds `WHERE ...` plus its bound parameters. The FROM clause must include
 * `visits v JOIN visitors vis ON vis.id = v.visitor_id` (search reads `vis`).
 *
 * `startIndex` lets a caller that already bound parameters of its own append
 * these after them.
 */
function buildVisitFilters(q, { startIndex = 0 } = {}) {
  const f = parseVisitFilters(q);
  const params = [];
  const clauses = [];
  const bind = (value) => {
    params.push(value);
    return `$${startIndex + params.length}`;
  };

  // The timezone is bound once, lazily: Postgres rejects a statement carrying a
  // parameter that no clause uses, because it cannot infer that parameter's type.
  let tzRef = null;
  const tz = () => {
    if (!tzRef) tzRef = bind(config.timezone);
    return tzRef;
  };
  const expr = (name) => EXPR[name].replace(/\$TZ/g, tz());

  // Date range as a half-open timestamp interval rather than a cast of every
  // row's timestamp — exactly equivalent, but it can use the created_at index.
  if (f.from) clauses.push(`v.created_at >= (${bind(f.from)}::date::timestamp AT TIME ZONE ${tz()}::text)`);
  if (f.to) clauses.push(`v.created_at < ((${bind(f.to)}::date + 1)::timestamp AT TIME ZONE ${tz()}::text)`);

  if (f.status) clauses.push(`v.status = ${bind(f.status)}`);
  if (f.outcome) clauses.push(OUTCOME_SQL[f.outcome]);
  if (f.approved_by) clauses.push(`v.approved_by = ${bind(f.approved_by)}`);
  if (f.logged_by) clauses.push(`v.logged_by = ${bind(f.logged_by)}`);
  if (f.visitor_id) clauses.push(`v.visitor_id = ${bind(f.visitor_id)}`);

  if (f.from_type === 'NONE') clauses.push('v.from_type IS NULL');
  else if (f.from_type) clauses.push(`v.from_type = ${bind(f.from_type)}`);
  if (f.from_detail) clauses.push(`${EXPR.fromDetailKey} = lower(btrim(${bind(f.from_detail)}))`);
  if (f.no_detail) clauses.push(`${EXPR.fromDetailKey} IS NULL`);

  if (f.host_admin_id) clauses.push(`v.host_admin_id = ${bind(f.host_admin_id)}`);
  if (f.host_name) {
    clauses.push(`v.host_admin_id IS NULL AND ${EXPR.hostNameKey} = lower(btrim(${bind(f.host_name)}))`);
  }

  if (f.dow !== null) clauses.push(`${expr('dow')} = ${bind(f.dow)}`);
  if (f.hour !== null) clauses.push(`${expr('hour')} = ${bind(f.hour)}`);

  // "Right now" views ignore the date range's meaning of history — they are
  // about the gate at this moment.
  // Nobody stays INSIDE past the auto check-out, so INSIDE is simply "inside".
  if (f.live === 'inside_now') {
    clauses.push("v.status = 'INSIDE'");
  } else if (f.live === 'waiting') {
    clauses.push("v.status = 'PENDING'");
  } else if (f.live === 'unattended') {
    clauses.push(`v.status = 'PENDING' AND EXTRACT(EPOCH FROM (now() - v.created_at)) >= ${bind(config.unattendedAfterSeconds)}`);
  }

  // Visits nobody saw end: the sweeper marked them as left after 24 hours
  // inside because no guard checked them out.
  if (f.stale === 'auto_checked_out') {
    clauses.push("v.status = 'CHECKED_OUT' AND v.checkout_auto");
  }

  if (f.q) {
    const i = bind(`%${f.q}%`);
    clauses.push(`(vis.full_name ILIKE ${i} OR vis.phone ILIKE ${i} OR v.purpose ILIKE ${i} OR v.from_detail ILIKE ${i} OR v.host_name ILIKE ${i})`);
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
    filters: f,
    // Lets aggregate queries reuse the same bound timezone for their GROUP BY.
    groupExpr: (name) => expr(name),
  };
}

function orderBy(sort) {
  const s = oneOf(sort, 'Sort', SORTS) || 'recent';
  if (s === 'oldest') return 'v.created_at ASC';
  // Longest wait for a decision first — "who was kept standing at the gate".
  if (s === 'wait_desc') return 'COALESCE(v.decision_at, now()) - v.created_at DESC, v.created_at DESC';
  return 'v.created_at DESC';
}

module.exports = { buildVisitFilters, parseVisitFilters, orderBy, EXPR, FROM_TYPES, STATUSES };
