'use strict';

/**
 * Currency lookup. Backs GET /currencies so callers can discover valid
 * currency_code values for POST /invoices. Currency enablement in EBS is
 * global (fnd_currencies), not scoped to an operating unit or ledger - the
 * lowest-risk gap of the lookup endpoints since ISO codes are already
 * well-known, this just guards against ones disabled on this instance.
 */

const LIST_CURRENCIES = `
  SELECT currency_code AS currency_code,
         name          AS name
    FROM fnd_currencies_vl
   WHERE enabled_flag = 'Y'
   ORDER BY currency_code`;

async function listCurrencies(conn) {
  const result = await conn.execute(LIST_CURRENCIES, {});
  return (result.rows || []).map((row) => ({
    currency_code: row.CURRENCY_CODE,
    name: row.NAME,
  }));
}

module.exports = { listCurrencies };
