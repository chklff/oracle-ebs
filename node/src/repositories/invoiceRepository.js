'use strict';

const { oracledb } = require('../db');

/**
 * All invoice SQL lives here. Every statement uses bind variables only; optional
 * filters are added by appending fixed, whitelisted predicates - never by
 * interpolating user input into the SQL text.
 */

const CORE_COLUMNS = `
  i.invoice_id                         AS invoice_id,
  i.invoice_num                        AS invoice_num,
  TO_CHAR(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
  i.vendor_id                          AS vendor_id,
  s.vendor_name                        AS vendor_name,
  i.invoice_amount                     AS invoice_amount,
  i.invoice_currency_code              AS currency_code,
  TO_CHAR(i.gl_date, 'YYYY-MM-DD')     AS gl_date,
  i.payment_status_flag                AS payment_status_flag,
  i.org_id                             AS org_id,
  i.attribute_category                 AS attribute_category,
  i.attribute1, i.attribute2, i.attribute3, i.attribute4, i.attribute5,
  i.attribute6, i.attribute7, i.attribute8, i.attribute9, i.attribute10,
  i.attribute11, i.attribute12, i.attribute13, i.attribute14, i.attribute15`;

function mapInvoice(row) {
  const customFields = { attribute_category: row.ATTRIBUTE_CATEGORY ?? null };
  for (let i = 1; i <= 15; i += 1) {
    customFields[`attribute${i}`] = row[`ATTRIBUTE${i}`] ?? null;
  }
  return {
    invoice_id: row.INVOICE_ID,
    invoice_num: row.INVOICE_NUM,
    invoice_date: row.INVOICE_DATE,
    vendor_id: row.VENDOR_ID,
    vendor_name: row.VENDOR_NAME,
    invoice_amount: row.INVOICE_AMOUNT,
    currency_code: row.CURRENCY_CODE,
    gl_date: row.GL_DATE,
    payment_status_flag: row.PAYMENT_STATUS_FLAG,
    org_id: row.ORG_ID,
    custom_fields: customFields,
  };
}

function mapLine(row) {
  return {
    line_number: row.LINE_NUMBER,
    line_type: row.LINE_TYPE,
    amount: row.AMOUNT,
    description: row.DESCRIPTION,
    dist_code_combination_id: row.DIST_CODE_COMBINATION_ID,
  };
}

/**
 * List invoices for a single operating unit with optional filters + paging.
 * @param {object} filters { orgId, vendorId?, status?, dateFrom?, dateTo?, limit, offset }
 */
async function listInvoices(conn, filters) {
  const binds = { org_id: filters.orgId };
  const predicates = ['i.org_id = :org_id'];

  if (filters.vendorId !== undefined) {
    predicates.push('i.vendor_id = :vendor_id');
    binds.vendor_id = filters.vendorId;
  }
  if (filters.status !== undefined) {
    predicates.push('i.payment_status_flag = :status');
    binds.status = filters.status;
  }
  if (filters.dateFrom !== undefined) {
    predicates.push("i.invoice_date >= TO_DATE(:date_from, 'YYYY-MM-DD')");
    binds.date_from = filters.dateFrom;
  }
  if (filters.dateTo !== undefined) {
    predicates.push("i.invoice_date <= TO_DATE(:date_to, 'YYYY-MM-DD')");
    binds.date_to = filters.dateTo;
  }

  binds.row_offset = filters.offset;
  binds.row_limit = filters.limit;

  const sql = `
    SELECT ${CORE_COLUMNS}
      FROM ap_invoices_all i
      LEFT JOIN ap_suppliers s ON s.vendor_id = i.vendor_id
     WHERE ${predicates.join(' AND ')}
     ORDER BY i.invoice_id
     OFFSET :row_offset ROWS FETCH NEXT :row_limit ROWS ONLY`;

  const result = await conn.execute(sql, binds);
  return (result.rows || []).map(mapInvoice);
}

const GET_INVOICE_BY_ID = `
  SELECT ${CORE_COLUMNS}
    FROM ap_invoices_all i
    LEFT JOIN ap_suppliers s ON s.vendor_id = i.vendor_id
   WHERE i.invoice_id = :invoice_id`;

async function getInvoiceById(conn, invoiceId) {
  const result = await conn.execute(GET_INVOICE_BY_ID, { invoice_id: invoiceId });
  if (!result.rows || result.rows.length === 0) return null;
  return mapInvoice(result.rows[0]);
}

