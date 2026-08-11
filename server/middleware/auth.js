'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { query } = require('../db');

function signToken(user) {
  const ttl = config.tokenTtl[user.role] || '12h';
  return jwt.sign(
    // tv pins the token to the credential generation it was minted at; see
    // requireAuth and bumpTokenVersion.
    { sub: user.id, role: user.role, username: user.username, tv: Number(user.token_version) || 0 },
    config.jwtSecret,
    { expiresIn: ttl }
  );
}

/** Cookie lifetime follows the token's own TTL — a 12h guard token in a 7-day
 *  cookie just leaves a dead cookie sitting on the shared gate phone. */
function cookieMaxAge(role) {
  return role === 'SECURITY' ? 12 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
}

function setAuthCookie(res, token, role) {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    maxAge: cookieMaxAge(role),
    path: '/',
  });
}

function clearAuthCookie(res) {
  res.clearCookie(config.cookieName, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
  });
}

/**
 * Invalidates every session for a user by moving their token version on.
 * Call this from any credential change (password, PIN, passkey removal).
 * Returns the new version so the caller can re-issue its own cookie and stay
 * signed in — otherwise changing your own password would log you out.
 */
async function bumpTokenVersion(userId, client) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(
    'UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING token_version',
    [userId]
  );
  return rows[0] ? rows[0].token_version : 0;
}

/**
 * Verifies the JWT and re-reads the user from the database on every request.
 * Re-reading is deliberate: a deactivated account must lose access immediately,
 * not whenever its 7-day token happens to expire.
 */
async function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[config.cookieName];
  if (!token) return res.status(401).json({ error: 'NOT_AUTHENTICATED' });

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch (err) {
    clearAuthCookie(res);
    return res.status(401).json({ error: 'SESSION_EXPIRED' });
  }

  try {
    const { rows } = await query(
      `SELECT id, name, username, phone, role, is_active, must_change_pin, token_version,
              (pin_hash IS NOT NULL) AS pin_hash
       FROM users WHERE id = $1`,
      [payload.sub]
    );
    const user = rows[0];
    if (!user || !user.is_active) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'ACCOUNT_INACTIVE' });
    }
    // A credential changed since this token was issued — treat it as expired.
    if (Number(payload.tv || 0) !== Number(user.token_version)) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'SESSION_EXPIRED' });
    }
    req.user = user;
    // Chained rather than mounted per-route so a future endpoint cannot forget it.
    return requirePinChangeDone(req, res, next);
  } catch (err) {
    next(err);
  }
}

/**
 * A guard signed in with a temporary PIN must replace it before doing anything
 * else. The React client shows a blocking screen, but the client is not the
 * enforcement point: the superadmin who issued that temporary PIN knows it, so
 * without this gate they could drive the API as the guard. "Restore access, not
 * borrow it" has to hold at the API, not just in the UI.
 */
const PIN_CHANGE_ALLOWED = [
  'POST /api/auth/pin',
  'GET /api/auth/me',
  'POST /api/auth/logout',
];

function requirePinChangeDone(req, res, next) {
  if (!req.user || !req.user.must_change_pin) return next();
  const route = `${req.method} ${req.baseUrl}${req.path}`.replace(/\/$/, '');
  if (PIN_CHANGE_ALLOWED.includes(route)) return next();
  return res.status(403).json({
    error: 'PIN_CHANGE_REQUIRED',
    message: 'Set your own PIN before continuing.',
  });
}

module.exports = {
  signToken,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
  requirePinChangeDone,
  bumpTokenVersion,
};
