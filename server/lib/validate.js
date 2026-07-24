'use strict';

/** Thrown by validators; the error handler turns this into a 400 with a readable message. */
class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.field = field;
  }
}

function str(value, field, { required = false, max = 500, min = 0 } = {}) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) {
    if (required) throw new ValidationError(`${field} is required.`, field);
    return null;
  }
  if (s.length < min) throw new ValidationError(`${field} must be at least ${min} characters.`, field);
  if (s.length > max) throw new ValidationError(`${field} must be at most ${max} characters.`, field);
  return s;
}

/**
 * Indian mobile numbers: 10 digits starting 6-9. Accepts a +91 / 91 / 0 prefix
 * and stores the normalized 10-digit form so repeat-visitor lookup matches
 * regardless of how the number was typed at the gate.
 */
function normalizePhone(value, field = 'Phone number', { required = false } = {}) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    if (required) throw new ValidationError(`${field} is required.`, field);
    return null;
  }
  const digits = raw.replace(/\D/g, '');
  let ten = digits;
  if (ten.length === 12 && ten.startsWith('91')) ten = ten.slice(2);
  else if (ten.length === 11 && ten.startsWith('0')) ten = ten.slice(1);
  if (!/^[6-9]\d{9}$/.test(ten)) {
    throw new ValidationError(`${field} must be a 10-digit Indian mobile number.`, field);
  }
  return ten;
}

function uuid(value, field, { required = false } = {}) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) {
    if (required) throw new ValidationError(`${field} is required.`, field);
    return null;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    throw new ValidationError(`${field} is not a valid id.`, field);
  }
  return s;
}

function oneOf(value, field, allowed, { required = false } = {}) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) {
    if (required) throw new ValidationError(`${field} is required.`, field);
    return null;
  }
  if (!allowed.includes(s)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}.`, field);
  }
  return s;
}

/** Rejects dates we cannot parse, so a bad query string never becomes a silent full-table scan. */
function isoDate(value, field, { required = false } = {}) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) {
    if (required) throw new ValidationError(`${field} is required.`, field);
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
    throw new ValidationError(`${field} must be a date in YYYY-MM-DD format.`, field);
  }
  return s;
}

module.exports = { ValidationError, str, normalizePhone, uuid, oneOf, isoDate };
