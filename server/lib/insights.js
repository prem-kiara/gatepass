'use strict';

/**
 * The superadmin dashboard: who has visited, when, from where, to see whom, and
 * who let them in — every number of which can be opened to the visits behind it.
 *
 * THE CONTRACT: any `{ value, drill }` pair in these payloads promises that
 * requesting `drill` returns exactly `value`:
 *
 *   drill = { view: 'visits',   params, measure: 'total' | 'people' }
 *             -> GET /api/admin/visits?{params}    and read `total` or `people`
 *   drill = { view: 'visitors', params }
 *             -> GET /api/admin/visitors?{params}  and read `total`
 *
 * It holds because every aggregate here groups by the same expressions that
 * lib/visitFilters.js filters on, and the drill params are built from the very
 * group key that produced the count. The e2e suite walks the whole payload and
 * checks every pair, so a breakdown that drifts from its drill-down fails CI
 * rather than quietly misleading someone.
 */

const config = require('../config');
const { query } = require('../db');
const { buildVisitFilters, EXPR } = require('./visitFilters');
const { VISIT_SELECT, decorate, fromDisplay } = require('./visitQueries');
const { isoDate, oneOf, uuid, ValidationError } = require('./validate');

const PRESETS = ['today', '7d', '30d', '90d', 'month', 'all', 'custom'];
const TOP_N = 8;
// Past this many days a per-day column chart is unreadable; bucket by week.
const MAX_DAILY_BUCKETS = 92;

const FROM = `FROM visits v JOIN visitors vis ON vis.id = v.visitor_id`;
const COMPANIONS = `LEFT JOIN LATERAL (
  SELECT count(*)::int AS n FROM visit_companions c WHERE c.visit_id = v.id
) cc ON true`;

/* ------------------------------------------------------------- dates (JS) */

const todayLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** ISO weekday 1 (Mon) .. 7 (Sun) for a YYYY-MM-DD date. */
function isoDow(iso) {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Appends a condition to a WHERE clause that may be empty. */
function and(where, condition) {
  return where ? `${where} AND ${condition}` : `WHERE ${condition}`;
}

/**
 * Resolves a preset or a custom range to concrete gate-local dates, plus the
 * equal-length period immediately before it (for "vs previous" deltas).
 */
async function resolveRange(q) {
  const today = todayLocal();
  let preset = oneOf(q.preset, 'Range', PRESETS);
  const qFrom = isoDate(q.from, 'From date');
  const qTo = isoDate(q.to, 'To date');
  if (!preset) preset = qFrom || qTo ? 'custom' : '30d';

  let from;
  let to = today;
  switch (preset) {
    case 'today': from = today; break;
    case '7d': from = addDays(today, -6); break;
    case '90d': from = addDays(today, -89); break;
    case 'month': from = `${today.slice(0, 8)}01`; break;
    case 'all': {
      const { rows } = await query(
        `SELECT to_char(min((created_at AT TIME ZONE $1::text)::date), 'YYYY-MM-DD') AS first FROM visits`,
        [config.timezone]
      );
      from = rows[0].first || today;
      break;
    }
    case 'custom':
      from = qFrom || qTo || today;
      to = qTo || today;
      break;
    default: from = addDays(today, -29); // 30d
  }
  if (from > to) throw new ValidationError('The start date must be on or before the end date.', 'from');

  const days = daysBetween(from, to) + 1;
  // "All time" has nothing before it to compare against.
  const previous = preset === 'all' ? null : { from: addDays(from, -days), to: addDays(from, -1) };
  return { preset, from, to, days, today, previous };
}

/* ---------------------------------------------------------------- helpers */

function drillVisits(params, measure = 'total') {
  return { view: 'visits', params, measure };
}

function drillVisitors(params) {
  return { view: 'visitors', params };
}

/** Runs a query scoped by the shared filters. `sql(f)` receives the built filter. */
async function scoped(filterParams, sql, extraParams = []) {
  const f = buildVisitFilters(filterParams);
  const text = sql(f, f.params.length);
  return query(text, [...f.params, ...extraParams]);
}

/**
 * Picks the display spelling for a group of variants ("Axis Bank" / "AXIS BANK"
 * / "axis bank"): a mixed-case spelling first, then the most frequent. Only the
 * label changes — the group, and so the count and its drill-down, do not.
 * Expects a subquery exposing `variant` and its count `n`.
 */
const BEST_LABEL = `(array_agg(variant ORDER BY (variant ~ '[a-z]' AND variant ~ '[A-Z]') DESC, n DESC, variant))[1]`;

const median = (col) =>
  `percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (${col})))`;

/* --------------------------------------------------------------- insights */

async function computeInsights(q = {}) {
  const range = await resolveRange(q);
  const base = { from: range.from, to: range.to };
  const withRange = (extra = {}) => ({ ...base, ...extra });

  const [
    totals, repeat, previous, daily, heat, byType, orgs, orgCount, hosts, deciders, guards,
    frequent, latest, live, stale,
  ] = await Promise.all([
    // Headline counts for the range.
    scoped(base, (f) => `
      SELECT count(*)::int AS visits,
             COALESCE(sum(1 + cc.n), 0)::int AS people,
             count(DISTINCT v.visitor_id)::int AS unique_visitors,
             count(*) FILTER (WHERE v.status IN ('APPROVED', 'INSIDE', 'CHECKED_OUT'))::int AS approved,
             count(*) FILTER (WHERE v.status = 'REJECTED')::int AS rejected,
             count(*) FILTER (WHERE v.status = 'PENDING')::int AS pending,
             ${median('v.decision_at - v.created_at')} FILTER (WHERE v.decision_at IS NOT NULL) AS median_decision_seconds
      ${FROM} ${COMPANIONS} ${f.where}`),

    // Visitors who came two or more times inside the range.
    scoped(base, (f) => `
      SELECT count(*)::int AS n FROM (
        SELECT v.visitor_id ${FROM} ${f.where} GROUP BY v.visitor_id HAVING count(*) >= 2
      ) r`),

    // The same headline counts for the previous period, for deltas.
    range.previous
      ? scoped(range.previous, (f) => `
          SELECT count(*)::int AS visits, COALESCE(sum(1 + cc.n), 0)::int AS people,
                 count(DISTINCT v.visitor_id)::int AS unique_visitors
          ${FROM} ${COMPANIONS} ${f.where}`)
      : Promise.resolve({ rows: [null] }),

    // Per local day; zero-filled and (for long ranges) weekly-bucketed below.
    scoped(base, (f) => `
      SELECT to_char(${f.groupExpr('localDate')}, 'YYYY-MM-DD') AS day,
             count(*)::int AS visits, COALESCE(sum(1 + cc.n), 0)::int AS people
      ${FROM} ${COMPANIONS} ${f.where} GROUP BY 1`),

    // When they arrive: ISO weekday x hour of day.
    scoped(base, (f) => `
      SELECT ${f.groupExpr('dow')} AS dow, ${f.groupExpr('hour')} AS hour, count(*)::int AS visits
      ${FROM} ${f.where} GROUP BY 1, 2`),

    scoped(base, (f) => `
      SELECT COALESCE(v.from_type, 'NONE') AS from_type, count(*)::int AS visits
      ${FROM} ${f.where} GROUP BY 1`),

    // Organisations: companies and government bodies (a Private visitor's
    // "detail" is a person or relation, not an organisation).
    scoped(base, (f) => `
      SELECT from_type, k, sum(n)::int AS visits, ${BEST_LABEL} AS label
      FROM (
        SELECT v.from_type, ${EXPR.fromDetailKey} AS k, btrim(v.from_detail) AS variant, count(*) AS n
        ${FROM}
        ${and(f.where, `v.from_type IN ('COMPANY', 'GOVERNMENT') AND ${EXPR.fromDetailKey} IS NOT NULL`)}
        GROUP BY 1, 2, 3
      ) x
      GROUP BY from_type, k
      ORDER BY visits DESC, label ASC
      LIMIT ${TOP_N}`),

    scoped(base, (f) => `
      SELECT count(DISTINCT (v.from_type, ${EXPR.fromDetailKey}))::int AS n
      ${FROM}
      ${and(f.where, `v.from_type IN ('COMPANY', 'GOVERNMENT') AND ${EXPR.fromDetailKey} IS NOT NULL`)}`),

    // Whom they came to see. Staff hosts group by account; free-text hosts by
    // their normalised name — the same keys the host filters compare on.
    scoped(base, (f) => `
      SELECT host_admin_id, admin_name, k, sum(n)::int AS visits, ${BEST_LABEL} AS free_label
      FROM (
        SELECT v.host_admin_id, h.name AS admin_name,
               CASE WHEN v.host_admin_id IS NULL THEN ${EXPR.hostNameKey} END AS k,
               btrim(v.host_name) AS variant, count(*) AS n
        ${FROM} LEFT JOIN users h ON h.id = v.host_admin_id
        ${f.where}
        GROUP BY 1, 2, 3, 4
      ) x
      GROUP BY host_admin_id, admin_name, k
      ORDER BY visits DESC
      LIMIT ${TOP_N}`),

    // Who let them in (or turned them away), and how long people waited.
    scoped(base, (f) => `
      SELECT u.id, u.name, u.role,
             count(*) FILTER (WHERE v.status <> 'REJECTED')::int AS approved,
             count(*) FILTER (WHERE v.status = 'REJECTED')::int AS rejected,
             ${median('v.decision_at - v.created_at')} AS median_seconds
      ${FROM} JOIN users u ON u.id = v.approved_by
      ${f.where}
      GROUP BY u.id, u.name, u.role
      ORDER BY count(*) DESC, u.name`),

    // Who logged them at the gate.
    scoped(base, (f) => `
      SELECT u.id, u.name, count(*)::int AS visits
      ${FROM} JOIN users u ON u.id = v.logged_by
      ${f.where}
      GROUP BY u.id, u.name
      ORDER BY visits DESC, u.name`),

    // Regulars: two or more visits in the range.
    scoped(base, (f) => `
      SELECT vis.id AS visitor_id, vis.full_name, vis.phone,
             count(*)::int AS visits, max(v.created_at) AS last_visit_at,
             (array_agg(v.photo_path ORDER BY v.created_at DESC))[1] AS photo_path
      ${FROM} ${f.where}
      GROUP BY vis.id, vis.full_name, vis.phone
      HAVING count(*) >= 2
      ORDER BY visits DESC, last_visit_at DESC
      LIMIT ${TOP_N}`),

    scoped(base, (f) => `${VISIT_SELECT} ${f.where} ORDER BY v.created_at DESC LIMIT ${TOP_N}`),

    // Right now — deliberately not bound to the date range.
    Promise.all(['inside_now', 'waiting', 'unattended'].map((live) =>
      scoped({ live }, (f) => `SELECT count(*)::int AS n ${FROM} ${f.where}`))),

    // Visits the gate never saw end, within the selected range.
    scoped(withRange({ stale: 'auto_checked_out' }), (f) => `SELECT count(*)::int AS n ${FROM} ${f.where}`),
  ]);

  const t = totals.rows[0];
  const p = previous.rows[0];

  /* ---- daily series, zero-filled, weekly when the range is long ---- */
  const perDay = new Map(daily.rows.map((r) => [r.day, r]));
  const byWeek = range.days > MAX_DAILY_BUCKETS;
  const series = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
    const r = perDay.get(d) || { visits: 0, people: 0 };
    const start = byWeek ? addDays(d, 1 - isoDow(d)) : d; // Monday of that week
    const key = byWeek && start < range.from ? range.from : start;
    const last = series[series.length - 1];
    if (last && last.start === key) {
      last.end = d;
      last.visits.value += r.visits;
      last.people += r.people;
    } else {
      series.push({ start: key, end: d, visits: { value: r.visits }, people: r.people });
    }
  }
  for (const b of series) {
    b.visits.drill = drillVisits({ from: b.start, to: b.end });
  }

  const drillRange = (extra, measure) => drillVisits(withRange(extra), measure);

  return {
    range: {
      preset: range.preset,
      from: range.from,
      to: range.to,
      days: range.days,
      today: range.today,
      previous: range.previous,
      bucket: byWeek ? 'week' : 'day',
    },

    totals: {
      visits: { value: t.visits, previous: p ? p.visits : null, drill: drillRange({}) },
      people: { value: t.people, previous: p ? p.people : null, drill: drillRange({}, 'people') },
      unique_visitors: {
        value: t.unique_visitors,
        previous: p ? p.unique_visitors : null,
        drill: drillVisitors(withRange()),
      },
      repeat_visitors: { value: repeat.rows[0].n, drill: drillVisitors(withRange({ min_visits: 2 })) },
      approved: { value: t.approved, drill: drillRange({ outcome: 'approved' }) },
      rejected: { value: t.rejected, drill: drillRange({ outcome: 'rejected' }) },
      pending: { value: t.pending, drill: drillRange({ outcome: 'pending' }) },
      // A duration, not a count, so it carries no `value` to reconcile — its
      // drill-down is the decided visits, longest wait first.
      median_decision: {
        seconds: t.median_decision_seconds === null ? null : Math.round(Number(t.median_decision_seconds)),
        drill: drillRange({ outcome: 'decided', sort: 'wait_desc' }),
      },
    },

    live: {
      inside_now: { value: live[0].rows[0].n, drill: drillVisits({ live: 'inside_now' }) },
      waiting: { value: live[1].rows[0].n, drill: drillVisits({ live: 'waiting' }) },
      unattended: { value: live[2].rows[0].n, drill: drillVisits({ live: 'unattended' }) },
    },

    attention: {
      auto_checked_out: { value: stale.rows[0].n, drill: drillRange({ stale: 'auto_checked_out' }) },
    },

    series,

    heatmap: heat.rows.map((r) => ({
      dow: r.dow,
      hour: r.hour,
      visits: { value: r.visits, drill: drillRange({ dow: r.dow, hour: r.hour }) },
    })),

    from_types: ['COMPANY', 'GOVERNMENT', 'PRIVATE', 'NONE'].map((type) => {
      const row = byType.rows.find((r) => r.from_type === type);
      return { from_type: type, visits: { value: row ? row.visits : 0, drill: drillRange({ from_type: type }) } };
    }),

    organisations: {
      distinct: orgCount.rows[0].n,
      top: orgs.rows.map((r) => ({
        from_type: r.from_type,
        label: r.label,
        visits: { value: r.visits, drill: drillRange({ from_type: r.from_type, from_detail: r.label }) },
      })),
    },

    hosts: hosts.rows.map((r) => ({
      label: r.admin_name || r.free_label,
      is_staff: Boolean(r.host_admin_id),
      visits: {
        value: r.visits,
        drill: drillRange(r.host_admin_id ? { host_admin_id: r.host_admin_id } : { host_name: r.free_label }),
      },
    })),

    deciders: deciders.rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      total: { value: r.approved + r.rejected, drill: drillRange({ approved_by: r.id }) },
      approved: { value: r.approved, drill: drillRange({ approved_by: r.id, outcome: 'approved' }) },
      rejected: { value: r.rejected, drill: drillRange({ approved_by: r.id, outcome: 'rejected' }) },
      median_seconds: r.median_seconds === null ? null : Math.round(Number(r.median_seconds)),
    })),

    guards: guards.rows.map((r) => ({
      id: r.id,
      name: r.name,
      visits: { value: r.visits, drill: drillRange({ logged_by: r.id }) },
    })),

    frequent: frequent.rows.map((r) => ({
      visitor_id: r.visitor_id,
      full_name: r.full_name,
      phone: r.phone,
      photo_path: r.photo_path,
      last_visit_at: r.last_visit_at,
      visits: { value: r.visits, drill: drillRange({ visitor_id: r.visitor_id }) },
    })),

    latest: latest.rows.map(decorate),
  };
}

