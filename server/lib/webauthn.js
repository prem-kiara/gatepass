'use strict';

/**
 * Passkeys (WebAuthn) — Face ID on iPhone, fingerprint/face on Android.
 *
 * The biometric never reaches us: the phone verifies the user locally and hands
 * back a signed assertion. We store only a public key, so there is no secret on
 * our side and nothing here can expose anyone's face or fingerprint.
 *
 * The per-ceremony challenge is kept in a short-lived signed cookie rather than a
 * table — a ceremony lasts seconds, and a stateless cookie avoids a cleanup job.
 */

const jwt = require('jsonwebtoken');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const config = require('../config');
const { query } = require('../db');

const CHALLENGE_COOKIE = 'gp_wa';
const { rpId, rpName, origin } = config.webauthn;

function setChallenge(res, payload) {
  const token = jwt.sign(payload, config.jwtSecret, { expiresIn: '5m' });
  res.cookie(CHALLENGE_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    maxAge: 5 * 60 * 1000,
    path: '/',
  });
}

function readChallenge(req, expectedPurpose) {
  const token = req.cookies && req.cookies[CHALLENGE_COOKIE];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (payload.purpose !== expectedPurpose) return null;
    return payload;
  } catch (err) {
    return null;
  }
}

function clearChallenge(res) {
  res.clearCookie(CHALLENGE_COOKIE, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/' });
}

/* --------------------------------------------------------------- register */

async function registrationOptions(user, res) {
  const { rows } = await query(
    'SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1 AND disabled_at IS NULL',
    [user.id]
  );
  const options = await generateRegistrationOptions({
    rpName,
    rpID: rpId,
    userName: user.username,
    userDisplayName: user.name,
    attestationType: 'none',
    // Don't let the same device register twice.
    excludeCredentials: rows.map((r) => ({
      id: r.credential_id,
      transports: r.transports ? JSON.parse(r.transports) : undefined,
    })),
    // Platform authenticator (the phone itself), with the biometric gesture.
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });

  setChallenge(res, { purpose: 'reg', userId: user.id, challenge: options.challenge });
  return options;
}

async function verifyRegistration(user, req, res, body) {
  const saved = readChallenge(req, 'reg');
  if (!saved || saved.userId !== user.id) {
    const err = new Error('Your registration attempt expired. Please try again.');
    err.status = 400;
    throw err;
  }

  const verification = await verifyRegistrationResponse({
    response: body.credential,
    expectedChallenge: saved.challenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    requireUserVerification: false,
  });
  clearChallenge(res);

  if (!verification.verified || !verification.registrationInfo) {
    const err = new Error('We could not verify that device.');
    err.status = 400;
    throw err;
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  await query(
    `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, device_label)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (credential_id) DO NOTHING`,
    [
      user.id,
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter || 0,
      credential.transports ? JSON.stringify(credential.transports) : null,
      (body.deviceLabel || 'This device').slice(0, 80),
    ]
  );
  return { deviceType: credentialDeviceType, backedUp: credentialBackedUp };
}

/* ------------------------------------------------------------------ login */

async function loginOptions(res) {
  // Empty allowCredentials → the phone offers its discoverable passkeys; the
  // user never types a username.
  const options = await generateAuthenticationOptions({ rpID: rpId, userVerification: 'preferred', allowCredentials: [] });
  setChallenge(res, { purpose: 'auth', challenge: options.challenge });
  return options;
}

async function verifyLogin(req, res, body) {
  const saved = readChallenge(req, 'auth');
  if (!saved) {
    const err = new Error('Your sign-in attempt expired. Please try again.');
    err.status = 400;
    err.reason = 'challenge_expired';
    throw err;
  }

  const credentialId = body.credential && body.credential.id;
  const { rows } = await query(
    `SELECT c.*, u.id AS uid, u.name, u.username, u.phone, u.role, u.is_active, u.must_change_pin,
            u.token_version, (u.pin_hash IS NOT NULL) AS pin_hash
     FROM webauthn_credentials c JOIN users u ON u.id = c.user_id
     WHERE c.credential_id = $1 AND c.disabled_at IS NULL`,
    [credentialId]
  );
  const cred = rows[0];
  if (!cred) {
    const err = new Error('That passkey is not registered.');
    err.status = 401;
    err.reason = 'unknown_credential';
    throw err;
  }

  const verification = await verifyAuthenticationResponse({
    response: body.credential,
    expectedChallenge: saved.challenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    credential: {
      id: cred.credential_id,
      publicKey: new Uint8Array(cred.public_key),
      counter: Number(cred.counter),
      transports: cred.transports ? JSON.parse(cred.transports) : undefined,
    },
    requireUserVerification: false,
  });
  clearChallenge(res);

  if (!verification.verified) {
    const err = new Error('That passkey could not be verified.');
    err.status = 401;
    err.reason = 'signature_invalid';
    throw err;
  }

  await query('UPDATE webauthn_credentials SET counter = $2, last_used_at = now() WHERE id = $1', [
    cred.id,
    verification.authenticationInfo.newCounter,
  ]);

  return {
    id: cred.uid,
    name: cred.name,
    username: cred.username,
    phone: cred.phone,
    role: cred.role,
    is_active: cred.is_active,
    must_change_pin: cred.must_change_pin,
    pin_hash: cred.pin_hash,
    token_version: cred.token_version,
  };
}

module.exports = { registrationOptions, verifyRegistration, loginOptions, verifyLogin, clearChallenge };
