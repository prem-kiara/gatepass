'use strict';

const { ValidationError } = require('./validate');

const PIN_LENGTH = 6;
const MAX_ATTEMPTS = 5;      // wrong tries before a temporary lock
const LOCK_MINUTES = 15;

/**
 * A 6-digit PIN is low entropy, so we reject the handful of PINs an attacker
 * would try first (all-same, straight run up or down). The lockout does the
 * real work; this just removes the free guesses.
 */
function validatePin(value, field = 'PIN') {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(s)) {
    throw new ValidationError(`${field} must be ${PIN_LENGTH} digits.`, 'pin');
  }
  if (/^(\d)\1+$/.test(s)) {
    throw new ValidationError('Choose a less obvious PIN — not all the same digit.', 'pin');
  }
  const ASCEND = '0123456789';
  const DESCEND = '9876543210';
  if (ASCEND.includes(s) || DESCEND.includes(s)) {
    throw new ValidationError('Choose a less obvious PIN — not a simple sequence.', 'pin');
  }
  return s;
}

/** Generates a random temporary PIN for a superadmin reset (crypto RNG). */
function randomTempPin() {
  const { randomInt } = require('crypto');
  let pin = '';
  for (let i = 0; i < PIN_LENGTH; i += 1) pin += String(randomInt(0, 10));
  return pin;
}

module.exports = { PIN_LENGTH, MAX_ATTEMPTS, LOCK_MINUTES, validatePin, randomTempPin };
