'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../db');
const notify = require('../lib/notify');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { str, normalizePhone, uuid, oneOf, isoDate, ValidationError } = require('../lib/validate');
const { VISIT_SELECT, todayClause, decorate } = require('../lib/visitQueries');
const { buildVisitFilters, orderBy: visitOrder } = require('../lib/visitFilters');
const { computeInsights, countVisits, listVisitors, visitorProfile } = require('../lib/insights');
const { buildReport } = require('../lib/reportXlsx');
const { randomTempPin, hashPin } = require('../lib/pin');
const { generateTempPassword } = require('../lib/tempPassword');
const { logAuth } = require('../lib/authlog');
const { bumpTokenVersion } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('SUPERADMIN'));

const ROLES = ['SECURITY', 'ADMIN', 'SUPERADMIN'];

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    phone: u.phone,
    role: u.role,
    is_active: u.is_active,
    created_at: u.created_at,
    created_by_name: u.created_by_name || null,
    has_pin: Boolean(u.pin_hash),
    must_change_pin: Boolean(u.must_change_pin),
    must_change_password: Boolean(u.must_change_password),
    pin_locked: Boolean(u.pin_locked_until && new Date(u.pin_locked_until) > new Date()),
  };
}

/* ------------------------------------------------------------------ users */

router.get('/users', async (req, res, next) => {
  try {
    const role = oneOf(req.query.role, 'Role', ROLES);
    const params = [];
    let where = '';
    if (role) {
      params.push(role);
      where = 'WHERE u.role = $1';
    }
    const { rows } = await query(
      `SELECT u.*, creator.name AS created_by_name
       FROM users u
       LEFT JOIN users creator ON creator.id = u.created_by
       ${where}
       ORDER BY u.is_active DESC, u.role, u.name`,
      params
    );
    res.json({ users: rows.map(publicUser) });
  } catch (err) {
    next(err);
  }
});

