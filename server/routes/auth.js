'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const { signToken, setAuthCookie, clearAuthCookie, requireAuth } = require('../middleware/auth');
const { str } = require('../lib/validate');

const router = express.Router();

// Gates sit behind a single NAT'd connection, so limit by username+IP rather than
// IP alone — otherwise one guard fat-fingering a password locks out the whole gate.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${String((req.body && req.body.username) || '').toLowerCase()}`,
  handler: (req, res) =>
    res.status(429).json({ error: 'TOO_MANY_ATTEMPTS', message: 'Too many login attempts. Try again in a few minutes.' }),
});

function publicUser(user) {
  return { id: user.id, name: user.name, username: user.username, phone: user.phone, role: user.role };
}

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const username = str(req.body.username, 'Username', { required: true, max: 100 }).toLowerCase();
    const password = str(req.body.password, 'Password', { required: true, max: 200 });

    const { rows } = await query(
      'SELECT id, name, username, phone, password_hash, role, is_active FROM users WHERE lower(username) = $1',
      [username]
    );
    const user = rows[0];

    // Same response for unknown user and wrong password so the endpoint cannot
    // be used to enumerate which accounts exist.
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Incorrect username or password.' });
    }
    if (!user.is_active) {
      return res.status(403).json({ error: 'ACCOUNT_INACTIVE', message: 'This account has been deactivated.' });
    }

    setAuthCookie(res, signToken(user));
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const current = str(req.body.currentPassword, 'Current password', { required: true, max: 200 });
    const next_ = str(req.body.newPassword, 'New password', { required: true, min: 8, max: 200 });

    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const ok = await bcrypt.compare(current, rows[0].password_hash);
    if (!ok) {
      return res.status(400).json({ error: 'WRONG_PASSWORD', message: 'Your current password is incorrect.' });
    }

    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(next_, 12), req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
