'use strict';

const pino = require('pino');

/**
 * Structured logger.
 *
 * - format 'pretty' (default): clean, single-line, human-readable output — good
 *   to read directly in a terminal or when tailing the log file. Colorized only
 *   when writing to a real terminal, so a redirected log file stays plain text.
 * - format 'json': raw JSON lines, best for log aggregators/shippers.
 *
 * The client-secret and auth headers are redacted as a safety net (the request
 * logger does not log headers at all).
 */
function createLogger(level = 'info', format = 'pretty') {
  const base = {
    level,
    redact: {
      paths: ['req.headers["x-client-secret"]', 'req.headers.authorization'],
      remove: true,
    },
  };

  if (format === 'pretty' && level !== 'silent') {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: Boolean(process.stdout.isTTY),
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
          // The request summary is already in the message; hide the duplicate
          // structured fields (kept in JSON mode) to keep pretty lines clean.
          ignore: 'pid,hostname,method,url,status,durationMs',
          singleLine: true,
        },
      },
    });
  }

  return pino(base);
}

module.exports = { createLogger };
