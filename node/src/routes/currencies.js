'use strict';

const express = require('express');
const db = require('../db');
const currencyRepository = require('../repositories/currencyRepository');

/** GET /currencies - list enabled currencies so callers can discover valid currency_code. */
module.exports = function currenciesRouter() {
  const router = express.Router();

  router.get('/currencies', async (_req, res, next) => {
    try {
      const currencies = await db.withConnection((conn) => currencyRepository.listCurrencies(conn));
      res.json(currencies);
    } catch (err) {
      next(err);
    }
  });

  return router;
};
