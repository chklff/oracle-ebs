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
const SUBMIT_IMPORT = `
  BEGIN
    FND_GLOBAL.APPS_INITIALIZE(:user_id, :resp_id, :resp_appl_id);
    MO_GLOBAL.SET_POLICY_CONTEXT('S', :org_id);
    :request_id := FND_REQUEST.SUBMIT_REQUEST(
      :application,   -- application short name, e.g. SQLAP
      :program,       -- program short name, e.g. APXIIMPT
      '',             -- description
      '',             -- start time
      FALSE,          -- sub request
      :source,        -- argument1: import source
      :org_id_arg,    -- argument2: operating unit (verify position per instance)
      CHR(0)          -- argument delimiter / end marker
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

module.exports = { submitImport, getRequestStatus };
