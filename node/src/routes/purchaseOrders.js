'use strict';

const express = require('express');
const db = require('../db');
const purchaseOrderRepository = require('../repositories/purchaseOrderRepository');
const { requireInt } = require('../util/validation');

/**
 * GET /purchase-orders and GET /purchase-orders/:po_header_id/lines - discover
 * valid po_header_id/po_line_id/po_line_location_id values for PO-matched
 * invoice lines (not yet supported by POST /invoices - read-side only so
 * far). See purchaseOrderRepository.js for why lines are shipment-level.
 */
module.exports = function purchaseOrdersRouter() {
  const router = express.Router();

  router.get('/purchase-orders', async (req, res, next) => {
    try {
      const orgId = requireInt(req.query.org_id, 'org_id');
      const vendorId = requireInt(req.query.vendor_id, 'vendor_id');
      const orders = await db.withConnection((conn) =>
        purchaseOrderRepository.listPurchaseOrders(conn, { orgId, vendorId }),
      );
      res.json(orders);
    } catch (err) {
      next(err);
    }
  });

  router.get('/purchase-orders/:po_header_id/lines', async (req, res, next) => {
    try {
      const poHeaderId = requireInt(req.params.po_header_id, 'po_header_id');
      const lines = await db.withConnection((conn) =>
        purchaseOrderRepository.listPurchaseOrderLines(conn, poHeaderId),
      );
      res.json(lines);
    } catch (err) {
      next(err);
    }
  });

  return router;
};
