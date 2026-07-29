'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { str, normalizePhone, uuid, oneOf, isoDate, ValidationError } = require('../lib/validate');
const { VISIT_SELECT, todayClause, decorate } = require('../lib/visitQueries');

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
    if (req.body.password !== undefined) {
      const password = str(req.body.password, 'Password', { required: true, min: 8, max: 200 });
      add('password_hash', await bcrypt.hash(password, 12));
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

/* ----------------------------------------------------------------- visits */

/** Shared filter builder for the visits table and the CSV export. */
function buildVisitFilters(q) {
  const params = [];
  const clauses = [];
  const add = (sqlFn, value) => {
    params.push(value);
    clauses.push(sqlFn(params.length));
  };

  const from = isoDate(q.from, 'From date');
  const to = isoDate(q.to, 'To date');
  const status = oneOf(q.status, 'Status', ['PENDING', 'APPROVED', 'REJECTED', 'INSIDE', 'CHECKED_OUT']);
  const approvedBy = uuid(q.approved_by, 'Approved by');
  const search = str(q.q, 'Search', { max: 100 });

  // Bind the timezone only when a date filter actually references it. Postgres
  // rejects a statement carrying a parameter no clause uses, because it cannot
  // infer that parameter's type.
  let tz = null;
  if (from || to) {
    params.push(config.timezone);
    tz = params.length;
  }

  if (from) add((i) => `(v.created_at AT TIME ZONE $${tz}::text)::date >= $${i}::date`, from);
  if (to) add((i) => `(v.created_at AT TIME ZONE $${tz}::text)::date <= $${i}::date`, to);
  if (status) add((i) => `v.status = $${i}`, status);
  if (approvedBy) add((i) => `v.approved_by = $${i}`, approvedBy);
  if (search) {
    params.push(`%${search}%`);
    const i = params.length;
    clauses.push(`(vis.full_name ILIKE $${i} OR vis.phone ILIKE $${i} OR v.purpose ILIKE $${i} OR v.company ILIKE $${i})`);
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

router.get('/visits', async (req, res, next) => {
  try {
    const { where, params } = buildVisitFilters(req.query);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const totalRes = await query(
      `SELECT count(*)::int AS n FROM visits v JOIN visitors vis ON vis.id = v.visitor_id ${where}`,
      params
    );

    const { rows } = await query(
      `${VISIT_SELECT} ${where} ORDER BY v.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    res.json({ visits: rows.map(decorate), total: totalRes.rows[0].n, limit, offset });
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
      const header = [
        'Visit ID', 'Date', 'Time In', 'Visitor', 'Company', 'Phone', 'Members', 'Purpose',
        'Visiting', 'Logged By', 'Status', 'Decided By', 'Decided At',
        'Rejection Reason', 'Checked In', 'Checked Out',
      ];
      const lines = [header.map(csvCell).join(',')];
      for (const v of visits) {
        lines.push([
          v.id,
          new Date(v.created_at).toLocaleDateString('en-IN', { timeZone: config.timezone }),
          new Date(v.created_at).toLocaleTimeString('en-IN', { timeZone: config.timezone }),
          v.full_name,
          v.company,
          v.phone,
          v.companion_count,
          v.purpose,
          v.host_display,
          v.logged_by_name,
          v.status,
          v.approved_by_name,
          v.decision_at ? new Date(v.decision_at).toLocaleString('en-IN', { timeZone: config.timezone }) : '',
          v.rejection_reason,
          v.checked_in_at ? new Date(v.checked_in_at).toLocaleString('en-IN', { timeZone: config.timezone }) : '',
          v.checked_out_at ? new Date(v.checked_out_at).toLocaleString('en-IN', { timeZone: config.timezone }) : '',
        ].map(csvCell).join(','));
      }

      const label = date || new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="gatepass-${label}.csv"`);
      // BOM so Excel opens Indian names and Tamil text in UTF-8 rather than mojibake.
      return res.send('﻿' + lines.join('\r\n'));
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
