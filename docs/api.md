# API Reference

All examples below use `$BASE_URL` for the server address. Set it to wherever
this API is actually reachable from where you're running the request:

```bash
export BASE_URL=http://127.0.0.1:3000   # or wherever it's actually reachable
```

Don't assume `$BASE_URL` is `http://<HOST>:<PORT>` from the server's own
`.env` — `HOST`/`PORT` only control what address the Node process binds to
*inside* the machine it runs on. In practice the service usually sits behind
something else (an SSH tunnel, a reverse proxy, a load balancer, a different
public port) with its own hostname/port, so the reachable URL is very rarely
`127.0.0.1:3000` from the caller's point of view.

All endpoints except `GET /health` require the header:

```
X-Client-Secret: <the value of CLIENT_SECRET on the server>
```

A missing or wrong secret returns `401`.

Error responses are always JSON:

```json
{ "error": "human readable message" }
```

Validation errors may include a `details` array:

```json
{ "error": "Validation failed", "details": ["invoice_num is required"] }
```

---

## GET /health

Liveness + database pool connectivity. **No auth.**

```bash
curl $BASE_URL/health
```

```json
{ "status": "ok", "db": "connected" }
```

`db` is `"error"` if a pooled connection cannot be obtained.

---

## GET /orgs

List operating units so a caller can discover valid `org_id` values.

```bash
curl $BASE_URL/orgs \
  -H "X-Client-Secret: $CLIENT_SECRET"
```

```json
[
  { "org_id": 101, "name": "US Operations" },
  { "org_id": 204, "name": "Germany GmbH" }
]
```

---

## GET /vendors

List suppliers usable in one operating unit, so a caller can discover valid
`vendor_id` values before creating an invoice. A vendor only appears here if
it has at least one enabled pay site in that org (a vendor with no site in
the target org can't be used for `POST /invoices` there anyway).

| Query param | Required | Notes |
|-------------|----------|-------|
| `org_id`    | yes, unless `name`/`tax_id` given | Operating unit to filter by |
| `name`      | no       | Case-insensitive partial match on `vendor_name` |
| `tax_id`    | no       | Exact match on `vat_registration_num` |

**`org_id` is optional when searching by `name` or `tax_id`** - in that case
the search runs across every org instead of one. This matters when a caller
only has a vendor's name or tax ID (e.g. from an external system like
Monday.com) and doesn't yet know which operating unit it belongs to - without
this, there'd be no way to even find the vendor. At least one of `org_id`,
`name`, `tax_id` is required, or it's a `400` (this endpoint won't dump every
vendor on the instance unscoped).

```bash
curl "$BASE_URL/vendors?org_id=204" \
  -H "X-Client-Secret: $CLIENT_SECRET"
```

```json
[
  { "vendor_id": 1, "name": "GE Plastics", "tax_id": null },
  { "vendor_id": 11, "name": "Advantage Corp", "tax_id": null }
]
```

```bash
curl "$BASE_URL/vendors?org_id=204&tax_id=12345678901" \
  -H "X-Client-Secret: $CLIENT_SECRET"
```

`tax_id` matches `ap_suppliers.vat_registration_num` - the standout real,
populated column (40/426 suppliers on the reference instance) for a general
vendor tax ID. Two other candidate columns exist (`num_1099` - US 1099
reporting specifically, not a general tax ID; `company_registration_number` -
present but entirely unpopulated on the reference instance). **Confirm
`vat_registration_num` is actually where a given customer's real tax ID data
lives before relying on this for a new integration** - don't assume it
transfers from one instance to the next any more than `dist_code_combination_id`
formats do.

Missing `org_id` → `400`.

---

## GET /vendor-sites

List a vendor's supplier sites in one operating unit, so a caller can
discover valid `vendor_site_id` values. **`vendor_site_id` is required by
`POST /invoices`** - Oracle Payables rejects any invoice with no resolvable
supplier site (`NO SUPPLIER SITE`), and there's no way to guess it without
this lookup.

| Query param | Required | Notes |
|-------------|----------|-------|
| `org_id`    | yes      | Operating unit to filter by |
| `vendor_id` | yes      | Supplier to list sites for |

```bash
curl "$BASE_URL/vendor-sites?org_id=204&vendor_id=1" \
  -H "X-Client-Secret: $CLIENT_SECRET"
```

