'use strict';

/**
 * Supplier (vendor) and supplier site lookups. Back GET /vendors and
 * GET /vendor-sites so callers can discover valid vendor_id/vendor_site_id
 * values before creating an invoice - vendor_site_id is required by
 * POST /invoices (Payables rejects any invoice with no resolvable site), but
 * has no other way to be discovered short of querying the database directly.
 */

// tax_id filters on vat_registration_num - the standout real, populated
// column on the reference instance (40/426 suppliers) for a general vendor
// tax ID. Confirm this matches the target instance's actual usage before
// relying on it for a new customer; num_1099 (US 1099 reporting) and
// company_registration_number both exist too but are less likely candidates
// (the latter was entirely unpopulated on the reference instance).
// org_id is optional here: when given, scopes to vendors with an enabled pay
// site in that org (the original, stricter behavior). When omitted, searches
// by name/tax_id across every org instead - a caller may only have a
// vendor's name or tax ID from an external system and not yet know which org
// it belongs to. The route layer already requires org_id OR name/tax_id, so
// this never runs fully unscoped.
async function listVendors(conn, { orgId, name, taxId } = {}) {
  const binds = {};
  const predicates = ["NVL(s.enabled_flag, 'Y') = 'Y'"];

  if (name !== undefined) {
    predicates.push('UPPER(s.vendor_name) LIKE UPPER(:name)');
    binds.name = `%${name}%`;
  }
  if (taxId !== undefined) {
    predicates.push('s.vat_registration_num = :tax_id');
    binds.tax_id = taxId;
  }

  let sql;
  if (orgId !== undefined) {
    binds.org_id = orgId;
    predicates.push('ss.org_id = :org_id', "ss.pay_site_flag = 'Y'", '(ss.inactive_date IS NULL OR ss.inactive_date > SYSDATE)');
    sql = `
      SELECT DISTINCT s.vendor_id AS vendor_id,
                      s.vendor_name AS name,
                      s.vat_registration_num AS tax_id
        FROM ap_suppliers s
        JOIN ap_supplier_sites_all ss ON ss.vendor_id = s.vendor_id
       WHERE ${predicates.join(' AND ')}
       ORDER BY s.vendor_name`;
  } else {
    sql = `
      SELECT s.vendor_id AS vendor_id,
             s.vendor_name AS name,
             s.vat_registration_num AS tax_id
        FROM ap_suppliers s
       WHERE ${predicates.join(' AND ')}
       ORDER BY s.vendor_name`;
  }

  const result = await conn.execute(sql, binds);
  return (result.rows || []).map((row) => ({
    vendor_id: row.VENDOR_ID,
    name: row.NAME,
    tax_id: row.TAX_ID,
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
