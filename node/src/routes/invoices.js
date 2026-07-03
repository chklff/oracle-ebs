'use strict';

const express = require('express');
const db = require('../db');
const invoiceRepository = require('../repositories/invoiceRepository');
const importRepository = require('../repositories/importRepository');
const { badRequest, notFound } = require('../errors');
const { toInt, requireInt, toDate } = require('../util/validation');

/**
 * Validate and normalise the POST /invoices body. Throws a 400 ApiError with a
 * details array listing every problem found.
 */
function validateCreatePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }

  const errors = [];

  const orgId = Number(body.org_id);
  if (!Number.isInteger(orgId)) errors.push('org_id is required and must be an integer');

  if (!body.invoice_num) errors.push('invoice_num is required');

  if (!body.invoice_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.invoice_date)) {
    errors.push('invoice_date is required and must be YYYY-MM-DD');
  }

  const vendorId = Number(body.vendor_id);
  if (!Number.isInteger(vendorId)) errors.push('vendor_id is required and must be an integer');

  const invoiceAmount = Number(body.invoice_amount);
  if (!Number.isFinite(invoiceAmount)) errors.push('invoice_amount is required and must be a number');

  if (!body.currency_code) errors.push('currency_code is required');

  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    errors.push('at least one line is required');
  } else {
    body.lines.forEach((line, idx) => {
      if (!Number.isFinite(Number(line.amount))) {
        errors.push(`lines[${idx}].amount is required and must be a number`);
      }
      if (line.dist_code_combination_id === undefined && !line.account) {
        errors.push(`lines[${idx}] requires dist_code_combination_id or account`);
      }
    });
  }

  if (errors.length > 0) throw badRequest('Validation failed', errors);

  return {
    org_id: orgId,
    invoice_num: String(body.invoice_num),
    invoice_date: body.invoice_date,
    vendor_id: vendorId,
    invoice_amount: invoiceAmount,
    currency_code: String(body.currency_code),
    terms_id: body.terms_id !== undefined && body.terms_id !== null ? Number(body.terms_id) : null,
    description: body.description ?? null,
    custom_fields: body.custom_fields && typeof body.custom_fields === 'object' ? body.custom_fields : {},
    lines: body.lines.map((line) => ({
      amount: Number(line.amount),
      line_type: line.line_type,
      description: line.description,
      dist_code_combination_id:
        line.dist_code_combination_id !== undefined && line.dist_code_combination_id !== null
          ? Number(line.dist_code_combination_id)
          : null,
      account: line.account ?? null,
    })),
  };
}

module.exports = function invoicesRouter(config) {
  const router = express.Router();

  // GET /invoices - paginated list for one operating unit.
  router.get('/invoices', async (req, res, next) => {
    try {
      const orgId = requireInt(req.query.org_id, 'org_id');
      const vendorId = toInt(req.query.vendor_id, 'vendor_id');
      const status = req.query.status !== undefined ? String(req.query.status) : undefined;
      const dateFrom = toDate(req.query.date_from, 'date_from');
      const dateTo = toDate(req.query.date_to, 'date_to');

      let limit = toInt(req.query.limit, 'limit');
      if (limit === undefined) limit = config.query.defaultLimit;
      if (limit < 1) throw badRequest('limit must be >= 1');
      if (limit > config.query.maxLimit) limit = config.query.maxLimit;

      let offset = toInt(req.query.offset, 'offset');
      if (offset === undefined) offset = 0;
      if (offset < 0) throw badRequest('offset must be >= 0');

      const data = await db.withConnection((conn) =>
        invoiceRepository.listInvoices(conn, { orgId, vendorId, status, dateFrom, dateTo, limit, offset }),
      );

      res.json({ data, limit, offset, count: data.length });
    } catch (err) {
      next(err);
    }
  });

  // GET /invoices/import-status/:request_id
  // Declared before /invoices/:id so "import-status" is not swallowed by :id.
  router.get('/invoices/import-status/:request_id', async (req, res, next) => {
    try {
      const requestId = requireInt(req.params.request_id, 'request_id');
      const status = await db.withConnection((conn) =>
        importRepository.getRequestStatus(conn, requestId),
      );
      if (!status) throw notFound('Concurrent request not found');
      res.json(status);
    } catch (err) {
      next(err);
    }
  });

  // GET /invoices/:id - single invoice with its lines.
  router.get('/invoices/:id', async (req, res, next) => {
    try {
      const invoiceId = requireInt(req.params.id, 'id');
      const invoice = await db.withConnection(async (conn) => {
        const found = await invoiceRepository.getInvoiceById(conn, invoiceId);
        if (!found) return null;
        found.lines = await invoiceRepository.getInvoiceLines(conn, invoiceId);
        return found;
      });
      if (!invoice) throw notFound('Invoice not found');
      res.json(invoice);
    } catch (err) {
      next(err);
    }
  });

  // POST /invoices - stage into the interface tables and submit the import.
  router.post('/invoices', async (req, res, next) => {
    try {
      const payload = validateCreatePayload(req.body);
      const requestId = await db.withConnection(async (conn) => {
        await invoiceRepository.createInvoiceInterface(conn, payload, config.import.source);
        return importRepository.submitImport(conn, {
          appsUserId: config.import.appsUserId,
          responsibilityId: config.import.responsibilityId,
          responsibilityApplId: config.import.responsibilityApplId,
          orgId: payload.org_id,
          programApplication: config.import.programApplication,
          programShortName: config.import.programShortName,
          source: config.import.source,
        });
      });
      res.status(202).json({ status: 'submitted', request_id: requestId });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

module.exports.validateCreatePayload = validateCreatePayload;
