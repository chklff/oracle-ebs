'use strict';

/**
 * Payment terms lookup. Backs GET /terms so callers can discover valid
 * terms_id values for POST /invoices (optional field, but a raw number is a
 * guess without this). Terms are global in EBS, not scoped to an operating
 * unit, unlike vendors/vendor-sites.
 */

const LIST_TERMS = `
  SELECT term_id AS term_id,
         name    AS name
    FROM ap_terms
   WHERE enabled_flag = 'Y'
     AND (end_date_active IS NULL OR end_date_active > SYSDATE)
   ORDER BY name`;

async function listTerms(conn) {
  const result = await conn.execute(LIST_TERMS, {});
  return (result.rows || []).map((row) => ({
    term_id: row.TERM_ID,
    name: row.NAME,
  }));
}

module.exports = { listTerms };
