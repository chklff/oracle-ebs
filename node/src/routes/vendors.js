'use strict';

const express = require('express');
const db = require('../db');
const vendorRepository = require('../repositories/vendorRepository');
const { requireInt, toInt } = require('../util/validation');
const { badRequest } = require('../errors');

/**
 * GET /vendors and GET /vendor-sites - discover valid vendor_id/vendor_site_id
 * values for POST /invoices. See vendorRepository.js for why these exist.
 */
module.exports = function vendorsRouter() {
  const router = express.Router();

  router.get('/vendors', async (req, res, next) => {
    try {
      const orgId = toInt(req.query.org_id, 'org_id');
      const name = req.query.name !== undefined && req.query.name !== '' ? String(req.query.name) : undefined;
      const taxId = req.query.tax_id !== undefined && req.query.tax_id !== '' ? String(req.query.tax_id) : undefined;
      // org_id is only required when searching without name/tax_id, to avoid
      // dumping every vendor on the instance unscoped. When name/tax_id is
      // given, org_id is optional - a caller may only have a vendor's name or
      // tax ID (e.g. from an external system) and not yet know which org it
      // belongs to, so this searches across all orgs in that case.
      if (orgId === undefined && name === undefined && taxId === undefined) {
        throw badRequest('org_id is required unless searching by name or tax_id');
      }
      const vendors = await db.withConnection((conn) => vendorRepository.listVendors(conn, { orgId, name, taxId }));
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