// On ap_invoice_lines_all the account code combination is default_dist_ccid;
// dist_code_combination_id only exists at the distribution level. We expose it
// under the stable output name dist_code_combination_id.
const GET_INVOICE_LINES = `
  SELECT line_number               AS line_number,
         line_type_lookup_code     AS line_type,
         amount                    AS amount,
         description               AS description,
         default_dist_ccid         AS dist_code_combination_id
    FROM ap_invoice_lines_all
   WHERE invoice_id = :invoice_id
   ORDER BY line_number`;

async function getInvoiceLines(conn, invoiceId) {
  const result = await conn.execute(GET_INVOICE_LINES, { invoice_id: invoiceId });
  return (result.rows || []).map(mapLine);
}

const INSERT_HEADER = `
  INSERT INTO ap_invoices_interface (
    invoice_id, invoice_num, invoice_date, vendor_id,
    invoice_amount, invoice_currency_code, terms_id, description,
    org_id, source, attribute_category,
    attribute1, attribute2, attribute3, attribute4, attribute5,
    attribute6, attribute7, attribute8, attribute9, attribute10,
    attribute11, attribute12, attribute13, attribute14, attribute15
  ) VALUES (
    ap_invoices_interface_s.NEXTVAL, :invoice_num, TO_DATE(:invoice_date, 'YYYY-MM-DD'), :vendor_id,
    :invoice_amount, :currency_code, :terms_id, :description,
    :org_id, :source, :attribute_category,
    :attribute1, :attribute2, :attribute3, :attribute4, :attribute5,
    :attribute6, :attribute7, :attribute8, :attribute9, :attribute10,
    :attribute11, :attribute12, :attribute13, :attribute14, :attribute15
  ) RETURNING invoice_id INTO :out_invoice_id`;

const INSERT_LINE = `
  INSERT INTO ap_invoice_lines_interface (
    invoice_id, invoice_line_id, line_number, line_type_lookup_code,
    amount, description, dist_code_combination_id, dist_code_concatenated
  ) VALUES (
    :invoice_id, ap_invoice_lines_interface_s.NEXTVAL, :line_number, :line_type,
    :amount, :description, :dist_code_combination_id, :dist_code_concatenated
  )`;

function attributeBinds(customFields = {}) {
  const binds = { attribute_category: customFields.attribute_category ?? null };
  for (let i = 1; i <= 15; i += 1) {
    binds[`attribute${i}`] = customFields[`attribute${i}`] ?? null;
  }
  return binds;
}

/**
 * Insert the invoice header + lines into the Payables Open Interface tables.
 * Runs without auto-commit; the caller (or the import submission that follows)
 * is responsible for committing so header, lines and submit succeed atomically.
 * @returns {Promise<number>} the generated interface invoice_id
 */
async function createInvoiceInterface(conn, payload, importSource) {
  const headerBinds = {
    invoice_num: payload.invoice_num,
    invoice_date: payload.invoice_date,
    vendor_id: payload.vendor_id,
    invoice_amount: payload.invoice_amount,
    currency_code: payload.currency_code,
    terms_id: payload.terms_id ?? null,
    description: payload.description ?? null,
    org_id: payload.org_id,
    source: importSource,
    ...attributeBinds(payload.custom_fields),
    out_invoice_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
  };

  const headerResult = await conn.execute(INSERT_HEADER, headerBinds, { autoCommit: false });
  const invoiceId = headerResult.outBinds.out_invoice_id[0];

  let lineNumber = 1;
  for (const line of payload.lines) {
    // eslint-disable-next-line no-await-in-loop
    await conn.execute(
      INSERT_LINE,
      {
        invoice_id: invoiceId,
        line_number: lineNumber,
        line_type: line.line_type || 'ITEM',
        amount: line.amount,
        description: line.description ?? null,
        dist_code_combination_id: line.dist_code_combination_id ?? null,
        dist_code_concatenated: line.account ?? null,
      },
      { autoCommit: false },
    );
    lineNumber += 1;
  }

  return invoiceId;
}

module.exports = {
  listInvoices,
  getInvoiceById,
  getInvoiceLines,
  createInvoiceInterface,
  mapInvoice,
  mapLine,
};
