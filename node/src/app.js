'use strict';

const express = require('express');
const { requireClientSecret } = require('./middleware/auth');
const { requestLogger } = require('./middleware/requestLogger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const healthRouter = require('./routes/health');
const orgsRouter = require('./routes/orgs');
const invoicesRouter = require('./routes/invoices');

/**
 * Build the Express app. Kept separate from server bootstrap so tests can mount
 * it without opening a socket or a real DB pool.
 */
function createApp(config, logger) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // One tidy line per request: method, path, status, duration. No headers logged.
  app.use(requestLogger(logger));

  // Health is unauthenticated and mounted before the secret gate.
  app.use('/', healthRouter(logger));

  // Everything below requires a valid X-Client-Secret.
  app.use(requireClientSecret(config.clientSecret, logger));
  app.use('/', orgsRouter());
  app.use('/', invoicesRouter(config));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}

module.exports = { createApp };
