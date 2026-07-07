'use strict';

const express = require('express');
const db = require('../db');
const termRepository = require('../repositories/termRepository');

/** GET /terms - list payment terms so callers can discover valid terms_id. */
module.exports = function termsRouter() {
  const router = express.Router();

  router.get('/terms', async (_req, res, next) => {
    try {
      const terms = await db.withConnection((conn) => termRepository.listTerms(conn));
      res.json(terms);
    } catch (err) {
      next(err);
    }
  });

  return router;
};
