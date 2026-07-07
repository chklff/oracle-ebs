'use strict';

const express = require('express');
const db = require('../db');
const vendorRepository = require('../repositories/vendorRepository');
const { requireInt } = require('../util/validation');

/**
 * GET /vendors and GET /vendor-sites - discover valid vendor_id/vendor_site_id
 * values for POST /invoices. See vendorRepository.js for why these exist.
 */
module.exports = function vendorsRouter() {
  const router = express.Router();

  router.get('/vendors', async (req, res, next) => {
    try {
      const orgId = requireInt(req.query.org_id, 'org_id');
      const vendors = await db.withConnection((conn) => vendorRepository.listVendors(conn, orgId));
      res.json(vendors);
    } catch (err) {
      next(err);
    }
  });

  router.get('/vendor-sites', async (req, res, next) => {
    try {
      const orgId = requireInt(req.query.org_id, 'org_id');
      const vendorId = requireInt(req.query.vendor_id, 'vendor_id');
      const sites = await db.withConnection((conn) => vendorRepository.listVendorSites(conn, vendorId, orgId));
      res.json(sites);
    } catch (err) {
      next(err);
    }
  });

  return router;
};