/** Visits and people (visitors + companions) for a filter — the drill's count. */
async function countVisits(q = {}) {
  const f = buildVisitFilters(q);
  const { rows } = await query(
    `SELECT count(*)::int AS n, COALESCE(sum(1 + cc.n), 0)::int AS people ${FROM} ${COMPANIONS} ${f.where}`,
    f.params
  );
  return { total: rows[0].n, people: rows[0].people };
}

/* ------------------------------------------------------ visitor directory */

const VISITOR_SORTS = ['recent', 'visits', 'name'];

/**
 * People who visited, one row per person, for the same filters as the visit
 * list. `min_visits=2` gives the repeat visitors behind that dashboard tile.
 *
 * A person is recognised across visits by phone number; a visitor logged
 * without one is a new person each time, because we cannot safely say otherwise.
 */
async function listVisitors(q = {}) {
  const minVisitsRaw = q.min_visits === undefined || q.min_visits === '' ? 1 : Number(q.min_visits);
  if (!Number.isInteger(minVisitsRaw) || minVisitsRaw < 1 || minVisitsRaw > 1000) {
    throw new ValidationError('Minimum visits must be a whole number of at least 1.', 'min_visits');
  }
  const sort = oneOf(q.sort, 'Sort', VISITOR_SORTS) || 'recent';
  const limit = Math.min(Number(q.limit) || 30, 100);
  const offset = Math.max(Number(q.offset) || 0, 0);

  const f = buildVisitFilters(q);
  const minRef = `$${f.params.length + 1}`;
  const grouped = `
    SELECT v.visitor_id, count(*)::int AS visits,
           max(v.created_at) AS last_visit_at, min(v.created_at) AS first_visit_at
    ${FROM} ${f.where}
    GROUP BY v.visitor_id
    HAVING count(*) >= ${minRef}`;
  const params = [...f.params, minVisitsRaw];

  const order = {
    recent: 'g.last_visit_at DESC',
    visits: 'g.visits DESC, g.last_visit_at DESC',
    name: 'lower(vis.full_name) ASC, g.last_visit_at DESC',
  }[sort];

  const [total, page] = await Promise.all([
    query(`SELECT count(*)::int AS n FROM (${grouped}) x`, params),
    query(
      `WITH g AS (${grouped})
       SELECT vis.id AS visitor_id, vis.full_name, vis.phone,
              g.visits, g.last_visit_at, g.first_visit_at,
              (SELECT count(*)::int FROM visits x WHERE x.visitor_id = vis.id) AS lifetime_visits,
              latest.photo_path, latest.from_type, latest.from_detail, latest.host AS last_host
       FROM g
       JOIN visitors vis ON vis.id = g.visitor_id
       LEFT JOIN LATERAL (
         SELECT v2.photo_path, v2.from_type, v2.from_detail, COALESCE(h.name, v2.host_name) AS host
         FROM visits v2 LEFT JOIN users h ON h.id = v2.host_admin_id
         WHERE v2.visitor_id = vis.id
         ORDER BY v2.created_at DESC
         LIMIT 1
       ) latest ON true
       ORDER BY ${order}
       LIMIT ${limit} OFFSET ${offset}`,
      params
    ),
  ]);

  return {
    total: total.rows[0].n,
    limit,
    offset,
    visitors: page.rows.map((r) => ({
      ...r,
      last_from_display: fromDisplay(r.from_type, r.from_detail),
      // Their visits under the same filters — the row's own drill-down.
      visits: { value: r.visits, drill: drillVisits({ ...stripPaging(q), visitor_id: r.visitor_id }) },
    })),
  };
}

