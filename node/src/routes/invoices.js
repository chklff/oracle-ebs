'use strict';

const express = require('express');
const db = require('../db');
const invoiceRepository = require('../repositories/invoiceRepository');
const importRepository = require('../repositories/importRepository');
const dffRepository = require('../repositories/dffRepository');
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

  const vendorSiteId = Number(body.vendor_site_id);
  if (!Number.isInteger(vendorSiteId)) errors.push('vendor_site_id is required and must be an integer');

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
      // A line is either GL-coded (dist_code_combination_id/account) or
      // PO-matched (po_line_id + po_line_location_id + quantity_invoiced) -
      // mutually exclusive, exactly one shape required.
      const isGlCoded = line.dist_code_combination_id !== undefined || !!line.account;
      const isPoMatched = line.po_line_id !== undefined && line.po_line_location_id !== undefined;
      if (isGlCoded && isPoMatched) {
        errors.push(`lines[${idx}] cannot be both GL-coded and PO-matched - pick one`);
      } else if (!isGlCoded && !isPoMatched) {
        errors.push(
          `lines[${idx}] requires dist_code_combination_id or account, or po_line_id and po_line_location_id`,
        );
      } else if (isPoMatched && !Number.isFinite(Number(line.quantity_invoiced))) {
        errors.push(`lines[${idx}].quantity_invoiced is required and must be a number for a PO-matched line`);
      }
    });
  }

  if (errors.length > 0) throw badRequest('Validation failed', errors);

  return {
    org_id: orgId,
    invoice_num: String(body.invoice_num),
    invoice_date: body.invoice_date,
    vendor_id: vendorId,
    vendor_site_id: vendorSiteId,
    invoice_amount: invoiceAmount,
    currency_code: String(body.currency_code),
    terms_id: body.terms_id !== undefined && body.terms_id !== null ? Number(body.terms_id) : null,
    // Not validated against a hardcoded enum - same approach as currency_code.
    // Oracle's own AP_LOOKUP_CODES (lookup_type 'INVOICE TYPE') is the source
    // of truth and rejects an invalid value during import; hardcoding a list
    // here would just be another thing to keep in sync per instance.
    invoice_type: body.invoice_type !== undefined && body.invoice_type !== null ? String(body.invoice_type) : 'STANDARD',
    // Untested end-to-end - one of the fields tried (and not yet proven) in
    // the e-Business Tax investigation, see docs/api.md gotchas. Real column
    // (calc_tax_during_import_flag), exposed so it can be experimented with
    // through the API without a code change once someone has the access to
    // actually resolve this.
    calc_tax_during_import: body.calc_tax_during_import === true ? 'Y' : null,
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
      // PO-matched shape - mutually exclusive with dist_code_combination_id/
      // account above. po_line_location_id is the shipment being matched
      // against (see GET /purchase-orders/:po_header_id/lines); Oracle
      // derives GL coding from the PO itself for these lines.
      po_line_id: line.po_line_id !== undefined && line.po_line_id !== null ? Number(line.po_line_id) : null,
      po_line_location_id:
        line.po_line_location_id !== undefined && line.po_line_location_id !== null
          ? Number(line.po_line_location_id)
          : null,
      quantity_invoiced:
        line.quantity_invoiced !== undefined && line.quantity_invoiced !== null
          ? Number(line.quantity_invoiced)
          : null,
      // Additional PO-matching fields - real AP_INVOICE_LINES_INTERFACE
      // columns. po_release_id is required alongside po_line_id/
      // po_line_location_id whenever the shipment belongs to a Blanket PO
      // release (PO_LINE_LOCATIONS_ALL.po_release_id not null for that
      // shipment) - confirmed live, see docs/api.md gotchas.
      po_header_id: line.po_header_id !== undefined && line.po_header_id !== null ? Number(line.po_header_id) : null,
      po_line_number:
        line.po_line_number !== undefined && line.po_line_number !== null ? Number(line.po_line_number) : null,
      po_shipment_num:
        line.po_shipment_num !== undefined && line.po_shipment_num !== null ? Number(line.po_shipment_num) : null,
      po_release_id:
        line.po_release_id !== undefined && line.po_release_id !== null ? Number(line.po_release_id) : null,
      po_unit_of_measure: line.po_unit_of_measure ?? null,
      unit_price: line.unit_price !== undefined && line.unit_price !== null ? Number(line.unit_price) : null,
      // Only relevant for line_type "TAX" - this instance uses Oracle's
      // e-Business Tax engine, not legacy tax codes, so a tax line is
      // identified by regime/status/rate (or classification code), not a
      // single flat "tax code" string. Verified live against a real tax
      // line's shape; unrelated to line_type "ITEM" etc.
      tax_regime_code: line.tax_regime_code ?? null,
      tax_status_code: line.tax_status_code ?? null,
      tax_rate_code: line.tax_rate_code ?? null,
      tax_jurisdiction_code: line.tax_jurisdiction_code ?? null,
      tax_classification_code: line.tax_classification_code ?? null,
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
      const interfaceInvoiceId = toInt(req.query.interface_invoice_id, 'interface_invoice_id');
      const result = await db.withConnection(async (conn) => {
        const status = await importRepository.getRequestStatus(conn, requestId);
        if (!status) return null;
        // Only worth the extra lookup once the concurrent program has actually
        // finished - while Pending/Running there's nothing to report yet.
        if (status.phase === 'Completed') {
          const outcome = await importRepository.getImportOutcome(conn, { requestId, interfaceInvoiceId });
          if (outcome) return { ...status, ...outcome };
        }
        return status;
      });
      if (!result) throw notFound('Concurrent request not found');
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // GET /invoices/dff-schema - custom_fields (attribute1..15) column -> label
  // metadata, per context. Declared before /invoices/:id for the same reason
  // as import-status above.
  router.get('/invoices/dff-schema', async (_req, res, next) => {
    try {
      const contexts = await db.withConnection((conn) => dffRepository.getInvoiceDffSchema(conn));
      res.json({ contexts });
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
      const { requestId, interfaceInvoiceId } = await db.withConnection(async (conn) => {
        const invoiceId = await invoiceRepository.createInvoiceInterface(conn, payload, config.import.source);
        const request = await importRepository.submitImport(conn, {
          appsUserId: config.import.appsUserId,
          responsibilityId: config.import.responsibilityId,
          responsibilityApplId: config.import.responsibilityApplId,
          orgId: payload.org_id,
          programApplication: config.import.programApplication,
          programShortName: config.import.programShortName,
          source: config.import.source,
          batchName: config.import.batchName,
        });
        return { requestId: request, interfaceInvoiceId: invoiceId };
      });
      // interface_invoice_id uniquely identifies the row this call staged -
      // pass it back to GET /invoices/import-status/:request_id?interface_invoice_id=
      // for a precise outcome lookup. request_id alone can be ambiguous once
      // other pending/rejected rows exist for the same org+source, since one
      // concurrent run sweeps all of them together.
      res.status(202).json({ status: 'submitted', request_id: requestId, interface_invoice_id: interfaceInvoiceId });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

module.exports.validateCreatePayload = validateCreatePayload;
