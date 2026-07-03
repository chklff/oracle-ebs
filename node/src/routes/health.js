'use strict';

const express = require('express');
const db = require('../db');

/**
 * GET /health - unauthenticated liveness + DB pool connectivity probe.
 * Always returns 200 with a body describing DB state so uptime checks stay
 * simple; db is "error" when a pooled connection cannot be obtained.
 */
module.exports = function healthRouter(logger) {
  const router = express.Router();

  router.get('/health', async (_req, res) => {
    try {
      const connected = await db.healthCheck();
      res.json({ status: 'ok', db: connected ? 'connected' : 'error' });
    } catch (err) {
      logger.error({ err }, 'health check failed');
      res.json({ status: 'ok', db: 'error' });
    }
  });

  return router;
};
