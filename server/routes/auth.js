'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { query, withTransaction } = require('../db');
const notify = require('../lib/notify');
const {
  signToken,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
  bumpTokenVersion,
} = require('../middleware/auth');
const { str, uuid, ValidationError } = require('../lib/validate');
const { validatePin, hashPin, verifyPin, needsRehash, MAX_ATTEMPTS, LOCK_MINUTES } = require('../lib/pin');
const { logAuth } = require('../lib/authlog');
const webauthn = require('../lib/webauthn');

const router = express.Router();

// Gates sit behind a single NAT'd connection, so limit by identity+IP rather than
// IP alone — otherwise one guard fat-fingering a password locks out the whole gate.
function identityLimiter(idField) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${req.ip}:${String((req.body && req.body[idField]) || '').toLowerCase()}`,
    handler: (req, res) =>
      res.status(429).json({ error: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Try again in a few minutes.' }),
  });
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    phone: user.phone,
    role: user.role,
    must_change_pin: Boolean(user.must_change_pin),
    has_pin: Boolean(user.pin_hash),
  };
}

/* ------------------------------------------------------------ name picker */

/**
 * The gate phone is shared, so guards sign in by tapping their name rather than
 * typing a username. This lists only active SECURITY staff and only their id +
 * name — enough to render the picker, nothing more. It is pre-auth by necessity
 * (you cannot have logged in yet) and rate-limited.
 */
const pickerLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
router.get('/gate-users', pickerLimiter, async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT id, name, (pin_hash IS NOT NULL) AS has_pin FROM users WHERE role = 'SECURITY' AND is_active = true ORDER BY name"
    );
    res.json({ users: rows });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------ password login */

router.post('/login', identityLimiter('username'), async (req, res, next) => {
  try {
    const username = str(req.body.username, 'Username', { required: true, max: 100 }).toLowerCase();
    const password = str(req.body.password, 'Password', { required: true, max: 200 });

    const { rows } = await query(
      `SELECT id, name, username, phone, password_hash, role, is_active, pin_hash, must_change_pin, token_version
       FROM users WHERE lower(username) = $1`,
      [username]
    );
    const user = rows[0];

    // Same response for unknown user and wrong password so the endpoint cannot
    // be used to enumerate which accounts exist.
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) {
      await logAuth({ userId: user ? user.id : null, event: 'LOGIN_FAILED', method: 'PASSWORD', req, detail: { username } });
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Incorrect username or password.' });
    }
    if (!user.is_active) {
      // Correct credentials against a disabled account is worth recording — it is
      // either a stale device or someone trying an account you switched off.
      await logAuth({
        userId: user.id, event: 'LOGIN_FAILED', method: 'PASSWORD', req, detail: { reason: 'account_inactive' },
      });
      return res.status(403).json({ error: 'ACCOUNT_INACTIVE', message: 'This account has been deactivated.' });
    }

    setAuthCookie(res, signToken(user), user.role);
    await logAuth({ userId: user.id, actorId: user.id, event: 'LOGIN', method: 'PASSWORD', req });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

/* ----------------------------------------------------------------- PIN login */

router.post('/login-pin', identityLimiter('userId'), async (req, res, next) => {
  try {
    const userId = uuid(req.body.userId, 'User', { required: true });
    const pin = str(req.body.pin, 'PIN', { required: true, max: 12 });

    const { rows } = await query(
      `SELECT id, name, username, phone, role, is_active, pin_hash, must_change_pin, token_version,
              pin_failed_attempts, pin_locked_until
       FROM users WHERE id = $1`,
      [userId]
    );
    const user = rows[0];

    // PIN is a guard credential; admins use their password or a passkey.
    if (!user || user.role !== 'SECURITY' || !user.pin_hash) {
      await logAuth({ userId: user ? user.id : null, event: 'LOGIN_FAILED', method: 'PIN', req, detail: { reason: 'no_pin' } });
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Wrong PIN.' });
    }
    if (!user.is_active) {
      await logAuth({ userId: user.id, event: 'LOGIN_FAILED', method: 'PIN', req, detail: { reason: 'account_inactive' } });
      return res.status(403).json({ error: 'ACCOUNT_INACTIVE', message: 'This account has been deactivated.' });
    }
    if (user.pin_locked_until && new Date(user.pin_locked_until) > new Date()) {
      // Attempts made *during* a lock were previously invisible — exactly the
      // window where someone is grinding guesses.
      await logAuth({ userId: user.id, event: 'LOGIN_FAILED', method: 'PIN', req, detail: { reason: 'locked' } });
      const mins = Math.ceil((new Date(user.pin_locked_until) - new Date()) / 60000);
      return res.status(429).json({ error: 'PIN_LOCKED', message: `Too many wrong PINs. Try again in ${mins} min, or sign in with a password.` });
    }

    const ok = await verifyPin(pin, user.pin_hash);
    if (!ok) {
      // Count the miss and decide the lock in ONE statement: a read-then-write
      // let concurrent guesses slip past the limit.
      const { rows: after } = await query(
        `UPDATE users
         SET pin_failed_attempts = pin_failed_attempts + 1,
             pin_locked_until = CASE
               WHEN pin_failed_attempts + 1 >= $2 THEN now() + ($3 || ' minutes')::interval
               ELSE pin_locked_until END
         WHERE id = $1
         RETURNING pin_failed_attempts, pin_locked_until`,
        [user.id, MAX_ATTEMPTS, String(LOCK_MINUTES)]
      );
      const attempts = after[0].pin_failed_attempts;
      const locked = after[0].pin_locked_until && new Date(after[0].pin_locked_until) > new Date();

      if (locked) {
        await logAuth({ userId: user.id, event: 'PIN_LOCKED', req, detail: { attempts } });
        // Someone is guessing at the gate phone — tell the superadmins now
        // rather than leaving it for whoever next reads the log.
        try {
          const created = await withTransaction((client) =>
            notify.securityAlert(client, {
              type: 'SECURITY_PIN_LOCKED',
              title: 'A gate PIN was locked',
              body: `${user.name}'s PIN was locked after ${attempts} wrong attempts.`,
            })
          );
          notify.scheduleDelivery(created);
        } catch (e) {
          console.error('[auth] lock alert failed:', e.message);
        }
        return res.status(429).json({ error: 'PIN_LOCKED', message: `Too many wrong PINs. Try again in ${LOCK_MINUTES} min, or sign in with a password.` });
      }
      await logAuth({ userId: user.id, event: 'LOGIN_FAILED', method: 'PIN', req, detail: { attempts } });
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Wrong PIN.' });
    }

    // Success — clear the miss counter and any lock. Upgrade a legacy
    // (un-peppered) hash in passing, now that we have the plaintext in hand.
    const rehash = needsRehash(user.pin_hash) ? await hashPin(pin) : null;
    await query(
      `UPDATE users SET pin_failed_attempts = 0, pin_locked_until = NULL${rehash ? ', pin_hash = $2' : ''} WHERE id = $1`,
      rehash ? [user.id, rehash] : [user.id]
    );

    setAuthCookie(res, signToken(user), user.role);
    const method = user.must_change_pin ? 'TEMP_PIN' : 'PIN';
    await logAuth({ userId: user.id, actorId: user.id, event: 'LOGIN', method, req });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------- sessions */

