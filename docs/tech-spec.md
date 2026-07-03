# Tech Spec: EBS Payables Invoice API Wrapper

## Goal
Build a small, secure middleware service that exposes a stable HTTP/JSON API over Oracle EBS Payables invoice data, so Make.com (via on-prem agent + HTTP Agent module) can read and create invoices without needing ISG/ORDS or direct DB access from Make itself.

Build **two versions**, same API contract, same behavior:
- `ebs-invoice-api-python` (Flask + `oracledb`, Thin mode)
- `ebs-invoice-api-node` (Express + `oracledb`, Thin mode)

## Hard constraints (non-negotiable)

- No generic `/query` or any endpoint that executes arbitrary SQL from request input. Every endpoint maps to one fixed, parameterized query or procedure call.
- No DBA/superuser DB accounts. Connect only as a dedicated low-privilege user (see grants below), created separately by a DBA, credentials never hardcoded, always from environment variables / secrets.
- All SQL uses bind variables. No string concatenation or f-string interpolation of user input into SQL.
- Client secret required on every request (`X-Client-Secret` header, compared against an env var, reject with 401 if missing/wrong).
- No debug/dev server in "production" mode. Python: run via `gunicorn`/`waitress`, not `flask run`. Node: run via plain `node`/`pm2`, no nodemon.
- Bind to `127.0.0.1` by default; host/port configurable via env vars so it can be restricted at the network/firewall layer instead of exposed to `0.0.0.0`.
- Use connection pooling (`oracledb` pool in both languages), not a single shared global connection.
- Structured logging (request method/path/status/duration), no secrets in logs.
- `.env.example` file listing required config, real `.env` gitignored.

## What is an operating unit / `org_id`?

EBS runs many business units inside one database. An **operating unit** is one
such business unit (e.g. "US Operations", "Germany GmbH"). `org_id` is its
numeric identifier.

The Payables tables end in `_ALL` (`ap_invoices_all`, `ap_invoice_lines_all`, …)
because they hold rows for **every operating unit mixed together**, striped by
an `ORG_ID` column. A normal EBS session sees only its own operating unit via
seeded views; because this service connects as a raw DB account querying the
`_ALL` tables directly, it must filter by `org_id` itself. That is why:

- `GET /orgs` exists to discover valid `org_id` values, and
- `GET /invoices` and `POST /invoices` require an `org_id`.

## Required DB grants (document in README, do not auto-create)

See [`db-grants.sql`](./db-grants.sql) for the full, annotated template.

```sql
CREATE USER make_ap_svc IDENTIFIED BY "<password>";
GRANT CREATE SESSION TO make_ap_svc;
GRANT SELECT ON ap.ap_invoices_all TO make_ap_svc;
GRANT SELECT ON ap.ap_invoice_lines_all TO make_ap_svc;
GRANT SELECT ON ap.ap_invoice_distributions_all TO make_ap_svc;
GRANT SELECT ON ap.ap_suppliers TO make_ap_svc;
GRANT SELECT ON apps.hr_operating_units TO make_ap_svc;
GRANT INSERT ON ap.ap_invoices_interface TO make_ap_svc;
GRANT INSERT ON ap.ap_invoice_lines_interface TO make_ap_svc;
GRANT EXECUTE ON apps.fnd_request TO make_ap_svc;
```
(Exact schema prefix depends on target instance, treat as a template, verify with DBA before running.)

## Endpoints

### `GET /health`
No auth required. Returns `{"status": "ok", "db": "connected"|"error"}`. Checks pool connectivity.

### `GET /orgs`
Auth required. Discovery endpoint so the caller can look up valid `org_id` (operating unit) values before making other calls.
Query params: none.
Returns a list from `hr_operating_units`:
```json
[
  { "org_id": 101, "name": "US Operations" },
  { "org_id": 204, "name": "Germany GmbH" }
]
```
Operating units are EBS's business-unit partitions. The `_ALL` invoice tables mix all operating units together, striped by an `ORG_ID` column, so every read/write below must target a specific operating unit.

### `GET /invoices`
Query params: `org_id` (**required** — which operating unit to read from), `vendor_id` (optional), `status` (optional), `date_from`, `date_to`, `limit` (default 50, max 500), `offset`.
Returns paginated list from `ap_invoices_all` (filtered by `WHERE org_id = :org_id`) joined to `ap_suppliers` for vendor name. Missing `org_id` → 400.

Core fields (always present):
```json
{
  "invoice_id": 12345,
  "invoice_num": "INV-001",
  "invoice_date": "2026-06-01",
  "vendor_id": 987,
  "vendor_name": "Acme Corp",
  "invoice_amount": 1500.00,
  "currency_code": "USD",
  "gl_date": "2026-06-05",
  "payment_status_flag": "N",
  "custom_fields": { "attribute_category": "...", "attribute1": "...", "...": "attribute15" }
}
```
`custom_fields` is a generic passthrough of `ATTRIBUTE_CATEGORY` + `ATTRIBUTE1`..`ATTRIBUTE15`, no assumed meaning, label mapping is a config concern for the consuming Make app, not this API.

### `GET /invoices/:id`
Single invoice by `invoice_id` (globally unique primary key, so `org_id` is not required here), same shape as above, plus its `org_id` echoed back and a nested `lines` array from `ap_invoice_lines_all`.

### `POST /invoices`
Body: `org_id` (**required** — target operating unit) plus core fields (`invoice_num`, `invoice_date`, `vendor_id`, `invoice_amount`, `currency_code`, `terms_id`, `description`, at least one line with `amount`, `dist_code_combination_id` or account string) plus optional `custom_fields` object mapped back to `ATTRIBUTE1..15`.

Behavior: validate required fields incl. `org_id` (400 if missing), insert into `ap_invoices_interface` + `ap_invoice_lines_interface` (with `ORG_ID` set) using bind variables, call `FND_REQUEST.SUBMIT_REQUEST` for the Payables Open Interface Import concurrent program targeting that operating unit, return `{"status": "submitted", "request_id": ...}` (this is async, invoice isn't created synchronously, the import job processes it).

> **Note on POST org context:** submitting a concurrent request for a specific operating unit typically requires initializing the apps context (`FND_GLOBAL.APPS_INITIALIZE`) and setting the org policy (`MO_GLOBAL.SET_POLICY_CONTEXT`) on the connection before `SUBMIT_REQUEST`. This may require additional `EXECUTE` grants (`apps.fnd_global`, `apps.mo_global`) beyond the current list — confirm the exact mechanism and responsibility/user IDs with the DBA. Reads do not need this since they filter `_ALL` tables by `org_id` directly.

### `GET /invoices/import-status/:request_id`
Poll concurrent request status (`fnd_concurrent_requests`), return phase/status so Make can poll until the import completes or errors.

## Error handling
- 400 for validation errors, with a clear `{"error": "..."}` body, no stack traces.
- 401 for missing/invalid client secret.
- 404 for invoice not found.
- 500 for unexpected errors, logged server-side with full detail, generic message to client.

## Deliverables per repo
- Source code implementing the above.
- `.env.example`.
- `README.md`: setup, required env vars, DB grant script reference, how to run in dev vs production, example `curl` calls for every endpoint.
- `Dockerfile` (optional but preferred).
- Basic tests for each endpoint using a mocked DB layer (no real DB required to run tests).

## Explicitly out of scope
- ISG/ORDS integration (separate future path).
- OAuth2/JWT (API key is sufficient for this phase).
- Any UI.
