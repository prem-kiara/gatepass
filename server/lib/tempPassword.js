'use strict';

const crypto = require('crypto');

/**
 * Generates the one-time password a superadmin hands to a locked-out user.
 *
 * It gets read aloud down a phone line and typed on a cheap handset, so the
 * alphabet drops every character that is ambiguous when spoken or rendered
 * (0/O, 1/I/L, 5/S, 2/Z), and the result is grouped for reading in threes.
 * Uppercase only, for the same reason.
 *
 * 12 characters from a 26-symbol alphabet is ~56 bits — far beyond guessing,
 * and it only has to survive the few minutes before the forced change.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRTUVWXY346789';
const LENGTH = 12;
const GROUP = 4;

function generateTempPassword() {
  let out = '';
  for (let i = 0; i < LENGTH; i += 1) {
    // randomInt avoids the modulo bias a raw byte % length would introduce.
    out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  }
  return out.match(new RegExp(`.{1,${GROUP}}`, 'g')).join('-');
}

module.exports = { generateTempPassword };
