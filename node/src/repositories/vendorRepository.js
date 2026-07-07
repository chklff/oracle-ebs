'use strict';

/**
 * Supplier (vendor) and supplier site lookups. Back GET /vendors and
 * GET /vendor-sites so callers can discover valid vendor_id/vendor_site_id
 * values before creating an invoice - vendor_site_id is required by
 * POST /invoices (Payables rejects any invoice with no resolvable site), but
 * has no other way to be discovered short of querying the database directly.
 */

const LIST_VENDORS = `
  SELECT DISTINCT s.vendor_id AS vendor_id,
                  s.vendor_name AS name
    FROM ap_suppliers s
    JOIN ap_supplier_sites_all ss ON ss.vendor_id = s.vendor_id
   WHERE ss.org_id = :org_id
     AND NVL(s.enabled_flag, 'Y') = 'Y'
     AND ss.pay_site_flag = 'Y'
     AND (ss.inactive_date IS NULL OR ss.inactive_date > SYSDATE)
   ORDER BY s.vendor_name`;

async function listVendors(conn, orgId) {
  const result = await conn.execute(LIST_VENDORS, { org_id: orgId });
  return (result.rows || []).map((row) => ({
    vendor_id: row.VENDOR_ID,
    name: row.NAME,
  }));
}

const LIST_VENDOR_SITES = `
  SELECT vendor_site_id AS vendor_site_id,
         vendor_site_code AS vendor_site_code
    FROM ap_supplier_sites_all
   WHERE vendor_id = :vendor_id
     AND org_id = :org_id
     AND pay_site_flag = 'Y'
     AND (inactive_date IS NULL OR inactive_date > SYSDATE)
   ORDER BY vendor_site_code`;

async function listVendorSites(conn, vendorId, orgId) {
  const result = await conn.execute(LIST_VENDOR_SITES, { vendor_id: vendorId, org_id: orgId });
  return (result.rows || []).map((row) => ({
    vendor_site_id: row.VENDOR_SITE_ID,
    vendor_site_code: row.VENDOR_SITE_CODE,
  }));
}

module.exports = { listVendors, listVendorSites };
