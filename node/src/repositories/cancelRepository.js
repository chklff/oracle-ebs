'use strict';

const { oracledb } = require('../db');

/**
 * POST /invoices/:id/cancel support. Uses Oracle's own supported cancellation
 * package (AP_CANCEL_PKG) rather than direct UPDATE SQL - this is the one
 * genuinely public, purpose-built API for mutating an existing invoice's
 * financial state (see docs/api.md "PATCH /invoices/:id" for why direct SQL is
 * NOT used for anything financial). Cancellation itself is a real EBS business
 * transaction: it zeroes invoice_amount, stamps cancelled_amount/cancelled_date,
 * and reverses distributions - it is NOT reversible through this API (Oracle
 * has no "un-cancel"), so callers should treat a successful cancel as final.
 */

const GET_CANCELLABLE_STATE = `
  SELECT invoice_id, org_id, cancelled_date
    FROM ap_invoices_all
   WHERE invoice_id = :invoice_id`;

/** @returns {Promise<{exists: boolean, orgId: number|null, cancelled: boolean}>} */
async function getCancellableState(conn, invoiceId) {
  const result = await conn.execute(GET_CANCELLABLE_STATE, { invoice_id: invoiceId });
  if (!result.rows || result.rows.length === 0) return { exists: false, orgId: null, cancelled: false };
  const row = result.rows[0];
  return { exists: true, orgId: row.ORG_ID, cancelled: row.CANCELLED_DATE != null };
}

// AP_CANCEL_PKG.IS_INVOICE_CANCELLABLE is a PL/SQL-boolean-returning function -
// it cannot be called directly from SQL, only from a PL/SQL block. Converted
// to a NUMBER (1/0) here rather than binding PLS_INTEGER/BOOLEAN directly, to
// avoid depending on node-oracledb/Oracle client version support for PL/SQL
// boolean binds.
//
// IMPORTANT (found live): this function's internal org/security checks
// require the Apps session context to be initialised first - same as
// AP_CANCEL_SINGLE_INVOICE below. Without FND_GLOBAL.APPS_INITIALIZE +
// MO_GLOBAL.SET_POLICY_CONTEXT, it fails closed and reports EVERY invoice as
// not cancellable with a generic, misleading reason ("Check if invoices have
// been applied against this invoice..."), regardless of the invoice's real
// state - confirmed by testing invoice 41249 both ways: without context it
// came back not-cancellable; with context (org 1017) it correctly came back
// cancellable, with a specific reason ("Check if the invoice has retainage
// which is already released"). Do not drop this context setup.
const IS_CANCELLABLE = `
  DECLARE
    l_result BOOLEAN;
  BEGIN
    FND_GLOBAL.APPS_INITIALIZE(:user_id, :resp_id, :resp_appl_id);
    MO_GLOBAL.SET_POLICY_CONTEXT('S', :org_id);

    l_result := AP_CANCEL_PKG.IS_INVOICE_CANCELLABLE(
      P_INVOICE_ID => :invoice_id,
      P_ERROR_CODE => :error_code,
      P_DEBUG_INFO => :debug_info,
      P_CALLING_SEQUENCE => :calling_sequence
    );
    :cancellable := CASE WHEN l_result THEN 1 ELSE 0 END;
  END;`;

/**
 * Pure read - safe to call any number of times. Mirrors the check Oracle's own
 * Invoice Workbench runs before showing/allowing the Cancel action. Requires
 * orgId (and the same Apps user/responsibility context as cancelInvoice) -
 * see the note above on why.
 * @param {object} params { invoiceId, orgId, appsUserId, responsibilityId, responsibilityApplId }
 * @returns {Promise<{cancellable: boolean, errorCode: string|null}>}
 */
async function checkCancellable(conn, params) {
  const binds = {
    user_id: params.appsUserId ?? null,
    resp_id: params.responsibilityId ?? null,
    resp_appl_id: params.responsibilityApplId ?? null,
    org_id: params.orgId,
    invoice_id: params.invoiceId,
    error_code: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 240 },
    debug_info: { dir: oracledb.BIND_INOUT, type: oracledb.STRING, maxSize: 2000, val: '' },
    calling_sequence: 'ebs-invoice-api-wrapper.checkCancellable',
    cancellable: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
  };
  const result = await conn.execute(IS_CANCELLABLE, binds);
  // error_code is often left null even when not cancellable - confirmed live
  // against a real paid invoice: error_code was null but debug_info held the
  // actual human-readable reason. Fall back to debug_info so callers still
  // get something actionable.
  const reason = result.outBinds.error_code || result.outBinds.debug_info || null;
  return {
    cancellable: result.outBinds.cancellable === 1,
    errorCode: reason,
  };
}

