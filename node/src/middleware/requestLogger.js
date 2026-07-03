'use strict';

/**
 * Compact request logger: one tidy line per request with method, path, status
 * and duration. Deliberately does NOT log request/response headers, so the
 * client secret can never appear in logs. The human-readable summary is the log
 * message itself, so output is legible in both pretty and JSON formats.
 */
function requestLogger(logger) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const status = res.statusCode;
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      logger[level](
        { method: req.method, url: req.originalUrl, status, durationMs: Math.round(durationMs * 10) / 10 },
        `${req.method} ${req.originalUrl} ${status} ${Math.round(durationMs)}ms`,
      );
    });
    next();
  };
}

module.exports = { requestLogger };