/**
 * Always clears the cookie, even when the token is already invalid — otherwise
 * an expired session cannot log itself out and the stale cookie lingers on a
 * shared phone. The audit row is written only when we know who it was.
 */
router.post('/logout', async (req, res, next) => {
  try {
    const token = req.cookies && req.cookies[config.cookieName];
    clearAuthCookie(res);
    if (token) {
      try {
        const payload = jwt.verify(token, config.jwtSecret);
        await logAuth({ userId: payload.sub, actorId: payload.sub, event: 'LOGOUT', req });
      } catch (err) {
        /* expired or forged token — nothing trustworthy to record */
      }
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

/* ------------------------------------------------------------ set / change PIN */

/**
 * A guard sets or changes their own PIN.
 *  - Changing an existing PIN requires the current PIN (or the password, if they
 *    are mid-reset with a temporary one they already used to sign in).
 *  - must_change_pin is cleared on success, so a temporary PIN can only ever be
 *    used once before the guard has replaced it with a private one.
 *  - Every other session for this user is invalidated: if a temporary PIN leaked,
 *    setting a real one must cut off whoever else was holding it.
 */
router.post('/pin', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'SECURITY') {
      throw new ValidationError('A PIN is only for gate (security) sign-in.', 'role');
    }

    const { rows } = await query('SELECT pin_hash, must_change_pin FROM users WHERE id = $1', [req.user.id]);
    const existing = rows[0];
    const newPin = validatePin(req.body.newPin, 'New PIN');

    // If they already have a real (non-temporary) PIN, they must prove the old one.
    if (existing.pin_hash && !existing.must_change_pin) {
      const current = str(req.body.currentPin, 'Current PIN', { required: true, max: 12 });
      const ok = await verifyPin(current, existing.pin_hash);
      if (!ok) {
        return res.status(400).json({ error: 'WRONG_PIN', message: 'Your current PIN is incorrect.' });
      }
    }

    await query(
      `UPDATE users
       SET pin_hash = $2, pin_set_at = now(), must_change_pin = false,
           pin_failed_attempts = 0, pin_locked_until = NULL
       WHERE id = $1`,
      [req.user.id, await hashPin(newPin)]
    );
    const tokenVersion = await bumpTokenVersion(req.user.id);
    // Re-issue our own cookie so the person making the change stays signed in.
    setAuthCookie(res, signToken({ ...req.user, token_version: tokenVersion }), req.user.role);

    await logAuth({
      userId: req.user.id,
      actorId: req.user.id,
      event: existing.pin_hash ? 'PIN_CHANGED' : 'PIN_SET',
      req,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
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
    // Changing a password must sign out anyone else holding a session.
    const tokenVersion = await bumpTokenVersion(req.user.id);
    setAuthCookie(res, signToken({ ...req.user, token_version: tokenVersion }), req.user.role);

    await logAuth({ userId: req.user.id, actorId: req.user.id, event: 'PASSWORD_CHANGED', req });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------- passkeys (biometric) */

// Registering a device requires you to already be signed in (so we know whose
// device it is). Biometric is for the office roles; guards use a PIN.
router.post('/webauthn/register/options', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role === 'SECURITY') {
      throw new ValidationError('Biometric sign-in is for admin accounts. Guards use a PIN.', 'role');
    }
    res.json(await webauthn.registrationOptions(req.user, res));
  } catch (err) {
    next(err);
  }
});

router.post('/webauthn/register/verify', requireAuth, async (req, res, next) => {
  try {
    const result = await webauthn.verifyRegistration(req.user, req, res, req.body || {});
    await logAuth({ userId: req.user.id, actorId: req.user.id, event: 'WEBAUTHN_REGISTERED', method: 'WEBAUTHN', req });
    res.status(201).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// Signing in with a passkey is unauthenticated by definition — the passkey is
// the proof. Discoverable credentials mean no username is typed.
router.post('/webauthn/login/options', async (req, res, next) => {
  try {
    res.json(await webauthn.loginOptions(res));
  } catch (err) {
    next(err);
  }
});

router.post('/webauthn/login/verify', async (req, res, next) => {
  try {
    let user;
    try {
      user = await webauthn.verifyLogin(req, res, req.body || {});
    } catch (err) {
      // A passkey that fails verification is the most interesting failure of all
      // — it means a credential was presented and rejected.
      await logAuth({
        event: 'LOGIN_FAILED', method: 'WEBAUTHN', req,
        detail: { reason: err.reason || 'verification_failed' },
      });
      throw err;
    }

    if (!user.is_active) {
      await logAuth({ userId: user.id, event: 'LOGIN_FAILED', method: 'WEBAUTHN', req, detail: { reason: 'account_inactive' } });
      return res.status(403).json({ error: 'ACCOUNT_INACTIVE', message: 'This account has been deactivated.' });
    }
    setAuthCookie(res, signToken(user), user.role);
    await logAuth({ userId: user.id, actorId: user.id, event: 'LOGIN', method: 'WEBAUTHN', req });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

// The user's own registered devices, and removing one (e.g. a lost phone).
router.get('/webauthn/devices', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, device_label, created_at, last_used_at
       FROM webauthn_credentials
       WHERE user_id = $1 AND disabled_at IS NULL
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ devices: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * Removing a device disables it rather than deleting the row: the auth log
 * references these devices, and "deactivate, never delete" is how the rest of
 * this system keeps its history resolvable.
 */
router.delete('/webauthn/devices/:id', requireAuth, async (req, res, next) => {
  try {
    const id = uuid(req.params.id, 'Device', { required: true });
    const { rowCount } = await query(
      'UPDATE webauthn_credentials SET disabled_at = now() WHERE id = $1 AND user_id = $2 AND disabled_at IS NULL',
      [id, req.user.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such device.' });

    // Losing a phone should end sessions started from it.
    const tokenVersion = await bumpTokenVersion(req.user.id);
    setAuthCookie(res, signToken({ ...req.user, token_version: tokenVersion }), req.user.role);

    await logAuth({ userId: req.user.id, actorId: req.user.id, event: 'WEBAUTHN_REMOVED', req });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