// AP_CANCEL_SINGLE_INVOICE performs the real cancellation. Needs the Apps
// session context initialised first (same FND_GLOBAL.APPS_INITIALIZE +
// MO_GLOBAL.SET_POLICY_CONTEXT pattern as importRepository.submitImport) so
// the package's internal org/security checks resolve correctly.
// last_update_login => 0 is the standard EBS convention for a WHO-column
// update made outside an interactive Forms/OA session (no real login id to
// attribute it to).
const CANCEL_SINGLE_INVOICE = `
  DECLARE
    l_result BOOLEAN;
  BEGIN
    FND_GLOBAL.APPS_INITIALIZE(:user_id, :resp_id, :resp_appl_id);
    MO_GLOBAL.SET_POLICY_CONTEXT('S', :org_id);

    l_result := AP_CANCEL_PKG.AP_CANCEL_SINGLE_INVOICE(
      P_INVOICE_ID => :invoice_id,
      P_LAST_UPDATED_BY => :last_updated_by,
      P_LAST_UPDATE_LOGIN => :last_update_login,
      P_ACCOUNTING_DATE => NVL(TO_DATE(:accounting_date, 'YYYY-MM-DD'), TRUNC(SYSDATE)),
      P_MESSAGE_NAME => :message_name,
      P_INVOICE_AMOUNT => :invoice_amount,
      P_BASE_AMOUNT => :base_amount,
      P_TEMP_CANCELLED_AMOUNT => :temp_cancelled_amount,
      P_CANCELLED_BY => :cancelled_by,
      P_CANCELLED_AMOUNT => :cancelled_amount,
      P_CANCELLED_DATE => :cancelled_date,
      P_LAST_UPDATE_DATE => :last_update_date,
      P_ORIGINAL_PREPAYMENT_AMOUNT => :orig_prepayment_amount,
      P_PAY_CURR_INVOICE_AMOUNT => :pay_curr_invoice_amount,
      P_TOKEN => :token,
      P_CALLING_SEQUENCE => :calling_sequence
    );

    :success := CASE WHEN l_result THEN 1 ELSE 0 END;
    IF l_result THEN
      COMMIT;
    ELSE
      ROLLBACK;
    END IF;
  END;`;

/**
 * Actually cancels the invoice. Caller should have already confirmed
 * existence, not-already-cancelled, and checkCancellable() === true - this
 * function does not re-check, it only performs the cancellation.
 * @param {object} params { invoiceId, orgId, accountingDate?, appsUserId, responsibilityId, responsibilityApplId }
 * @returns {Promise<{success: boolean, messageName: string|null, invoiceAmount: number|null, cancelledAmount: number|null, cancelledDate: string|null}>}
 */
async function cancelInvoice(conn, params) {
  const binds = {
    user_id: params.appsUserId ?? null,
    resp_id: params.responsibilityId ?? null,
    resp_appl_id: params.responsibilityApplId ?? null,
    org_id: params.orgId,
    invoice_id: params.invoiceId,
    last_updated_by: params.appsUserId ?? null,
    last_update_login: 0,
    accounting_date: params.accountingDate ?? null,
    message_name: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 240 },
    invoice_amount: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    base_amount: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    temp_cancelled_amount: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    cancelled_by: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    cancelled_amount: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    cancelled_date: { dir: oracledb.BIND_OUT, type: oracledb.DATE },
    last_update_date: { dir: oracledb.BIND_OUT, type: oracledb.DATE },
    orig_prepayment_amount: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    pay_curr_invoice_amount: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    token: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 240 },
    calling_sequence: 'ebs-invoice-api-wrapper.cancelInvoice',
    success: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
  };

  const result = await conn.execute(CANCEL_SINGLE_INVOICE, binds, { autoCommit: false });
  const out = result.outBinds;
  return {
    success: out.success === 1,
    messageName: out.message_name || null,
    invoiceAmount: out.invoice_amount ?? null,
    cancelledAmount: out.cancelled_amount ?? null,
    cancelledDate: out.cancelled_date ? out.cancelled_date.toISOString().slice(0, 10) : null,
  };
}

module.exports = { getCancellableState, checkCancellable, cancelInvoice };
