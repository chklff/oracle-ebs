'use strict';

const express = require('express');
const db = require('../db');
const invoiceRepository = require('../repositories/invoiceRepository');
const importRepository = require('../repositories/importRepository');
const dffRepository = require('../repositories/dffRepository');
const cancelRepository = require('../repositories/cancelRepository');
const { badRequest, notFound, conflict, unprocessable } = require('../errors');
const { toInt, requireInt, toDate } = require('../util/validation');

// Fields Oracle has no supported in-place update path for once an invoice
// exists - anything that touches invoice_amount, distributions, scheduled
// payments, or the tax engine. See docs/api.md "PATCH /invoices/:id" for why:
// AP_INVOICES_ALL.APPROVAL_STATUS/POSTING_STATUS are unreliable/NULL on this
// instance and real invoices are typically already validated+posted+paid by
// the time anyone would want to edit them, at which point Oracle's own
// supported path is cancel + recreate, not edit.
const LOCKED_UPDATE_FIELDS = [
  'invoice_amount', 'terms_id', 'lines', 'vendor_id', 'vendor_site_id',
  'currency_code', 'invoice_date', 'invoice_num', 'invoice_type',
];

const CUSTOM_FIELD_KEYS = ['attribute_category', ...Array.from({ length: 15 }, (_, i) => `attribute${i + 1}`)];

/**
 * Validate and normalise the PATCH /invoices/:id body. Only description and
 * custom_fields (attribute_category/attribute1-15) are accepted - these are
 * the only header fields safe to edit unconditionally regardless of
 * validation/posting/payment status (see docs/api.md). Everything else is
 * rejected with a pointer to cancel-and-recreate.
 */
function validateUpdatePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }

  const errors = [];
  const fields = {};

  const lockedFieldsPresent = LOCKED_UPDATE_FIELDS.filter((f) => body[f] !== undefined);
  if (lockedFieldsPresent.length > 0) {
    errors.push(
      `${lockedFieldsPresent.join(', ')} cannot be changed on an existing invoice - Oracle has no supported `
        + 'in-place update path for financial fields once an invoice may be validated/posted/paid. Cancel the '
        + 'invoice in Oracle Payables and create a corrected one via POST /invoices instead.',
    );
  }

  if (body.description !== undefined) {
    fields.description = body.description === null ? null : String(body.description);
  }

  if (body.custom_fields !== undefined) {
    if (typeof body.custom_fields !== 'object' || body.custom_fields === null || Array.isArray(body.custom_fields)) {
      errors.push('custom_fields must be an object');
    } else {
      const unknownKeys = Object.keys(body.custom_fields).filter((k) => !CUSTOM_FIELD_KEYS.includes(k));
      if (unknownKeys.length > 0) {
        errors.push(`custom_fields has unknown keys: ${unknownKeys.join(', ')} (allowed: ${CUSTOM_FIELD_KEYS.join(', ')})`);
      }
      for (const key of CUSTOM_FIELD_KEYS) {
        if (body.custom_fields[key] !== undefined) {
          const value = body.custom_fields[key];
          fields[key] = value === null ? null : String(value);
        }
      }
    }
  }

  if (errors.length === 0 && Object.keys(fields).length === 0) {
    errors.push('At least one of description or custom_fields must be provided');
  }

  if (errors.length > 0) throw badRequest('Validation failed', errors);

  return fields;
}

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
      // A line is GL-coded (dist_code_combination_id/account), PO-matched
      // (po_line_location_id + quantity_invoiced), or a TAX line
      // (line_type "TAX", using tax_regime_code/tax_status_code/etc instead
      // of an account or a PO) - mutually exclusive, exactly one shape
      // required. po_line_location_id alone is sufficient for a PO-matched
      // line - Oracle derives po_header_id/po_line_id itself from the
      // shipment - confirmed live. po_line_id is accepted but not required.
      const isGlCoded = line.dist_code_combination_id !== undefined || !!line.account;
      const isPoMatched = line.po_line_location_id !== undefined;
      const isTaxLine = line.line_type === 'TAX';
      const shapeCount = [isGlCoded, isPoMatched, isTaxLine].filter(Boolean).length;
      if (shapeCount > 1) {
        errors.push(`lines[${idx}] must be exactly one of GL-coded, PO-matched, or a TAX line - pick one`);
      } else if (shapeCount === 0) {
        errors.push(
          `lines[${idx}] requires dist_code_combination_id or account, or po_line_location_id, or line_type "TAX"`,
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
      // against (see GET /purchase-orders/:po_header_id/lines) and is
      // sufficient on its own - Oracle derives po_header_id/po_line_id and
      // GL coding from the shipment itself, confirmed live. po_line_id below
      // is accepted but not required.
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

  // PATCH /invoices/:id - update description/custom_fields in place. This is
  // deliberately the ONLY editable surface: direct UPDATE against
  // ap_invoices_all, guarded on the invoice existing and not being cancelled.
  // Anything financial (amount/terms/lines) is rejected - see
  // validateUpdatePayload and docs/api.md for why.
  router.patch('/invoices/:id', async (req, res, next) => {
    try {
      const invoiceId = requireInt(req.params.id, 'id');
      const fields = validateUpdatePayload(req.body);

      const updated = await db.withConnection(async (conn) => {
        const state = await invoiceRepository.getCancellationState(conn, invoiceId);
        if (!state.exists) throw notFound('Invoice not found');
        if (state.cancelled) throw conflict('Invoice is cancelled and cannot be updated');

        await invoiceRepository.updateInvoiceHeaderFields(conn, invoiceId, fields);

        const found = await invoiceRepository.getInvoiceById(conn, invoiceId);
        found.lines = await invoiceRepository.getInvoiceLines(conn, invoiceId);
        return found;
      });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // POST /invoices/:id/cancel - the supported path for anything PATCH rejects
  // (amount/terms/lines once an invoice may be validated/posted/paid). Uses
  // Oracle's own AP_CANCEL_PKG, not direct SQL - see cancelRepository.js.
  // This is NOT reversible: Oracle has no "un-cancel". The follow-up
  // corrected invoice is a separate POST /invoices call, by design (this
  // endpoint only cancels, it never creates a replacement itself).
  router.post('/invoices/:id/cancel', async (req, res, next) => {
    try {
      const invoiceId = requireInt(req.params.id, 'id');
      const accountingDate = toDate(req.body?.accounting_date, 'accounting_date');

      const result = await db.withConnection(async (conn) => {
        const state = await cancelRepository.getCancellableState(conn, invoiceId);
        if (!state.exists) throw notFound('Invoice not found');
        if (state.cancelled) throw conflict('Invoice is already cancelled');

        const check = await cancelRepository.checkCancellable(conn, {
          invoiceId,
          orgId: state.orgId,
          appsUserId: config.import.appsUserId,
          responsibilityId: config.import.responsibilityId,
          responsibilityApplId: config.import.responsibilityApplId,
        });
        if (!check.cancellable) {
          throw unprocessable('Invoice cannot be cancelled', [check.errorCode || 'Unknown reason']);
        }

        // AP_CANCEL_SINGLE_INVOICE can itself raise an unhandled Oracle
        // application error (ORA-20001 etc) for invoice-specific data issues
        // it cannot cleanly recover from (confirmed live: a real invoice
        // failed here with "Error encountered while synchronizing tax
        // distributions... Generate APLIST for this invoice and log a
        // Service Request" - an Oracle-side data problem with that specific
        // invoice, not something this API can fix). Surface it as a 422 with
        // the real ORA message instead of letting it bubble up as an opaque
        // 500 - the caller at least learns it's a genuine Oracle-side issue.
        let cancelResult;
        try {
          cancelResult = await cancelRepository.cancelInvoice(conn, {
            invoiceId,
            orgId: state.orgId,
            accountingDate,
            appsUserId: config.import.appsUserId,
            responsibilityId: config.import.responsibilityId,
            responsibilityApplId: config.import.responsibilityApplId,
          });
        } catch (oracleErr) {
          throw unprocessable('Cancellation failed', [oracleErr.message]);
        }

        if (!cancelResult.success) {
          throw unprocessable('Cancellation failed', [cancelResult.messageName || 'Unknown reason']);
        }

        const invoice = await invoiceRepository.getInvoiceById(conn, invoiceId);
        invoice.lines = await invoiceRepository.getInvoiceLines(conn, invoiceId);
        invoice.cancelled = true;
        invoice.cancelled_amount = cancelResult.cancelledAmount;
        invoice.cancelled_date = cancelResult.cancelledDate;
        return invoice;
      });

      res.json(result);
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
module.exports.validateUpdatePayload = validateUpdatePayload;
