'use strict';

const { oracledb } = require('../db');

/**
 * Submit and monitor the Payables Open Interface Import concurrent request.
 *
 * Submitting a concurrent request for a specific operating unit requires the
 * apps context to be initialised on the same connection. The exact program
 * arguments and the user/responsibility IDs are instance-specific - confirm
 * them with a DBA (see README / tech-spec). The block below commits on success
 * so the staged interface rows and the submission are persisted together.
 */
// Argument order matches the $SRS$.APXIIMPT descriptive flexfield (query
// fnd_descr_flex_col_usage_vl where descriptive_flexfield_name = '$SRS$.APXIIMPT'
// and application_id = 200 to verify per instance - column_seq_num order is
// Operating Unit, Source, Group, Batch Name, Hold Name, Hold Reason, GL Date,
// Purge, Trace Switch, Debug Switch, Summarize Report, Commit Batch Size, User
// ID, Login ID, Skip Validation. Batch Name is flagged required; FND_REQUEST.
// SUBMIT_REQUEST does not evaluate the SRS window's default-value formulas, so
// it must be supplied explicitly here (Oracle Forms only resolves that default
// interactively). :source must already exist in ap_lookup_codes with
// lookup_type = 'SOURCE', or every staged row is rejected at import time.
const SUBMIT_IMPORT = `
  BEGIN
    FND_GLOBAL.APPS_INITIALIZE(:user_id, :resp_id, :resp_appl_id);
    MO_GLOBAL.SET_POLICY_CONTEXT('S', :org_id);
    :request_id := FND_REQUEST.SUBMIT_REQUEST(
      :application,    -- application short name, e.g. SQLAP
      :program,        -- program short name, e.g. APXIIMPT
      '',              -- description
      '',              -- start time
      FALSE,           -- sub request
      :org_id_arg,     -- argument1: Operating Unit
      :source,         -- argument2: Source
      '',              -- argument3: Group
      :batch_name      -- argument4: Batch Name (required)
    );
    COMMIT;
  END;`;

async function submitImport(conn, params) {
  const binds = {
    user_id: params.appsUserId ?? null,
    resp_id: params.responsibilityId ?? null,
    resp_appl_id: params.responsibilityApplId ?? null,
    org_id: params.orgId,
    application: params.programApplication,
    program: params.programShortName,
    source: params.source,
    org_id_arg: String(params.orgId),
    batch_name: params.batchName,
    request_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
  };
  const result = await conn.execute(SUBMIT_IMPORT, binds);
  return result.outBinds.request_id;
}

const REQUEST_STATUS = `
  SELECT request_id  AS request_id,
         phase_code  AS phase_code,
         status_code AS status_code
    FROM fnd_concurrent_requests
   WHERE request_id = :request_id`;

// Concurrent request code -> human label (common subset).
const PHASE = { C: 'Completed', P: 'Pending', R: 'Running', I: 'Inactive' };
const STATUS = {
  A: 'Waiting',
  B: 'Resuming',
  C: 'Normal',
  D: 'Cancelled',
  E: 'Error',
  F: 'Scheduled',
  G: 'Warning',
  H: 'On Hold',
  I: 'Normal',
  M: 'No Manager',
  P: 'Paused',
  Q: 'Standby',
  R: 'Normal',
  S: 'Suspended',
  T: 'Terminating',
  U: 'Disabled',
  W: 'Paused',
  X: 'Terminated',
  Z: 'Waiting',
};

async function getRequestStatus(conn, requestId) {
  const result = await conn.execute(REQUEST_STATUS, { request_id: requestId });
  if (!result.rows || result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    request_id: row.REQUEST_ID,
    phase: PHASE[row.PHASE_CODE] || row.PHASE_CODE,
    status: STATUS[row.STATUS_CODE] || row.STATUS_CODE,
    phase_code: row.PHASE_CODE,
    status_code: row.STATUS_CODE,
  };
}

// ap_invoices_interface rows are kept (not deleted) after the import runs,
// whether they succeeded or were rejected - this is the only link back to the
// invoice a request staged, since ap_invoices_all has no request_id column at
// all. IMPORTANT: request_id alone is NOT a unique key into this table - one
// concurrent run sweeps every still-eligible pending/rejected row for that
// org+source together (including old backlog from earlier failed attempts),
// stamping the same request_id onto all of them. Only invoice_id (the value
// createInvoiceInterface returned when this row was staged) uniquely
// identifies "the row this specific POST /invoices call created."
const INTERFACE_ROW_BY_ID = `
  SELECT invoice_id, invoice_num, vendor_id, org_id, status
    FROM ap_invoices_interface
   WHERE invoice_id = :interface_invoice_id`;

const INTERFACE_ROW_FOR_REQUEST = `
  SELECT invoice_id, invoice_num, vendor_id, org_id, status
    FROM ap_invoices_interface
   WHERE request_id = :request_id`;

// TRIM both sides: Oracle's import trims trailing (but not leading) whitespace
// from invoice_num when creating the real row, so an untrimmed interface value
// like " FOO " can land in ap_invoices_all as " FOO" - an exact match on the
// interface's own value would then silently miss the row that really exists.
const REAL_INVOICE_ID = `
  SELECT invoice_id
    FROM ap_invoices_all
   WHERE TRIM(invoice_num) = TRIM(:invoice_num)
     AND vendor_id = :vendor_id
     AND org_id = :org_id`;

const REJECTION_REASONS = `
  SELECT reject_lookup_code
    FROM ap_interface_rejections
   WHERE parent_table = 'AP_INVOICES_INTERFACE'
     AND parent_id = :interface_invoice_id`;

/**
 * What actually happened to a staged invoice, beyond the raw concurrent-
 * request phase/status. Pass interfaceInvoiceId (returned by POST /invoices)
 * for a precise, unambiguous lookup. Without it, falls back to request_id,
 * but only trusts the result when exactly one row matches - see the note
 * above on why request_id can be ambiguous. Returns null when nothing can be
 * resolved either way.
 */
async function getImportOutcome(conn, { requestId, interfaceInvoiceId }) {
  let row;
  if (interfaceInvoiceId !== undefined) {
    const result = await conn.execute(INTERFACE_ROW_BY_ID, { interface_invoice_id: interfaceInvoiceId });
    row = result.rows?.[0];
  } else {
    const result = await conn.execute(INTERFACE_ROW_FOR_REQUEST, { request_id: requestId });
    if (result.rows && result.rows.length === 1) [row] = result.rows;
  }
  if (!row) return null;

  if (row.STATUS === 'PROCESSED') {
    const real = await conn.execute(REAL_INVOICE_ID, {
      invoice_num: row.INVOICE_NUM,
      vendor_id: row.VENDOR_ID,
      org_id: row.ORG_ID,
    });
    return {
      interface_status: row.STATUS,
      invoice_id: real.rows?.[0]?.INVOICE_ID ?? null,
    };
  }

  if (row.STATUS === 'REJECTED') {
    const rejections = await conn.execute(REJECTION_REASONS, { interface_invoice_id: row.INVOICE_ID });
    return {
      interface_status: row.STATUS,
      invoice_id: null,
      rejection_reasons: (rejections.rows || []).map((r) => r.REJECT_LOOKUP_CODE),
    };
  }

  return { interface_status: row.STATUS, invoice_id: null };
}

module.exports = { submitImport, getRequestStatus, getImportOutcome };
