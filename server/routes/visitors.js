'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { normalizePhone } = require('../lib/validate');

const router = express.Router();

/**
 * GET /api/visitors/lookup?phone=
 * Repeat-visitor prefill: returns the name and last-visit context so security does
 * not retype details for a regular. The photo is deliberately not reused — the
 * whole point is a photo of who is at the gate right now.
 */
router.get('/lookup', requireAuth, requireRole('SECURITY'), async (req, res, next) => {
  try {
    const phone = normalizePhone(req.query.phone, 'Phone number', { required: true });

    const { rows } = await query(
      `SELECT vis.id, vis.full_name, vis.phone,
              last.purpose, last.host_admin_id, last.host_name, last.created_at AS last_visit_at,
              (SELECT count(*) FROM visits v2 WHERE v2.visitor_id = vis.id)::int AS visit_count
       FROM visitors vis
       LEFT JOIN LATERAL (
         SELECT purpose, host_admin_id, host_name, created_at
         FROM visits WHERE visitor_id = vis.id
         ORDER BY created_at DESC LIMIT 1
       ) last ON true
       WHERE vis.phone = $1
       ORDER BY vis.created_at LIMIT 1`,
      [phone]
    );

    if (rows.length === 0) return res.json({ found: false, visitor: null });
    res.json({ found: true, visitor: rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/visitors/hosts
 * The admins a visitor can be here to see. Security needs this to fill the
 * "whom to visit" picker; deactivated accounts are excluded.
 */
router.get('/hosts', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, role FROM users
       WHERE is_active = true AND role IN ('ADMIN', 'SUPERADMIN')
       ORDER BY name`
    );
    res.json({ hosts: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