```json
[
  { "vendor_site_id": 1, "vendor_site_code": "GE PLASTICS" },
  { "vendor_site_id": 985, "vendor_site_code": "GE PLASTICS 3W" }
]
```

Missing `org_id` or `vendor_id` → `400`.

---

## GET /terms

List enabled payment terms, so a caller can discover valid `terms_id` values
(optional field on `POST /invoices`). Terms are global in EBS, not scoped to
an operating unit.

```bash
curl "$BASE_URL/terms" \
  -H "X-Client-Secret: $CLIENT_SECRET"
```

```json
[
  { "term_id": 10001, "name": "Immediate" },
  { "term_id": 10002, "name": "30 Net (terms date + 30)" }
]
```

---

## GET /currencies

List enabled currencies, so a caller can discover valid `currency_code`
values. Currency enablement in EBS is global (`fnd_currencies`), not scoped to
an operating unit or ledger - this is the lowest-risk of the lookup gaps,
since ISO codes are already well-known; this mainly guards against a code
that's disabled on a given instance.

```bash
curl "$BASE_URL/currencies" \
  -H "X-Client-Secret: $CLIENT_SECRET"
```

```json
[
  { "currency_code": "AED", "name": "UAE Dirham" },
  { "currency_code": "USD", "name": "US Dollar" }
]
```

**Not yet built:** a lookup for `dist_code_combination_id`/`account` (GL code
combinations). This one is a separate, larger effort - see the note under
`POST /invoices` above.

---

## GET /purchase-orders

List open purchase orders for a vendor, so a caller can discover valid
`po_header_id` values for PO-matched invoice lines. Filtered to
`closed_code != 'FINALLY CLOSED'` (or null) so fully-consumed POs don't
clutter the list.

| Query param | Required | Notes |
|-------------|----------|-------|
| `org_id`    | yes      | Operating unit to filter by |
| `vendor_id` | yes      | Supplier to filter by |

```bash
curl "$BASE_URL/purchase-orders?org_id=204&vendor_id=1" \
  -H "X-Client-Secret: $CLIENT_SECRET"
```

```json
[
  { "po_header_id": 61, "po_number": "501", "type": "BLANKET" }
]
```

Missing `org_id` or `vendor_id` → `400`.

---

## GET /purchase-orders/:po_header_id/lines

List a PO's *shipments* (not lines - a single PO line commonly has dozens of
shipments/releases; a live Blanket PO on the reference instance had 70+, most
long since closed), filtered to `closed_code = 'OPEN'` and not cancelled, so
this only returns ones genuinely still open to invoice.

```bash
curl "$BASE_URL/purchase-orders/61/lines" \
  -H "X-Client-Secret: $CLIENT_SECRET"
```

```json
[
  {
    "po_line_id": 61,
    "po_line_location_id": 12067,
    "line_num": 1,
    "item_description": "Leather Computer Case",
    "unit_price": 100,
    "match_option": "P",
    "quantity": 750,
    "quantity_received": 0,
    "quantity_billed": 0
  }
]
```

**`POST /invoices` does not yet support PO-matched lines end-to-end** - see
the gotcha under `POST /invoices` below. These two `GET` endpoints work fine
on their own for discovery/display purposes even though creating a PO-matched
invoice isn't resolved yet.

Unknown `po_header_id` → empty array, not `404` (matches `GET /invoices`
behavior for a filter with no results).

---

## GET /invoices

Paginated invoice list for **one** operating unit.

| Query param | Required | Notes |
|-------------|----------|-------|
| `org_id`    | yes      | Operating unit to read from |
| `vendor_id` | no       | Filter by supplier |
| `status`    | no       | Matches `payment_status_flag` |
| `date_from` | no       | `YYYY-MM-DD`, invoice_date >= |
| `date_to`   | no       | `YYYY-MM-DD`, invoice_date <= |
| `limit`     | no       | Default 50, max 500 |
| `offset`    | no       | Default 0 |

```bash
curl "$BASE_URL/invoices?org_id=101&date_from=2026-06-01&limit=50" \
  -H "X-Client-Secret: $CLIENT_SECRET"
```

