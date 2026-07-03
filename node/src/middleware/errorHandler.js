'use strict';

const { ApiError } = require('../errors');

/** 404 for any route that did not match. */
function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'Route not found' });
}

/**
 * Central error handler. Known ApiErrors become their status + message;
 * everything else is logged in full server-side and returned as a generic 500
 * so stack traces and internal details never reach the client.
 */
function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (err instanceof ApiError) {
      const body = { error: err.message };
      if (err.details) body.details = err.details;
      return res.status(err.status).json(body);
    }
    logger.error({ err }, 'unhandled error');
    return res.status(500).json({ error: 'Internal server error' });
  };
}

module.exports = { errorHandler, notFoundHandler };
