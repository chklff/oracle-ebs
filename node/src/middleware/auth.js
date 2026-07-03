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
 *
 * On failure it logs WHY — header missing, or present-but-wrong with the length
 * received vs expected — so integration issues (e.g. an empty template value)
 * are easy to diagnose. The secret VALUE is never logged.
 */
function requireClientSecret(expectedSecret, logger) {
  return (req, _res, next) => {
    const provided = req.get('X-Client-Secret');
    if (!provided) {
      if (logger) {
        logger.warn(
          { auth: 'missing_header', header: 'X-Client-Secret' },
          'auth failed: X-Client-Secret header not present',
        );
      }
      return next(unauthorized());
    }
    if (!timingSafeEqual(provided, expectedSecret)) {
      if (logger) {
        logger.warn(
          { auth: 'mismatch', receivedLength: provided.length, expectedLength: String(expectedSecret).length },
          'auth failed: X-Client-Secret present but did not match',
        );
      }
      return next(unauthorized());
    }
    return next();
  };
}

module.exports = { requireClientSecret, timingSafeEqual };