```json
{
  "data": [
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
      "invoice_type": "STANDARD",
      "org_id": 101,
      "custom_fields": {
        "attribute_category": null,
        "attribute1": "PO-42",
        "attribute2": null,
        "attribute3": null,
        "attribute4": null,
        "attribute5": null,
        "attribute6": null,
        "attribute7": null,
        "attribute8": null,
        "attribute9": null,
        "attribute10": null,
        "attribute11": null,
        "attribute12": null,
        "attribute13": null,
        "attribute14": null,
        "attribute15": null
      }
    }
  ],
  "limit": 50,
  "offset": 0,
  "count": 1
}
```

Missing `org_id` → `400`.

---

## GET /invoices/dff-schema

Descriptive Flexfield (DFF) metadata for the `custom_fields` (`attribute1`
through `attribute15`, plus `attribute_category`) on invoices. These columns
are Oracle's generic DFF storage — their real-world meaning is configured per
customer in Application Object Library, not in this API. This endpoint
exposes that configuration so a caller can show human labels instead of raw
`attribute5`-style keys.

**This is context-sensitive.** There is no single flat column → label map for
an instance. Which label set applies depends on the invoice's own
`attribute_category` value (returned in `custom_fields.attribute_category`),
matched against `context_code` below. `"Global Data Elements"` is the context
used when `attribute_category` is null/blank, and commonly has no columns
configured at all (meaning `attribute1..15` are simply unused for those
invoices).

```bash
curl $BASE_URL/invoices/dff-schema \
  -H "X-Client-Secret: $CLIENT_SECRET"
```

```json
{
  "contexts": [
    { "context_code": "Global Data Elements", "context_name": "Global Data Elements", "enabled": true, "columns": [] },
    {
      "context_code": "One-Time",
      "context_name": "One-Time",
      "enabled": true,
      "columns": [
        { "column": "attribute5", "label": "Misc Vendor City", "display_order": 30, "enabled": true, "displayed": true, "required": true }
      ]
    }
  ]
}
```

To relabel a specific invoice's `custom_fields`: find the context whose
`context_code` equals that invoice's `attribute_category`, then map each
`columns[].column` to its `label`.

---

## GET /invoices/:id

One invoice plus its lines. `org_id` is not required (`invoice_id` is globally
unique); the invoice's own `org_id` is echoed back.