router.post('/users', async (req, res, next) => {
  try {
    const name = str(req.body.name, 'Name', { required: true, max: 150 });
    const username = str(req.body.username, 'Username', { required: true, min: 3, max: 60 }).toLowerCase();
    const password = str(req.body.password, 'Password', { required: true, min: 8, max: 200 });
    const role = oneOf(req.body.role, 'Role', ROLES, { required: true });
    const phone = normalizePhone(req.body.phone, 'Phone number');

    if (!/^[a-z0-9._-]+$/.test(username)) {
      throw new ValidationError('Username may only contain letters, numbers, dot, underscore or hyphen.', 'username');
    }

    const clash = await query('SELECT 1 FROM users WHERE lower(username) = $1', [username]);
    if (clash.rowCount > 0) {
      throw new ValidationError('That username is already taken.', 'username');
    }

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await query(
      `INSERT INTO users (name, username, phone, password_hash, role, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, username, phone, hash, role, req.user.id]
    );
    res.status(201).json({ user: publicUser(rows[0]) });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/admin/users/:id — edit, deactivate/reactivate, or reset password.
 * Accounts are never deleted: visit rows reference them, and an audit trail that
 * cannot name the approver is not an audit trail.
 */
router.patch('/users/:id', async (req, res, next) => {
  try {
    const id = uuid(req.params.id, 'User', { required: true });

    const target = await query('SELECT * FROM users WHERE id = $1', [id]);
    if (target.rowCount === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'No such user.' });
    }

    const sets = [];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      sets.push(`${sql} = $${params.length}`);
    };

    if (req.body.name !== undefined) add('name', str(req.body.name, 'Name', { required: true, max: 150 }));
    if (req.body.phone !== undefined) add('phone', normalizePhone(req.body.phone, 'Phone number'));
    if (req.body.role !== undefined) add('role', oneOf(req.body.role, 'Role', ROLES, { required: true }));
    // Passwords are deliberately NOT settable here. An admin typing someone's
    // new password knows it indefinitely, with nothing forcing a change — the
    // borrow-access pattern the reset lever exists to avoid. Use
    // POST /users/:id/reset-password, which issues a one-time secret instead.
    if (req.body.password !== undefined) {
      throw new ValidationError('Use Reset password — it issues a one-time password the user must replace.', 'password');
    }
    if (req.body.is_active !== undefined) {
      const active = Boolean(req.body.is_active);
      // Locking the last active superadmin out would leave nobody able to manage users.
      if (!active && target.rows[0].role === 'SUPERADMIN') {
        const others = await query(
          "SELECT count(*)::int AS n FROM users WHERE role = 'SUPERADMIN' AND is_active = true AND id <> $1",
          [id]
        );
        if (others.rows[0].n === 0) {
          throw new ValidationError('This is the last active superadmin — create another one first.', 'is_active');
        }
      }
      add('is_active', active);
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'NOTHING_TO_UPDATE', message: 'No changes were provided.' });
    }

    params.push(id);
    const { rows } = await query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    res.json({ user: publicUser(rows[0]) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/users/:id/reset-password — the same restore-don't-borrow deal
 * as the PIN reset, for the credential most people actually use.
 *
 * Issues a random one-time password, forces the user to replace it before they
 * can do anything (must_change_password, enforced in requireAuth), ends their
 * existing sessions, and records the reset in the append-only log naming the
 * superadmin who did it. Returned exactly once — never stored in the clear.
 */
router.post('/users/:id/reset-password', async (req, res, next) => {
  try {
    const id = uuid(req.params.id, 'User', { required: true });

    // Resetting your own password this way would lock you into the forced-change
    // screen for no reason; Settings is the right door for that.
    if (id === req.user.id) {
      throw new ValidationError('Use Settings → Change password to change your own password.', 'id');
    }

    const { rows } = await query('SELECT id, name, role FROM users WHERE id = $1', [id]);
    const target = rows[0];
    if (!target) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such user.' });

    const tempPassword = generateTempPassword();
    await query(
      'UPDATE users SET password_hash = $2, must_change_password = true WHERE id = $1',
      [id, await bcrypt.hash(tempPassword, 12)]
    );
    await bumpTokenVersion(id);
    await logAuth({ userId: id, actorId: req.user.id, event: 'PASSWORD_RESET', req });

    try {
      const created = await withTransaction((client) =>
        notify.securityAlert(client, {
          type: 'SECURITY_PASSWORD_RESET',
          title: 'A password was reset',
          body: `${req.user.name} issued a one-time password for ${target.name}. They must set their own at next sign-in.`,
        })
      );
      notify.scheduleDelivery(created);
    } catch (e) {
      console.error('[admin] password reset alert failed:', e.message);
    }

    res.json({ tempPassword });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/users/:id/reset-pin — restore a locked-out or forgetful
 * guard's access WITHOUT the superadmin ever being able to act as them.
 *
 * It issues a random one-time PIN, forces the guard to replace it on next
 * sign-in (must_change_pin), and records the reset in the append-only auth log
 * naming the superadmin who did it. So access can be restored, but any use of
 * this lever is permanent and visible, and the guard is forced to re-secret —
 * which is what keeps it from becoming a quiet impersonation path.
 *
 * The temporary PIN is returned exactly once, for the superadmin to hand to the
 * guard; it is never stored in the clear or shown again.
 */
router.post('/users/:id/reset-pin', async (req, res, next) => {
  try {
    const id = uuid(req.params.id, 'User', { required: true });
    const { rows } = await query('SELECT id, name, role, is_active FROM users WHERE id = $1', [id]);
    const target = rows[0];
    if (!target) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such user.' });
    if (target.role !== 'SECURITY') {
      throw new ValidationError('PINs are only for gate (security) staff.', 'role');
    }

    const tempPin = randomTempPin();
    await query(
      `UPDATE users
       SET pin_hash = $2, pin_set_at = now(), must_change_pin = true,
           pin_failed_attempts = 0, pin_locked_until = NULL
       WHERE id = $1`,
      [id, await hashPin(tempPin)]
    );
    // End any session the guard already had: after a reset, the only way back in
    // is through the temporary PIN and the forced change that follows it.
    await bumpTokenVersion(id);
    await logAuth({ userId: id, actorId: req.user.id, event: 'PIN_RESET', req });

    // The reset lever is the one path where an admin touches someone else's
    // credential, so every superadmin hears about each use of it.
    try {
      const created = await withTransaction((client) =>
        notify.securityAlert(client, {
          type: 'SECURITY_PIN_RESET',
          title: 'A gate PIN was reset',
          body: `${req.user.name} issued a one-time PIN for ${target.name || 'a guard'}. They must set their own PIN at next sign-in.`,
        })
      );
      notify.scheduleDelivery(created);
    } catch (e) {
      console.error('[admin] reset alert failed:', e.message);
    }

    res.json({ tempPin });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/users/:id/auth-events — the sign-in / credential history for
 * one account, so the superadmin can see exactly how and when it was accessed.
 */
router.get('/users/:id/auth-events', async (req, res, next) => {
  try {
    const id = uuid(req.params.id, 'User', { required: true });
    const { rows } = await query(
      `SELECT e.id, e.event, e.method, e.ip, e.at, e.detail,
              actor.name AS actor_name
       FROM auth_events e
       LEFT JOIN users actor ON actor.id = e.actor_id
       WHERE e.user_id = $1
       ORDER BY e.at DESC
       LIMIT 100`,
      [id]
    );
    res.json({ events: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/auth-events — the whole sign-in ledger, newest first.
 *
 * Per-user history answers "what happened to this account"; this answers "what
 * is happening across the system", which is where a pattern (one IP failing
 * against three accounts) actually becomes visible.
 */
const AUTH_EVENT_TYPES = [
  'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'PIN_SET', 'PIN_CHANGED', 'PIN_RESET',
  'PIN_LOCKED', 'PASSWORD_CHANGED', 'WEBAUTHN_REGISTERED', 'WEBAUTHN_REMOVED',
];

router.get('/auth-events', async (req, res, next) => {
  try {
    const event = oneOf(req.query.event, 'Event', AUTH_EVENT_TYPES);
    const userId = uuid(req.query.user_id, 'User');
    const limit = Math.min(Number(req.query.limit) || 100, 300);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const params = [];
    const clauses = [];
    if (event) {
      params.push(event);
      clauses.push(`e.event = $${params.length}`);
    }
    if (userId) {
      params.push(userId);
      clauses.push(`e.user_id = $${params.length}`);
    }
    // Everything except routine noise, so the default view is signal.
    if (req.query.concerning === '1') {
      clauses.push(`e.event IN ('LOGIN_FAILED','PIN_LOCKED','PIN_RESET','WEBAUTHN_REMOVED','PASSWORD_CHANGED')`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const [list, total] = await Promise.all([
      query(
        `SELECT e.id, e.event, e.method, e.ip, e.at, e.detail,
                subject.name AS user_name, subject.username, subject.role,
                actor.name AS actor_name
         FROM auth_events e
         LEFT JOIN users subject ON subject.id = e.user_id
         LEFT JOIN users actor   ON actor.id = e.actor_id
         ${where}
         ORDER BY e.at DESC, e.id DESC
         LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
      query(`SELECT count(*)::int AS n FROM auth_events e ${where}`, params),
    ]);

    res.json({ events: list.rows, total: total.rows[0].n, limit, offset });
  } catch (err) {
    next(err);
  }
});

