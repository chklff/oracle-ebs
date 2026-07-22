'use strict';

const express = require('express');
const { requireClientSecret } = require('./middleware/auth');
const { requestLogger } = require('./middleware/requestLogger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const healthRouter = require('./routes/health');
const orgsRouter = require('./routes/orgs');
const vendorsRouter = require('./routes/vendors');
const termsRouter = require('./routes/terms');
const currenciesRouter = require('./routes/currencies');
const purchaseOrdersRouter = require('./routes/purchaseOrders');
const invoicesRouter = require('./routes/invoices');

/**
 * Build the Express app. Kept separate from server bootstrap so tests can mount
 * it without opening a socket or a real DB pool.
 */
function createApp(config, logger) {
  const app = express();
  app.disable('x-powered-by');
  // type: () => true - parse every request body as JSON regardless of the
  // Content-Type header. Every write endpoint here (POST/PATCH /invoices)
  // only ever accepts JSON, but not every calling platform reliably sets
  // Content-Type: application/json (confirmed live: Make's HTTP connector
  // sent a PATCH with a valid JSON body but no Content-Type header at all,
  // defaulting elsewhere to application/x-www-form-urlencoded - express.json()
  // silently skipped parsing and req.body came through as {}, producing a
  // confusing "no fields provided" 400 despite a correct payload on the wire).
  app.use(express.json({ limit: '1mb', type: () => true }));

  // One tidy line per request: method, path, status, duration. No headers logged.
  app.use(requestLogger(logger));

  // Health is unauthenticated and mounted before the secret gate.
  app.use('/', healthRouter(logger));

  // Everything below requires a valid X-Client-Secret.
  app.use(requireClientSecret(config.clientSecret, logger));
  app.use('/', orgsRouter());
  app.use('/', vendorsRouter());
  app.use('/', termsRouter());
  app.use('/', currenciesRouter());
  app.use('/', purchaseOrdersRouter());
  app.use('/', invoicesRouter(config));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}

module.exports = { createApp };