```bash
curl $BASE_URL/invoices/12345 \
  -H "X-Client-Secret: $CLIENT_SECRET"
```

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
  "invoice_type": "STANDARD",
  "org_id": 101,
  "custom_fields": { "attribute_category": null, "attribute1": "PO-42" },
  "lines": [
    {
      "line_number": 1,
      "line_type": "ITEM",
      "amount": 1500.00,
      "description": "Consulting",
      "dist_code_combination_id": 55501
    }
  ]
}
```

Unknown id → `404`.

---

## POST /invoices

Stage an invoice into the Payables Open Interface tables and submit the import
concurrent program. **This is asynchronous** — the invoice is not created
synchronously. You get back a `request_id` to poll.

| Field | Required | Notes |
|-------|----------|-------|
| `org_id` | yes | integer |
| `invoice_num` | yes | any non-empty value |
| `invoice_date` | yes | `YYYY-MM-DD` - must fall in an **open GL period**, see gotchas below |
| `vendor_id` | yes | integer - look up via `GET /vendors` |
| `vendor_site_id` | yes | integer - look up via `GET /vendor-sites`. Oracle rejects any invoice with no resolvable site (`NO SUPPLIER SITE`) |
| `invoice_amount` | yes | number |
| `currency_code` | yes | any non-empty value |
| `lines` | yes | at least 1 |
| `lines[].amount` | yes | number, per line |
| `lines[].dist_code_combination_id` or `lines[].account` (GL-coded), **or** `lines[].po_line_id` + `lines[].po_line_location_id` + `lines[].quantity_invoiced` (PO-matched) | yes (exactly one shape) | per line - mutually exclusive, see the unresolved gap below before relying on the PO-matched shape |
| `terms_id` | no | nullable |
| `description` | no | nullable |
| `custom_fields.*` (attribute1-15, attribute_category) | no | nullable |
| `lines[].line_type` | no | defaults to `ITEM`. `TAX` exists structurally but see the unresolved gap below before relying on it |
| `lines[].tax_regime_code`, `lines[].tax_status_code`, `lines[].tax_rate_code`, `lines[].tax_jurisdiction_code`, `lines[].tax_classification_code` | no | Only meaningful on a `TAX` line (e-Business Tax engine) - see the unresolved gap below |
| `lines[].po_header_id`, `lines[].po_line_number`, `lines[].po_shipment_num`, `lines[].po_unit_of_measure`, `lines[].unit_price` | no | Additional PO-matching fields beyond the required PO-matched shape above - real `AP_INVOICE_LINES_INTERFACE` columns, exposed for experimentation; see the unresolved gap below, no known-working combination yet |
| `invoice_type` | no | defaults to `STANDARD`. See below - **not** every value works with just `vendor_id`/`vendor_site_id` |
| `calc_tax_during_import` | no | boolean, maps to `calc_tax_during_import_flag`. Untested end-to-end - see the tax gotcha below |

**`invoice_type`** maps to `invoice_type_lookup_code`, not validated against a
hardcoded enum here (same approach as `currency_code` - Oracle's own
`AP_LOOKUP_CODES`, lookup_type `INVOICE TYPE`, is the source of truth).
Verified working with normal `vendor_id`/`vendor_site_id`: `STANDARD`
(default) and `CREDIT`; `DEBIT`/`MIXED`/`PREPAYMENT`/etc. are presumed to work
the same way but untested.

**`PAYMENT REQUEST` does *not* work with this endpoint as-is.** Tested against
a live instance: submitting one with a normal `vendor_id`/`vendor_site_id`
gets silently ignored by the import - not rejected, just never picked up
(`request_id` on the interface row stays `null` forever). Real `PAYMENT
REQUEST` invoices on the reference instance use sentinel values
`vendor_id = -222`, `vendor_site_id = -222`, plus a genuine `party_id`
(a Trading Community Architecture party, not a regular supplier) - a
structurally different creation path this API doesn't support yet. Treat this
as a separate, unbuilt feature, not a quick fix.

This field list is safe to keep identical across different EBS customers/
instances — it's a thin pass-through to Oracle's seeded
`AP_INVOICES_INTERFACE` / `AP_INVOICE_LINES_INTERFACE` tables, which aren't
customer-customized. What does **not** transfer between customers is the set
of *valid values* behind some of these fields, so don't hardcode assumptions
there:

- `org_id` — already solved via `GET /orgs`.
- `vendor_id` / `vendor_site_id` — already solved via `GET /vendors` and
  `GET /vendor-sites`; each customer has a completely different supplier list.
- `terms_id` — already solved via `GET /terms`.
- `currency_code` — already solved via `GET /currencies`. ISO codes are
  universal, but which ones are enabled varies per customer.
- `dist_code_combination_id` / `account` — the biggest one. The concatenated
  `account` string's shape (segment count, separators, meaning) comes from
  that customer's Chart of Accounts / Accounting Flexfield structure and
  differs completely between instances.
- `custom_fields` (attribute1-15) — correctly an opaque pass-through here, but
  the meaning of each attribute is defined per customer's DFF context, so it
  needs per-deployment documentation, not per-deployment code changes.

```bash
curl -X POST $BASE_URL/invoices \
  -H "X-Client-Secret: $CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "org_id": 101,
    "invoice_num": "INV-1001",
    "invoice_date": "2026-07-01",
    "vendor_id": 987,
    "vendor_site_id": 654,
    "invoice_amount": 1500.00,
    "currency_code": "USD",
    "terms_id": 10001,
    "description": "July consulting",
    "custom_fields": { "attribute1": "PO-42" },
    "lines": [
      {
        "amount": 1500.00,
        "line_type": "ITEM",
        "description": "Consulting",
        "dist_code_combination_id": 55501
      }
    ]
  }'
