'use strict';

const crypto = require('crypto');
const { unauthorized } = require('../errors');

/** Constant-time string comparison that tolerates length differences. */
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Reject any request whose X-Client-Secret header does not match the configured
 * secret. Mount this after the (unauthenticated) health route.
 */
function requireClientSecret(expectedSecret) {
  return (req, _res, next) => {
    const provided = req.get('X-Client-Secret');
    if (!provided || !timingSafeEqual(provided, expectedSecret)) {
      return next(unauthorized());
    }
    return next();
  };
}

module.exports = { requireClientSecret, timingSafeEqual };
