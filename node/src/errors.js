'use strict';

/**
 * ApiError carries an HTTP status and a client-safe message. The error handler
 * turns these into JSON responses; anything that is not an ApiError becomes a
 * generic 500 so internal details never reach the client.
 */
class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (details) this.details = details;
  }
}

const badRequest = (message, details) => new ApiError(400, message, details);
const unauthorized = (message = 'Invalid or missing client secret') => new ApiError(401, message);
const notFound = (message = 'Not found') => new ApiError(404, message);
const conflict = (message, details) => new ApiError(409, message, details);
const unprocessable = (message, details) => new ApiError(422, message, details);

module.exports = { ApiError, badRequest, unauthorized, notFound, conflict, unprocessable };