```

```json
{ "status": "submitted", "request_id": 8675309, "interface_invoice_id": 5173458 }
```

Keep both IDs. `request_id` is Oracle's concurrent request; `interface_invoice_id`
is the specific staged row this call created - pass it to
`GET /invoices/import-status/:request_id?interface_invoice_id=` (below) for an
unambiguous outcome, since `request_id` alone can cover more than just your
invoice once other pending/rejected rows exist for the same org+source.

Each line requires either `dist_code_combination_id` (numeric code combination
id) or `account` (a concatenated account string, mapped to
`dist_code_concatenated`). Missing required fields → `400`.

### Gotchas (found the hard way, against a real instance)

A `202 submitted` response only means Oracle accepted the request into its
concurrent-manager queue - it does **not** mean the invoice was created. Poll
`GET /invoices/import-status/:request_id` (below) and check its `status`; even
a `status: "Normal"` completion can still mean zero rows were actually
imported if the underlying interface row was rejected for business reasons.
Two rejection reasons that aren't obvious from this API's response alone,
found while integration-testing against a live Vision demo instance:

- **`ACCT DATE NOT IN OPEN PD`** - `invoice_date` (used as the accounting date
  when no separate GL date is supplied) must fall inside a GL period that is
  actually open for that org's ledger. This is pure EBS setup/data state, not
  something this API controls or can validate up front - a period has to be
  manually opened in Oracle each month. If every invoice you submit gets
  silently rejected, check `gl_period_statuses` for the target ledger before
  assuming the API is broken.
- **`NO SUPPLIER SITE`** - this is exactly why `vendor_site_id` is required
  above; Oracle Payables cannot create an invoice with no resolvable pay site.
- **`DUPLICATE INVOICE NUMBER`** - `invoice_num` must be unique per
  vendor+org, same as entering one by hand in Payables. Reusing a value that
  already succeeded gets rejected with this reason.

**Whitespace in `invoice_num` is not your friend.** Oracle's import trims
*trailing* whitespace when it creates the real row, but not *leading*
whitespace - `" FOO "` staged can land as `" FOO"` in `ap_invoices_all`, an
inconsistency this API works around internally (see the next section) but
that's worth knowing if you're ever comparing invoice numbers yourself.

**`TAX`-type lines are an unresolved gap - don't rely on them yet.** This
instance uses Oracle's modern e-Business Tax engine (`tax_regime_code`/
`tax_status_code`/`tax_rate_code`/`tax_jurisdiction_code`, not a legacy flat
tax code), and three different approaches were tried against a live invoice
and all failed:
1. A manual `TAX` line with regime/status/rate but no jurisdiction →
   `ZX_TAX_RATE_ID_CODE_MISSING` (rates vary by jurisdiction, so this one's
   expected).
2. The exact same manual `TAX` line, but with jurisdiction/rate/effective-date
   values copied directly from a real, already-succeeded tax line on this org
   → the *same* `ZX_TAX_RATE_ID_CODE_MISSING` error, for a reason not
   identified.
3. `CALC_TAX_DURING_IMPORT_FLAG = 'Y'` on the header with a
   `tax_classification_code` on the `ITEM` line instead (letting Oracle's tax
   engine auto-derive and create the tax line itself, which is how the real
   line's populated `SUMMARY_TAX_LINE_ID` suggests it was actually created) →
   rejected with **no reason logged at all** in `AP_INTERFACE_REJECTIONS`,
   meaning the failure happens below what's visible through data alone.

Diagnosing further needs either the concurrent request's own log file
(permission-denied for the service account used here) or EBS Tax Manager
functional expertise on this instance's Tax Determination rules/Configuration
Owner Tax Options/Party Tax Profiles - none of which are discoverable through
SQL alone. **Recommended workaround:** if the tax amount is already known
(not something Oracle needs to calculate/validate), book it as a normal
GL-coded line - `line_type: "ITEM"` (or a dedicated type your Chart of
Accounts uses for tax liability) pointed at the tax-payable account via
`dist_code_combination_id`/`account` - rather than using `line_type: "TAX"`
at all. This sidesteps the e-Business Tax engine entirely.

**PO-matched lines (`po_line_id`/`po_line_location_id`) are also an
unresolved gap.** `GET /purchase-orders` and `GET /purchase-orders/:id/lines`
work fine for discovery, but actually creating a PO-matched invoice line does
not. Seven different field combinations were tried live across two POs
(Standard and Blanket types), surfacing four distinct errors that did not
converge toward a working combination - later attempts sometimes regressed to
an earlier error:

1. `po_line_id` + `po_line_location_id` (Blanket PO) → `INVALID PO SHIPMENT NUM`
2. Same + `po_shipment_num` → same error
3. Business keys instead (`po_number`+`po_line_number`+`po_shipment_num`,
   Blanket PO) → `INVALID PO RELEASE INFO`
4. Same business keys, Standard PO instead → `INVALID SHIPMENT TYPE` (even
   though the shipment's own `shipment_type` column reads `'STANDARD'`)
5. Same + `po_unit_of_measure` → same error
6. Full internal IDs + business keys combined → `INVALID PO SHIPMENT NUM`
   (regression to attempt 1's error)
7. `po_line_location_id` alone (minimal shape) on the Standard PO → same
   error as 6

One confirmed real finding along the way: `po_number` (`segment1`) is **not**
globally unique - 10 different POs on the reference instance share the same
number, only disambiguated by org/vendor/header id. This likely explains why
the business-key-only attempts kept resolving to unexpected records. Beyond
that, converging on the right field combination needs the same kind of access
the tax-line investigation was blocked on (log file or EBS functional
expertise) - not something resolvable through further blind trial-and-error
against this data alone. Treat PO-matched invoice lines as unsupported until
revisited with better diagnostic access.

All the fields tried above (`po_header_id`, `po_line_number`,
`po_shipment_num`, `po_unit_of_measure`, `unit_price`, plus header-level
`calc_tax_during_import`) are now exposed on `POST /invoices` even though no
working combination has been found - real `AP_INVOICE_LINES_INTERFACE`
columns, so whoever picks this up next can experiment through the API
directly instead of adding fields to the wrapper first.

**A `request_id` can span far more than the one invoice you just staged.**
Oracle's import run sweeps *every* still-eligible pending/rejected interface
row for that org+source together in one pass - including old backlog from
unrelated, previously-failed attempts - and stamps the same `request_id` onto
all of them. Always use `interface_invoice_id` (from the `POST` response) when
checking outcome; relying on `request_id` alone to mean "the row I just
staged" produced real, observed misattribution during testing (a genuinely
successful invoice's `request_id` also covered an old rejected row, and a
naive lookup reported the wrong one's rejection reason). This API's
`GET /invoices/import-status` handles this correctly when given
`interface_invoice_id`; without it, it only reports an outcome when exactly
one interface row matches the `request_id`, rather than guessing.

Separately, **`EBS_IMPORT_SOURCE`** (server-side config, not a request field -
see `node/README.md`) must already exist as a registered value in
`AP_LOOKUP_CODES` (lookup_type `SOURCE`) on the target instance, e.g.
`MANUAL INVOICE ENTRY`, `EDI GATEWAY`. An unregistered source (the shipped
default, `MAKE_API`, is *not* registered anywhere by default) causes the
concurrent request to fail immediately with no per-row rejection logged -
this looks like a submission failure, not a data problem, so it's easy to
mistake for a code bug. Registering a new source name is a one-time EBS setup
step (`FND_LOOKUP_VALUES_PKG.LOAD_ROW`, or the Lookups setup screen under
Application Developer) - it is *not* something this API can or should do for
itself at runtime.

---

## GET /invoices/import-status/:request_id

Poll the concurrent request submitted by `POST /invoices`.

| Query param | Required | Notes |
|-------------|----------|-------|
| `interface_invoice_id` | strongly recommended | The value `POST /invoices` returned alongside `request_id`. Without it, outcome fields are only included when unambiguous (see gotchas above) |

```bash
curl "$BASE_URL/invoices/import-status/8675309?interface_invoice_id=5173458" \
  -H "X-Client-Secret: $CLIENT_SECRET"
