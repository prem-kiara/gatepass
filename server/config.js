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
  // A pending request older than this shows up in the shared "Unattended" list
  // and triggers an escalation notification to every admin.
  unattendedAfterSeconds: 10 * 60,
  // Web Push. Generate a keypair with `npm run vapid`. Without these the app
  // runs normally and notifications still accumulate in the in-app history —
  // only the phone's notification shade goes quiet.
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:contact@dhanam.finance',
  },
  // WebAuthn (passkeys / Face ID / fingerprint). rpId must be the registrable
  // domain and origin its https URL. Defaults suit production; override for local
  // dev (WEBAUTHN_RP_ID=localhost, WEBAUTHN_ORIGIN=http://localhost:3040).
  webauthn: {
    rpName: process.env.WEBAUTHN_RP_NAME || 'GatePass',
    rpId: process.env.WEBAUTHN_RP_ID || 'gatepass.dhanamfinance.com',
    origin: process.env.WEBAUTHN_ORIGIN || 'https://gatepass.dhanamfinance.com',
  },
  maxCompanions: 10,
  maxPhotoBytes: 8 * 1024 * 1024,
  seed: {
    username: process.env.SEED_ADMIN_USER || 'superadmin',
    password: process.env.SEED_ADMIN_PASS || '',
    name: process.env.SEED_ADMIN_NAME || 'Super Admin',
  },
};
