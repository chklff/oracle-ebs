'use strict';

/**
 * Operating unit lookup. Backs GET /orgs so callers can discover valid org_id
 * values before reading or creating invoices.
 */

const LIST_OPERATING_UNITS = `
  SELECT organization_id AS org_id,
         name            AS name
    FROM hr_operating_units
   ORDER BY name`;

async function listOperatingUnits(conn) {
  const result = await conn.execute(LIST_OPERATING_UNITS, {});
  return (result.rows || []).map((row) => ({
    org_id: row.ORG_ID,
    name: row.NAME,
  }));
}

module.exports = { listOperatingUnits, LIST_OPERATING_UNITS };