function stripPaging(q) {
  const { limit, offset, sort, min_visits: _m, ...rest } = q;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== ''));
}

/* ---------------------------------------------------------------- person */

async function visitorProfile(id) {
  const visitorId = uuid(id, 'Visitor', { required: true });
  const { rows } = await query('SELECT id, full_name, phone, created_at FROM visitors WHERE id = $1', [visitorId]);
  if (rows.length === 0) return null;

  const all = { visitor_id: visitorId };
  const [stats, hosts, orgs, photo] = await Promise.all([
    scoped(all, (f) => `
      SELECT count(*)::int AS visits,
             COALESCE(sum(cc.n), 0)::int AS companions,
             count(*) FILTER (WHERE v.status = 'REJECTED')::int AS rejected,
             min(v.created_at) AS first_visit_at, max(v.created_at) AS last_visit_at
      ${FROM} ${COMPANIONS} ${f.where}`),
    scoped(all, (f) => `
      SELECT host_admin_id, admin_name, k, sum(n)::int AS visits, ${BEST_LABEL} AS free_label
      FROM (
        SELECT v.host_admin_id, h.name AS admin_name,
               CASE WHEN v.host_admin_id IS NULL THEN ${EXPR.hostNameKey} END AS k,
               btrim(v.host_name) AS variant, count(*) AS n
        ${FROM} LEFT JOIN users h ON h.id = v.host_admin_id ${f.where}
        GROUP BY 1, 2, 3, 4
      ) x
      GROUP BY host_admin_id, admin_name, k ORDER BY visits DESC`),
    scoped(all, (f) => `
      SELECT from_type, k, sum(n)::int AS visits, ${BEST_LABEL} AS label
      FROM (
        SELECT COALESCE(v.from_type, 'NONE') AS from_type, ${EXPR.fromDetailKey} AS k,
               btrim(v.from_detail) AS variant, count(*) AS n
        ${FROM} ${f.where}
        GROUP BY 1, 2, 3
      ) x
      GROUP BY from_type, k ORDER BY visits DESC`),
    query('SELECT photo_path FROM visits WHERE visitor_id = $1 ORDER BY created_at DESC LIMIT 1', [visitorId]),
  ]);

  const s = stats.rows[0];
  return {
    visitor: rows[0],
    photo_path: photo.rows[0] ? photo.rows[0].photo_path : null,
    stats: {
      visits: { value: s.visits, drill: drillVisits(all) },
      rejected: { value: s.rejected, drill: drillVisits({ ...all, outcome: 'rejected' }) },
      companions: s.companions,
      first_visit_at: s.first_visit_at,
      last_visit_at: s.last_visit_at,
    },
    hosts: hosts.rows.map((r) => ({
      label: r.admin_name || r.free_label,
      visits: {
        value: r.visits,
        drill: drillVisits(r.host_admin_id ? { ...all, host_admin_id: r.host_admin_id } : { ...all, host_name: r.free_label }),
      },
    })),
    // Where they said they came from, each time. A blank detail is its own
    // bucket, drilled with no_detail — the type alone would also sweep in the
    // visits that did name an organisation, and the count would not match.
    from: orgs.rows.map((r) => {
      const params = { ...all, from_type: r.from_type };
      if (r.k) params.from_detail = r.label;
      else params.no_detail = 1;
      return {
        from_type: r.from_type,
        label: r.k ? r.label : null,
        visits: { value: r.visits, drill: drillVisits(params) },
      };
    }),
  };
}

module.exports = { computeInsights, countVisits, listVisitors, visitorProfile, resolveRange };