/* ----------------------------------------------------------------- visits */

/**
 * GET /api/admin/visits — the drill-down behind every dashboard number.
 *
 * Filters come from lib/visitFilters.js, the same builder the dashboard's
 * aggregates use, so a bucket's count and this list always agree. Returns
 * `people` alongside `total` because the "people" tile counts companions too.
 * `format=csv` exports exactly what the filters selected.
 */
router.get('/visits', async (req, res, next) => {
  try {
    const { where, params } = buildVisitFilters(req.query);
    const order = visitOrder(req.query.sort);

    if (String(req.query.format).toLowerCase() === 'csv') {
      const { rows } = await query(`${VISIT_SELECT} ${where} ORDER BY ${order} LIMIT 20000`, params);
      return sendVisitsCsv(res, rows.map(decorate), `gatepass-visits-${todayLocalISO()}`);
    }

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    // countVisits is the same function the reconciliation check calls, so the
    // number a drill-down reports is computed exactly one way.
    const [counts, page] = await Promise.all([
      countVisits(req.query),
      query(`${VISIT_SELECT} ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, params),
    ]);

    res.json({
      visits: page.rows.map(decorate),
      total: counts.total,
      people: counts.people,
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------- dashboard & people */

/**
 * GET /api/admin/report.xlsx?preset=30d | from=&to= — the dashboard as a
 * workbook: summary, the visits behind it, and every breakdown on its own
 * sheet. Same query parameters as /insights, so "download" always means
 * "what I am looking at".
 */
router.get('/report.xlsx', async (req, res, next) => {
  try {
    const { workbook, filename } = await buildReport(req.query);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/insights?preset=30d | from=&to= — the superadmin dashboard. */
router.get('/insights', async (req, res, next) => {
  try {
    res.json(await computeInsights(req.query));
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/visitors — people who visited, one row per person. */
router.get('/visitors', async (req, res, next) => {
  try {
    res.json(await listVisitors(req.query));
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/visitors/:id — one person's whole history with the gate. */
router.get('/visitors/:id', async (req, res, next) => {
  try {
    const profile = await visitorProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such visitor.' });
    res.json(profile);
  } catch (err) {
    next(err);
  }
});

router.get('/visits/:id/events', async (req, res, next) => {
  try {
    const id = uuid(req.params.id, 'Visit', { required: true });
    const { rows } = await query(
      `SELECT e.id, e.action, e.detail, e.at, e.actor_id,
              actor.name AS actor_name, actor.role AS actor_role
       FROM visit_events e
       LEFT JOIN users actor ON actor.id = e.actor_id
       WHERE e.visit_id = $1
       ORDER BY e.at ASC, e.id ASC`,
      [id]
    );
    res.json({ events: rows });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------- reports */

router.get('/dashboard', async (req, res, next) => {
  try {
    const [counts, perAdmin, unattended, notCheckedOut] = await Promise.all([
      query(
        `SELECT status, count(*)::int AS n FROM visits v
         WHERE ${todayClause(1)} GROUP BY status`,
        [config.timezone]
      ),
      query(
        `SELECT u.id, u.name, u.role, count(*)::int AS decisions,
                count(*) FILTER (WHERE v.status <> 'REJECTED')::int AS approvals,
                count(*) FILTER (WHERE v.status = 'REJECTED')::int AS rejections
         FROM visits v JOIN users u ON u.id = v.approved_by
         WHERE ${todayClause(1)}
         GROUP BY u.id, u.name, u.role
         ORDER BY decisions DESC`,
        [config.timezone]
      ),
      query(
        `SELECT count(*)::int AS n FROM visits v
         WHERE v.status = 'PENDING'
           AND EXTRACT(EPOCH FROM (now() - v.created_at)) >= $1`,
        [config.unattendedAfterSeconds]
      ),
      // Anyone still marked INSIDE from a previous day was never checked out —
      // the end-of-day flag the gate needs to chase up.
      query(
        `${VISIT_SELECT}
         WHERE v.status = 'INSIDE'
           AND (v.checked_in_at AT TIME ZONE $1::text)::date < (now() AT TIME ZONE $1::text)::date
         ORDER BY v.checked_in_at ASC`,
        [config.timezone]
      ),
    ]);

    const byStatus = { PENDING: 0, APPROVED: 0, REJECTED: 0, INSIDE: 0, CHECKED_OUT: 0 };
    for (const row of counts.rows) byStatus[row.status] = row.n;

    res.json({
      today: byStatus,
      today_total: Object.values(byStatus).reduce((a, b) => a + b, 0),
      per_admin: perAdmin.rows,
      unattended_count: unattended.rows[0].n,
      never_checked_out: notCheckedOut.rows.map(decorate),
    });
  } catch (err) {
    next(err);
  }
});

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // Neutralise spreadsheet formula injection — these values come from gate staff input.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

const todayLocalISO = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

/** One CSV layout for every export, so a drill-down download matches the daily report. */
function sendVisitsCsv(res, visits, filename) {
  const fmt = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: config.timezone }) : '');
  const header = [
    'Visit ID', 'Date', 'Time In', 'Visitor', 'Visiting From', 'From (Company/Entity)',
    'Phone', 'Members', 'Purpose',
    'Visiting', 'Logged By', 'Status', 'Decided By', 'Decided At',
    'Rejection Reason', 'Checked In', 'Checked Out',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const v of visits) {
    lines.push([
      v.id,
      new Date(v.created_at).toLocaleDateString('en-IN', { timeZone: config.timezone }),
      new Date(v.created_at).toLocaleTimeString('en-IN', { timeZone: config.timezone }),
      v.full_name, v.from_type_label, v.from_detail, v.phone, v.companion_count, v.purpose,
      v.host_display, v.logged_by_name, v.status, v.approved_by_name, fmt(v.decision_at),
      v.rejection_reason, fmt(v.checked_in_at), fmt(v.checked_out_at),
    ].map(csvCell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  // BOM so Excel opens Indian names and Tamil text in UTF-8 rather than mojibake.
  return res.send('\ufeff' + lines.join('\r\n'));
}

router.get('/report/daily', async (req, res, next) => {
  try {
    const date = isoDate(req.query.date, 'Date') || null;
    const dayClause = date
      ? `(v.created_at AT TIME ZONE $1::text)::date = $2::date`
      : todayClause(1);
    const params = date ? [config.timezone, date] : [config.timezone];

    const { rows } = await query(
      `${VISIT_SELECT} WHERE ${dayClause} ORDER BY v.created_at ASC`,
      params
    );
    const visits = rows.map(decorate);

    if (String(req.query.format).toLowerCase() === 'csv') {
      const label = date || todayLocalISO();
      return sendVisitsCsv(res, visits, `gatepass-${label}`);
    }

    const summary = visits.reduce(
      (acc, v) => {
        acc[v.status] = (acc[v.status] || 0) + 1;
        acc.total += 1;
        acc.people += 1 + v.companion_count;
        return acc;
      },
      { total: 0, people: 0 }
    );

    res.json({ date, summary, visits });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
