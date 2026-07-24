'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const push = require('../lib/push');
const { ValidationError } = require('../lib/validate');

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/notifications — this user's history, newest first.
 * Nothing is ever removed, so this is paginated rather than trimmed.
 */
router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const unreadOnly = req.query.unread === '1';

    const where = unreadOnly ? 'WHERE n.user_id = $1 AND n.read_at IS NULL' : 'WHERE n.user_id = $1';

    const [list, totals] = await Promise.all([
      query(
        `SELECT n.id, n.type, n.title, n.body, n.visit_id, n.url, n.data,
                n.created_at, n.read_at, n.resolved_at, n.pushed_at,
                v.status AS visit_status
         FROM notifications n
         LEFT JOIN visits v ON v.id = n.visit_id
         ${where}
         ORDER BY n.created_at DESC, n.id DESC
         LIMIT ${limit} OFFSET ${offset}`,
        [req.user.id]
      ),
      query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE read_at IS NULL)::int AS unread
         FROM notifications WHERE user_id = $1`,
        [req.user.id]
      ),
    ]);

    res.json({
      notifications: list.rows,
      total: totals.rows[0].total,
      unread: totals.rows[0].unread,
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
});

/** Cheap endpoint for the badge — polled alongside the existing screens. */
router.get('/unread-count', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT count(*)::int AS unread FROM notifications WHERE user_id = $1 AND read_at IS NULL',
      [req.user.id]
    );
    res.json({ unread: rows[0].unread });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/read', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('Invalid notification.', 'id');

    // Scoped to the owner so one user can never mark another's notifications read.
    const { rows } = await query(
      `UPDATE notifications SET read_at = COALESCE(read_at, now())
       WHERE id = $1 AND user_id = $2
       RETURNING id, read_at`,
      [id, req.user.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'No such notification.' });
    }
    res.json({ notification: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/read-all', async (req, res, next) => {
  try {
    const { rowCount } = await query(
      'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL',
      [req.user.id]
    );
    res.json({ marked: rowCount });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------- push setup */

/** The frontend needs the VAPID public key before it can subscribe. */
router.get('/push/public-key', (req, res) => {
  res.json({ publicKey: push.publicKey(), enabled: push.isConfigured() });
});

router.post('/push/subscribe', async (req, res, next) => {
  try {
    const id = await push.saveSubscription(
      req.user.id,
      req.body && req.body.subscription,
      req.get('user-agent')
    );
    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

router.post('/push/unsubscribe', async (req, res, next) => {
  try {
    const endpoint = req.body && req.body.endpoint;
    if (!endpoint) throw new ValidationError('Endpoint is required.', 'endpoint');
    await push.removeSubscription(req.user.id, endpoint);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Sends a real push to this user's devices so they can confirm setup works. */
router.post('/push/test', async (req, res, next) => {
  try {
    const delivered = await push.pushToUser(req.user.id, {
      type: 'TEST',
      title: 'GatePass notifications are on',
      body: 'This is a test. Real alerts will look like this.',
      url: '/',
    });
    res.json({ delivered });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
