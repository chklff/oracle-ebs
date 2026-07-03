'use strict';

const express = require('express');
const db = require('../db');
const orgRepository = require('../repositories/orgRepository');

/** GET /orgs - list operating units so callers can discover valid org_id. */
module.exports = function orgsRouter() {
  const router = express.Router();

  router.get('/orgs', async (_req, res, next) => {
    try {
      const orgs = await db.withConnection((conn) => orgRepository.listOperatingUnits(conn));
      res.json(orgs);
    } catch (err) {
      next(err);
    }
  });

  return router;
};
