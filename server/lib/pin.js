'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { ValidationError } = require('./validate');

const PIN_LENGTH = 6;
const MAX_ATTEMPTS = 5;      // wrong tries before a temporary lock
const LOCK_MINUTES = 15;

// Marks a hash as peppered, so a legacy row can be spotted and upgraded on next
// successful sign-in rather than needing a migration that cannot see plaintext.
const PEPPER_PREFIX = 'p1$';

/**
 * Any 6 digits is accepted, including obvious ones like 123456.
 *
 * We used to reject all-same and straight sequences. That was belt-and-braces:
 * what actually protects a 6-digit secret is the lockout (5 wrong tries, then
 * 15 minutes for that guard only) and the pepper, which makes a leaked hash
 * useless offline. Deliberate product call — memorability at a gate counter
 * beats a rule that mostly annoys the people who have to type it in sunlight.
 */
function validatePin(value, field = 'PIN') {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(s)) {
    throw new ValidationError(`${field} must be ${PIN_LENGTH} digits.`, 'pin');
  }
  return s;
}

/**
 * Pre-hash the PIN with a server-side secret before bcrypt.
 *
 * Six digits is a 10^6 keyspace — bcrypt alone would fall to an offline attack
 * in hours if the database ever leaked. The pepper lives in the environment,
 * not the database, so a dumped `users` table is useless without also
 * compromising the server.
 */
function peppered(pin) {
  return crypto.createHmac('sha256', config.pinPepper).update(String(pin)).digest('base64');
}

async function hashPin(pin) {
  return PEPPER_PREFIX + (await bcrypt.hash(peppered(pin), 12));
}

/** True for hashes written before the pepper existed. */
function needsRehash(hash) {
  return typeof hash === 'string' && !hash.startsWith(PEPPER_PREFIX);
}

/**
 * Verifies against either format. Legacy (un-peppered) hashes still validate so
 * the guards already using PINs are not locked out by this change; the caller
 * upgrades the stored hash on the next successful sign-in.
 */
async function verifyPin(pin, hash) {
  if (!hash) return false;
  if (hash.startsWith(PEPPER_PREFIX)) {
    return bcrypt.compare(peppered(pin), hash.slice(PEPPER_PREFIX.length));
  }
  return bcrypt.compare(pin, hash);
}

/** Generates a random temporary PIN for a superadmin reset (crypto RNG). */
function randomTempPin() {
  let pin = '';
  for (let i = 0; i < PIN_LENGTH; i += 1) pin += String(crypto.randomInt(0, 10));
  return pin;
}

module.exports = {
  PIN_LENGTH,
  MAX_ATTEMPTS,
  LOCK_MINUTES,
  validatePin,
  hashPin,
  verifyPin,
  needsRehash,
  randomTempPin,
};
