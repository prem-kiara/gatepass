'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { str, uuid } = require('../lib/validate');
const { VISIT_SELECT, decorate } = require('../lib/visitQueries');

const router = express.Router();
const approvers = [requireAuth, requireRole('ADMIN', 'SUPERADMIN')];

/**
 * GET /api/approvals/pending
 * The shared queue. Every admin and the superadmin see the same rows — the request
 * is broadcast, not routed — with the longest-waiting first so nothing is stranded.
 */
router.get('/pending', ...approvers, async (req, res, next) => {
  try {
    const { rows } = await query(
      `${VISIT_SELECT} WHERE v.status = 'PENDING' ORDER BY v.created_at ASC`
    );
    const visits = rows.map(decorate);
    res.json({
      visits,
      count: visits.length,
      unattended_count: visits.filter((v) => v.unattended).length,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/approvals/history — decisions this user personally made.
 * Superadmins get the same "own decisions" view here; the full history lives
 * in the console under /api/admin/visits.
 */
router.get('/history', ...approvers, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const { rows } = await query(
      `${VISIT_SELECT}
       WHERE v.approved_by = $1
       ORDER BY v.decision_at DESC
       LIMIT $2`,
      [req.user.id, limit]
    );
    res.json({ visits: rows.map(decorate) });
  } catch (err) {
    next(err);
  }
});

/**
 * The core audit guarantee. `WHERE status = 'PENDING'` makes the decision atomic:
 * whichever admin's UPDATE reaches the row first wins, and the loser's zero-row
 * result becomes a 409 carrying the decision that actually stuck — so their screen
 * flips to "Approved by <name>" instead of showing an error or double-recording.
 */
async function decide(req, res, next, { status, action, reason }) {
  try {
    const visitId = uuid(req.params.id, 'Visit', { required: true });

    const won = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE visits
         SET status = $1, approved_by = $2, decision_at = now(), rejection_reason = $3
         WHERE id = $4 AND status = 'PENDING'
         RETURNING id`,
        [status, req.user.id, reason, visitId]
      );
      if (rows.length === 0) return false;

      await client.query(
        `INSERT INTO visit_events (visit_id, actor_id, action, detail) VALUES ($1, $2, $3, $4)`,
        [visitId, req.user.id, action, JSON.stringify(reason ? { reason } : {})]
      );
      return true;
    });

    const { rows } = await query(`${VISIT_SELECT} WHERE v.id = $1`, [visitId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'That visit no longer exists.' });
    }
    const visit = decorate(rows[0]);

    if (!won) {
      return res.status(409).json({
        error: 'ALREADY_DECIDED',
        message: `Already ${visit.status.toLowerCase()} by ${visit.approved_by_name || 'another admin'}.`,
        visit,
      });
    }

    res.json({ visit });
  } catch (err) {
    next(err);
  }
}

router.post('/:id/approve', ...approvers, (req, res, next) =>
  decide(req, res, next, { status: 'APPROVED', action: 'APPROVED', reason: null })
);

router.post('/:id/reject', ...approvers, (req, res, next) => {
  let reason = null;
  try {
    reason = str(req.body && req.body.reason, 'Reason', { max: 500 });
  } catch (err) {
    return next(err);
  }
  return decide(req, res, next, { status: 'REJECTED', action: 'REJECTED', reason });
});

module.exports = router;
