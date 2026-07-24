'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function required(name, fallback) {
  const value = process.env[name] || fallback;
  if (!value) {
    console.error(`[config] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const isProd = process.env.NODE_ENV === 'production';

// In production a weak or default secret would silently make every token forgeable.
const jwtSecret = required('JWT_SECRET');
if (isProd && (jwtSecret.length < 32 || jwtSecret.includes('CHANGE_ME'))) {
  console.error('[config] JWT_SECRET must be a real random string of 32+ characters in production.');
  process.exit(1);
}

module.exports = {
  isProd,
  port: Number(process.env.PORT || 3040),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret,
  // Secure cookies require HTTPS; allow opting out for local http development only.
  cookieSecure: process.env.COOKIE_SECURE !== 'false',
  photoDir: process.env.PHOTO_DIR || path.join(__dirname, '..', 'photos'),
  cookieName: 'gp_token',
  // "Today" at the gate means the local day, not the server's UTC day — a visitor
  // logged at 9pm IST must not appear on tomorrow's list.
  timezone: process.env.APP_TZ || 'Asia/Kolkata',
  // Sessions: security staff re-login each shift, office roles stay signed in.
  tokenTtl: { SECURITY: '12h', ADMIN: '7d', SUPERADMIN: '7d' },
  // A pending request older than this shows up in the shared "Unattended" list.
  unattendedAfterSeconds: 10 * 60,
  maxCompanions: 10,
  maxPhotoBytes: 8 * 1024 * 1024,
  seed: {
    username: process.env.SEED_ADMIN_USER || 'superadmin',
    password: process.env.SEED_ADMIN_PASS || '',
    name: process.env.SEED_ADMIN_NAME || 'Super Admin',
  },
};
