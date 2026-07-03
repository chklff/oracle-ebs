'use strict';

const { badRequest } = require('../errors');

/** Parse an optional integer query/path value. Returns undefined when absent. */
function toInt(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw badRequest(`${name} must be an integer`);
  return n;
}

/** Parse a required integer; throws 400 when absent or non-integer. */
function requireInt(value, name) {
  const n = toInt(value, name);
  if (n === undefined) throw badRequest(`${name} is required`);
  return n;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate an optional YYYY-MM-DD date string. Returns the string unchanged. */
function toDate(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!DATE_RE.test(value)) throw badRequest(`${name} must be in YYYY-MM-DD format`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw badRequest(`${name} is not a valid date`);
  return value;
}

module.exports = { toInt, requireInt, toDate, DATE_RE };
