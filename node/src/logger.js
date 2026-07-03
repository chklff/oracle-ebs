'use strict';

const pino = require('pino');

/**
 * Structured JSON logger. The client secret and any auth header are redacted
 * so they can never leak into logs.
 */
function createLogger(level = 'info') {
  return pino({
    level,
    redact: {
      paths: ['req.headers["x-client-secret"]', 'req.headers.authorization'],
      remove: true,
    },
  });
}

module.exports = { createLogger };
