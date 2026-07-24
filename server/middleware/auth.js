'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { query } = require('../db');

function signToken(user) {
  const ttl = config.tokenTtl[user.role] || '12h';
  return jwt.sign({ sub: user.id, role: user.role, username: user.username }, config.jwtSecret, {
    expiresIn: ttl,
  });
}

function setAuthCookie(res, token) {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
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
      'SELECT id, name, username, phone, role, is_active FROM users WHERE id = $1',
      [payload.sub]
    );
    const user = rows[0];
    if (!user || !user.is_active) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'ACCOUNT_INACTIVE' });
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { signToken, setAuthCookie, clearAuthCookie, requireAuth };
