-- ---------------------------------------------------------------------------
-- EBS Invoice API Wrapper - service account grant template
-- ---------------------------------------------------------------------------
-- Run by a DBA. This creates a dedicated, low-privilege account for the API.
-- DO NOT run this from the application. DO NOT reuse APPS or any DBA account.
--
-- Schema prefixes (AP, APPS, HR) depend on the target instance. Verify each
-- object's real owner on your instance before running. On most EBS instances
-- the base tables live in AP/HR and the seeded packages/views live in APPS.
-- ---------------------------------------------------------------------------

-- 1) Create the account. Use a strong password and store it in a secret store;
--    the application reads it from an environment variable, never hardcoded.
CREATE USER make_ap_svc IDENTIFIED BY "<STRONG_PASSWORD_HERE>";

-- 2) Let it log in. That is the only system privilege it needs.
GRANT CREATE SESSION TO make_ap_svc;

-- 3) Read access for the invoice read endpoints.
GRANT SELECT ON ap.ap_invoices_all             TO make_ap_svc;
GRANT SELECT ON ap.ap_invoice_lines_all        TO make_ap_svc;
GRANT SELECT ON ap.ap_invoice_distributions_all TO make_ap_svc;
GRANT SELECT ON ap.ap_suppliers                TO make_ap_svc;

-- 4) Operating-unit discovery (GET /orgs).
GRANT SELECT ON apps.hr_operating_units        TO make_ap_svc;

-- 5) Write access to the Payables Open Interface tables (POST /invoices).
GRANT INSERT ON ap.ap_invoices_interface       TO make_ap_svc;
GRANT INSERT ON ap.ap_invoice_lines_interface  TO make_ap_svc;

-- 6) Sequences used to generate interface primary keys. Confirm the exact
--    sequence names/owners on your instance (names below are the common ones).
GRANT SELECT ON ap.ap_invoices_interface_s      TO make_ap_svc;
GRANT SELECT ON ap.ap_invoice_lines_interface_s TO make_ap_svc;

-- 7) Submit + monitor the import concurrent request (POST /invoices,
--    GET /invoices/import-status/:request_id).
GRANT EXECUTE ON apps.fnd_request              TO make_ap_svc;
GRANT SELECT  ON apps.fnd_concurrent_requests  TO make_ap_svc;

-- 8) OPTIONAL but usually required to submit a concurrent request for a
--    specific operating unit. Confirm the exact mechanism and the
--    user/responsibility IDs with your DBA before enabling POST.
GRANT EXECUTE ON apps.fnd_global               TO make_ap_svc;
GRANT EXECUTE ON apps.mo_global                TO make_ap_svc;

-- ---------------------------------------------------------------------------
-- Notes
-- - Grant nothing you do not use. If POST /invoices is not deployed, skip
--   steps 5-8 entirely and keep the account read-only.
-- - Prefer granting on APPS synonyms where your instance exposes them, rather
--   than reaching into base schemas directly, if your security policy requires.
-- ---------------------------------------------------------------------------
