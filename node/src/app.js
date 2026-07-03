'use strict';

const express = require('express');
const pinoHttp = require('pino-http');
const { requireClientSecret } = require('./middleware/auth');
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

  // Structured request logging: method, path, status, duration. Secret redacted.
  app.use(
    pinoHttp({
      logger,
      redact: {
        paths: ['req.headers["x-client-secret"]', 'req.headers.authorization'],
        remove: true,
      },
      customLogLevel(_req, res, err) {
        if (res.statusCode >= 500 || err) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  // Health is unauthenticated and mounted before the secret gate.
  app.use('/', healthRouter(logger));

  // Everything below requires a valid X-Client-Secret.
  app.use(requireClientSecret(config.clientSecret));
  app.use('/', orgsRouter());
  app.use('/', invoicesRouter(config));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}

module.exports = { createApp };