```

```json
{
  "request_id": 8675309,
  "phase": "Completed",
  "status": "Normal",
  "phase_code": "C",
  "status_code": "C",
  "interface_status": "PROCESSED",
  "invoice_id": 565060
}
```

`phase`/`status` are decoded from the raw `phase_code`/`status_code` for
convenience - **but they only describe whether the concurrent program itself
ran without crashing, not whether your invoice was created.** Always check the
fields below them too, populated once `phase` is `Completed`:

- **`interface_status`**: `PROCESSED` (the invoice was actually created),
  `REJECTED` (staged but rejected - see `rejection_reasons`), or absent if
  Oracle hasn't picked the row up yet.
- **`invoice_id`**: the real `ap_invoices_all` invoice id, only present when
  `interface_status` is `PROCESSED`. Fetch it with `GET /invoices/:id`.
- **`rejection_reasons`**: an array of Oracle reject codes (e.g.
  `ACCT DATE NOT IN OPEN PD`, `NO SUPPLIER SITE`, `DUPLICATE INVOICE NUMBER`),
  only present when `interface_status` is `REJECTED`.

A bare `status: "Normal"` with none of the above (no `interface_invoice_id`
supplied and more than one interface row shares this `request_id`) means the
outcome genuinely couldn't be resolved unambiguously - not that it succeeded.
Always pass `interface_invoice_id` if you care about the actual result, not
just whether the concurrent program ran.

Unknown request id → `404`.
