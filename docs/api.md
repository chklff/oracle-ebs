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

Every `POST`/`PATCH` body is parsed as JSON **regardless of the request's
`Content-Type` header** - you do not need to set
`Content-Type: application/json` for the server to accept it (though you
still can). This was a deliberate fix after a real integration (a Make.com
HTTP connector) sent a perfectly valid JSON body with no `Content-Type`
header at all (defaulting elsewhere to
`application/x-www-form-urlencoded`); a stock Express app silently drops an
unrecognised Content-Type's body, producing a confusing "no fields
provided"/"required field missing" `400` even though the payload on the wire
was correct. If you ever see that kind of 400 despite a payload that looks
right, check what `Content-Type` your HTTP client actually sent - this server
tolerates it either way, but not every proxy in front of it will.

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
long since closed), filtered down to ones that are actually safe to invoice
against: `closed_code = 'OPEN'`, not cancelled, not consigned, **`approved_flag
= 'Y'`**, and `shipment_type` in `BLANKET`/`SCHEDULED`/`STANDARD`/`PREPAYMENT`.

The `approved_flag` filter matters more than it looks: Payables rejects a
PO-matched line against an *unapproved* shipment with `Invalid PO shipment
number` - an error that reads like a bad ID even when the ID is completely
correct. Confirmed live (see the gotcha under `POST /invoices` below) - this
endpoint used to return unapproved/price-break shipments as if they were
valid candidates, which is exactly what caused that confusing error during
the original PO-matching investigation.

```bash
curl "$BASE_URL/purchase-orders/34071/lines" \
  -H "X-Client-Secret: $CLIENT_SECRET"
```

```json
[
  {
    "po_line_id": 39835,
    "po_line_location_id": 78018,
    "po_release_id": null,
    "line_num": 7,
    "item_description": "Legal Services",
    "unit_price": 450,
    "unit_of_measure": "HRS",
    "match_option": "P",
    "shipment_num": 1,
    "quantity": 159,
    "quantity_received": 0,
    "quantity_billed": 0
  }
]
```

`po_release_id` is non-null when the shipment belongs to a Blanket PO
release. Pass it straight through as `lines[].po_release_id` on
`POST /invoices` in that case - see below.

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
  "description": "Consulting services, June",
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

Note: this does not currently return `cancelled`/`cancelled_date`/`cancelled_amount` -
those only appear in the response of `POST /invoices/:id/cancel` itself. A
cancelled invoice reads back here with `invoice_amount: 0` as the only visible
clue on a plain `GET`.

---

## PATCH /invoices/:id

Update an existing invoice **in place**, synchronously (no Open Interface, no
concurrent program - this is a direct, guarded `UPDATE` against
`ap_invoices_all`).

Oracle has no supported "edit" API for AP invoices analogous to the create-side
Open Interface, and once an invoice is validated/posted/paid its financial
fields (amount, terms, lines) are effectively frozen - the only Oracle-blessed
path for those is cancel + recreate. So this endpoint deliberately only allows
the two things that are safe to change **regardless of status** - confirmed
live against a real, fully paid/posted/validated invoice on this instance:

| Field | Notes |
|-------|-------|
| `description` | string or `null` |
| `custom_fields.attribute_category` / `custom_fields.attribute1-15` | DFF columns, string or `null` - same shape as `GET`/`POST /invoices` |

Only the fields you send are changed - anything omitted is left untouched.
At least one of `description`/`custom_fields` is required.

```bash
curl -X PATCH $BASE_URL/invoices/145330 \
  -H "X-Client-Secret: $CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Corrected description",
    "custom_fields": { "attribute1": "PO-42" }
  }'
```

Returns the refreshed invoice (same shape as `GET /invoices/:id`, including
`lines`).

**Rejected, on purpose:** `invoice_amount`, `terms_id`, `lines`, `vendor_id`,
`vendor_site_id`, `currency_code`, `invoice_date`, `invoice_num`,
`invoice_type` - sending any of these is a `400` explaining that Oracle has no
supported in-place path for them; cancel the invoice in Oracle Payables and
submit a corrected one via `POST /invoices` instead.

| Status | Meaning |
|--------|---------|
| `400` | body has none of the two editable fields, an unknown `custom_fields` key, or a rejected financial field |
| `404` | invoice_id does not exist |
| `409` | invoice is cancelled (`cancelled_date` is not null) |

### Why so narrow (researched, not guessed)

Live inspection of this instance's `ap_invoices_all` found the "status"
columns you'd expect to gate an update on are mostly unusable:
`APPROVAL_STATUS` (validation) is **NULL on 100% of rows** - the real value is
only available from `AP_INVOICES_UTILITY_PKG.GET_APPROVAL_STATUS(...)`, not a
column. `POSTING_STATUS` is similarly unreliable (mostly NULL); real posting
state is `AP_INVOICES_UTILITY_PKG.GET_POSTING_STATUS(invoice_id)` /
`ap_invoice_distributions_all.posted_flag`. Only `payment_status_flag` (Y/N/P)
and `wfapproval_status` are trustworthy stored columns. Most real invoices on
this instance are already validated + posted + paid, i.e. already locked down
for anything financial - so a general in-place amount/terms editor would
mostly 40x anyway. There is no public/documented API package for invoice
update (`AP_INVOICES_PKG.UPDATE_ROW` exists but is a raw 154-argument Forms
table handler, not a supported business API). `AP_CANCEL_PKG` (cancel) *is* a
real, purpose-built package - hence cancel-and-recreate is the recommended
pattern for anything this endpoint rejects.

---

## POST /invoices/:id/cancel

The supported path for anything `PATCH /invoices/:id` rejects (amount/terms/
lines on an invoice that may be validated/posted/paid). Uses Oracle's own
`AP_CANCEL_PKG` - not direct SQL - via `IS_INVOICE_CANCELLABLE` (pre-check)
then `AP_CANCEL_SINGLE_INVOICE` (the real cancel). Synchronous, no Open
Interface, no concurrent program.

**This is not reversible.** Oracle has no "un-cancel". A successful cancel
zeroes `invoice_amount` and stamps `cancelled_amount`/`cancelled_date`
permanently. The follow-up corrected invoice is a separate `POST /invoices`
call - this endpoint only cancels, it never creates a replacement.

```bash
curl -X POST $BASE_URL/invoices/191133/cancel \
  -H "X-Client-Secret: $CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{ "accounting_date": "2016-12-15" }'
```

| Field | Required | Notes |
|-------|----------|-------|
| `accounting_date` | no | `YYYY-MM-DD`. **Must fall in an open GL period for the invoice's ledger** - defaults to today if omitted, which fails on most Vision demo orgs since their ledgers only have periods open years in the past (e.g. org 1017 "Vision Italy" only through Dec 2010; org 458 "Vision Services" through Dec 2016). Check `gl_period_statuses` for the real org before assuming today works. |

Returns the invoice (same shape as `GET /invoices/:id`) plus:

```json
{
  "invoice_amount": 0,
  "cancelled": true,
  "cancelled_amount": 100,
  "cancelled_date": "2026-07-20"
}
```

| Status | Meaning |
|--------|---------|
| `404` | invoice_id does not exist |
| `409` | invoice is already cancelled |
| `422` | Oracle says not cancellable (`details` has the real reason from `IS_INVOICE_CANCELLABLE`'s `debug_info` - `error_code` is frequently null even on failure, confirmed live, so this endpoint falls back to `debug_info` for something actionable), OR the cancel call itself failed (`details` has `AP_CANCEL_SINGLE_INVOICE`'s message, OR - confirmed live against a real invoice - a raw unhandled Oracle exception like `ORA-20001: ... Error encountered while synchronizing tax distributions ... Generate APLIST for this invoice and log a Service Request`, which is a genuine Oracle-side data/tax-engine issue with that specific invoice, not fixable from this API) |

### Gotchas (found the hard way, against a real instance)

- `IS_INVOICE_CANCELLABLE` requires the same Apps session context
  (`FND_GLOBAL.APPS_INITIALIZE` + `MO_GLOBAL.SET_POLICY_CONTEXT`) as the
  actual cancel call. Without it, it fails closed and reports **every**
  invoice as not cancellable with a generic reason, regardless of the
  invoice's real state - confirmed live on this instance.
- Some orgs' invoices (e.g. org 1017 "Vision Italy") hit a real Oracle
  e-Business Tax engine bug during cancellation (`ORA-20001` tax
  distribution sync failure) - consistent with this instance's already-known
  tax engine issues (see `POST /invoices` gotchas). Not every cancellable
  invoice can actually be cancelled; try a different org/invoice if you hit
  this.
- `accounting_date` must be a plain `YYYY-MM-DD` string. If you're building
  the request body in a low-code tool (e.g. Make), watch out for `date`-typed
  fields handing over a full ISO timestamp (`2016-12-15T00:00:00.000Z`)
  instead - format/truncate it before sending.

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
| `lines[].dist_code_combination_id` or `lines[].account` (GL-coded), **or** `lines[].po_line_location_id` + `lines[].quantity_invoiced` (PO-matched) | yes (exactly one shape) | per line - mutually exclusive. PO-matched works end-to-end. `po_line_location_id` alone is enough - Oracle derives `po_header_id`/`po_line_id` itself from the shipment, confirmed live - except see `po_release_id` below |
| `terms_id` | no | nullable |
| `description` | no | nullable |
| `custom_fields.*` (attribute1-15, attribute_category) | no | nullable |
| `lines[].line_type` | no | defaults to `ITEM`. `TAX` exists structurally but see the unresolved gap below before relying on it |
| `lines[].tax_regime_code`, `lines[].tax_status_code`, `lines[].tax_rate_code`, `lines[].tax_jurisdiction_code`, `lines[].tax_classification_code` | no | Only meaningful on a `TAX` line (e-Business Tax engine) - see the unresolved gap below |
| `lines[].po_header_id`, `lines[].po_line_id`, `lines[].po_line_number`, `lines[].po_shipment_num`, `lines[].po_unit_of_measure`, `lines[].unit_price` | no | Not required - Oracle derives all of these from `po_line_location_id`. Accepted as real `AP_INVOICE_LINES_INTERFACE` columns if you already have them, but there's no need to look them up just for this |
| `lines[].po_release_id` | conditional | **Required** alongside `po_line_location_id` whenever that shipment belongs to a Blanket PO release (i.e. `GET /purchase-orders/:po_header_id/lines` returned a non-null `po_release_id` for it) - omitting it gets rejected with `RELEASE MISSING`. Confirmed live, see the gotcha below |
| `invoice_type` | no | defaults to `STANDARD`. See below - **not** every value works with just `vendor_id`/`vendor_site_id` |
| `calc_tax_during_import` | no | boolean, maps to `calc_tax_during_import_flag`. Untested end-to-end - see the tax gotcha below |

**`invoice_type`** maps to `invoice_type_lookup_code`, not validated against a
hardcoded enum here (same approach as `currency_code` - Oracle's own
`AP_LOOKUP_CODES`, lookup_type `INVOICE TYPE`, is the source of truth).
Verified working with normal `vendor_id`/`vendor_site_id`: `STANDARD`
(default), `CREDIT`, and `DEBIT`. `MIXED`/`PREPAYMENT`/etc. are presumed to
work the same way but untested.

**`CREDIT` and `DEBIT` require a negative `invoice_amount` and negative
`lines[].amount` - confirmed live.** A positive amount with `invoice_type:
"DEBIT"` is rejected outright with `INCONSISTENT INV TYPE/AMT`; the same is
true for `CREDIT`. This is fixed Oracle Payables behavior, not a per-instance
quirk. This API itself does **not** normalise the sign (it stays a thin
pass-through) - if you want callers to enter a plain positive number for a
credit/debit memo, negate it on the client side (e.g. in the Make module's
`buildInvoiceBody`) before sending.

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

Each line is GL-coded (`dist_code_combination_id`, numeric code combination
id, or `account`, a concatenated account string mapped to
`dist_code_concatenated`), PO-matched (`po_line_location_id` +
`quantity_invoiced` - see below), or a `TAX` line (unresolved, see the
gotchas below) - exactly one shape, or `400`.

### Optional fields not shown in the example above

**PO-matched lines - confirmed working end-to-end:**

```json
{
  "org_id": 204,
  "invoice_num": "INV-1002",
  "invoice_date": "2026-07-01",
  "vendor_id": 2,
  "vendor_site_id": 2,
  "invoice_amount": 450.00,
  "currency_code": "USD",
  "lines": [
    {
      "amount": 450.00,
      "po_line_location_id": 78018,
      "quantity_invoiced": 1
    }
  ]
}
```

`po_line_location_id` + `quantity_invoiced` is the whole shape needed for a
plain PO shipment - Oracle derives `po_header_id`/`po_line_id`/GL coding
itself. Get `po_line_location_id` from
`GET /purchase-orders/:po_header_id/lines`. Add `po_release_id` (also
returned by that endpoint) only when it's non-null for that shipment - see
the gotchas below. `po_line_id`/`po_header_id`/`po_line_number`/
`po_shipment_num`/`po_unit_of_measure`/`unit_price` are accepted but not
required.

**`CREDIT`/`DEBIT` - confirmed working, but the amount sign matters:**

```json
{
  "org_id": 204,
  "invoice_num": "INV-1003",
  "invoice_date": "2026-07-01",
  "vendor_id": 2,
  "vendor_site_id": 2,
  "invoice_amount": -50.00,
  "currency_code": "USD",
  "invoice_type": "CREDIT",
  "lines": [{ "amount": -50.00, "dist_code_combination_id": 12975 }]
}
```

See the `invoice_type` note above the example - both header and line amounts
must be negative, or Oracle rejects it with `INCONSISTENT INV TYPE/AMT`.

**Still unresolved/experimental (see the gotchas below before relying on
these):**

- `calc_tax_during_import` - untested end-to-end.
- `TAX`-type lines - do not work, see below. Use the documented workaround
  instead.

A `TAX`-type line looks like this (still rejected by Oracle - do not use,
see the gotcha below for why and the recommended workaround):

```json
{
  "amount": 42.50,
  "line_type": "TAX",
  "tax_regime_code": "US-SALES-TAX-101",
  "tax_status_code": "STANDARD",
  "tax_rate_code": "STANDARD",
  "tax_jurisdiction_code": "CI-NY-NEW YORK-121661",
  "tax_classification_code": "STD"
}
```

(Note: a `TAX` line cannot also carry `dist_code_combination_id`/`account`/
`po_line_location_id` - `POST /invoices` rejects a line that's more than one
of GL-coded/PO-matched/TAX at once.)

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

**`TAX`-type lines are a confirmed, unresolved gap - don't rely on them.**
This instance uses Oracle's modern e-Business Tax engine (`tax_regime_code`/
`tax_status_code`/`tax_rate_code`/`tax_jurisdiction_code`, not a legacy flat
tax code). Six different approaches were tried live across two sessions and
none succeeded:
1. A manual `TAX` line with regime/status/rate but no jurisdiction →
   `ZX_TAX_RATE_ID_CODE_MISSING` (rates vary by jurisdiction, so this one's
   expected).
2. The exact same manual `TAX` line, but with jurisdiction/rate/effective-date
   values copied directly from a real, already-succeeded tax line on this org
   → the *same* `ZX_TAX_RATE_ID_CODE_MISSING` error.
3. `CALC_TAX_DURING_IMPORT_FLAG = 'Y'` on the header with a
   `tax_classification_code` on the `ITEM` line instead (letting Oracle's tax
   engine auto-derive and create the tax line itself) → rejected with **no
   reason logged at all** in `AP_INTERFACE_REJECTIONS`.
4. Same as #2, but this time verified live that the copied rate
   (`tax_rate_id`) is genuinely valid, unambiguous, and effective-dated to
   cover the invoice date (checked `zx_rates_b` directly) → still the same
   `ZX_TAX_RATE_ID_CODE_MISSING`.
5. Populating the raw `tax_rate_id` directly on the interface line instead of
   the code fields → a *different* error this time: `INSUFFICIENT TAX INFO`
   ("Tax Classification Code or Tax Rate Code is mandatory for manual tax
   lines").
6. `tax_rate_id` **and** all four code fields together (the exact values from
   attempt 4) → regressed back to attempt 1/2/4's `ZX_TAX_RATE_ID_CODE_MISSING`.

The technique that resolved the PO-matching gap (reading the concurrent
request's actual output report on the app tier, not just
`AP_INTERFACE_REJECTIONS`) was tried here too and did **not** help - Oracle's
e-Business Tax engine doesn't log more detail into that report than the short
rejection code, unlike Purchasing. Combined with attempt 6's regression
(adding more, individually-correct fields made it fail the *same* way as
having fewer), this isn't a missing-field problem solvable by more
trial-and-error against this data. Diagnosing further genuinely needs EBS Tax
Manager functional expertise on this instance's Tax Determination rules/
Configuration Owner Tax Options/Party Tax Profiles - not discoverable through
SQL or logs alone. **Recommended workaround:** if the tax amount is already
known (not something Oracle needs to calculate/validate), book it as a normal
GL-coded line - `line_type: "ITEM"` (or a dedicated type your Chart of
Accounts uses for tax liability) pointed at the tax-payable account via
`dist_code_combination_id`/`account` - rather than using `line_type: "TAX"`
at all. This sidesteps the e-Business Tax engine entirely.

**PO-matched lines (`po_line_location_id`) now work
end-to-end - the fix was in the discovery data, not the code.** Seven
attempts originally failed live across two POs, surfacing four distinct
errors (`INVALID PO SHIPMENT NUM`, `INVALID PO RELEASE INFO`, `INVALID
SHIPMENT TYPE`) that never converged. Reading the actual concurrent request
log (`o<request_id>.txt` under the conc/out directory - not just
`AP_INTERFACE_REJECTIONS`, which only stores the short lookup code) plus the
underlying `po_line_locations_all` rows for the shipments used in each
attempt explained all four:

- Two of the test POs' shipments had `approved_flag` = `N` or `null` -
  Payables rejects an unapproved shipment with `Invalid PO shipment number`,
  which reads exactly like a bad ID even though the ID was correct.
- One test PO's shipments were `shipment_type = 'PRICE BREAK'` (a Blanket
  PO's own price-break tiers, not an invoiceable shipment) - invalid
  regardless of approval status.
- The business-key attempts (`po_number`+`po_line_number`+`po_shipment_num`)
  landed on the wrong PO or the wrong shipment, because `po_number`
  (`segment1`) is **not globally unique** - 10 different POs on the reference
  instance share the same number.
- The Blanket-PO business-key attempt additionally needed `po_release_id` -
  a column that wasn't exposed by this API at all until now. A shipment that
  belongs to a Blanket PO release (`po_line_locations_all.po_release_id` not
  null) can't be matched by `po_line_location_id` alone.

None of this was a validation or field-mapping bug in this API - every
attempt above would have succeeded against a genuinely approved, non-release
shipment. `GET /purchase-orders/:po_header_id/lines` has been fixed to filter
out exactly the traps above (`approved_flag = 'Y'`, `shipment_type` in the
valid set) so a caller following that endpoint's output won't hit them again,
and now returns `po_release_id` so release-based shipments are visible.

Confirmed live with three real invoices:

- **Plain Standard PO shipment** (no release), full shape: `po_line_id: 39835,
  po_line_location_id: 78018, quantity_invoiced: 1, unit_price: 450,
  po_unit_of_measure: "HRS"` → `interface_status: "PROCESSED"`,
  `match_type: "ITEM_TO_PO"`, GL coding auto-derived from the PO as expected.
- **Same shipment, minimal shape**: `po_line_location_id: 78018,
  quantity_invoiced: 1` - nothing else - also `PROCESSED`, with
  `po_header_id`/`po_line_id` correctly auto-derived by Oracle from the
  shipment alone. `po_line_id` and the rest of the "additional PO-matching
  fields" are genuinely optional, not just under-tested.
- **Blanket PO release shipment**: `po_line_location_id` + `po_release_id:
  2868` (taken from `GET /purchase-orders/:po_header_id/lines`'s
  `po_release_id` for that shipment) → also `PROCESSED`. Omitting
  `po_release_id` on this same shipment gets rejected with `RELEASE MISSING`
  - this is the one field that's genuinely required beyond
  `po_line_location_id`, and only for release-based shipments.

The only remaining real-world consideration if this gets picked up further:
2-way vs 3-way match handling and partial-invoicing/remaining-quantity
tracking across multiple invoices against the same PO line - not tested,
since the mechanics of a single successful match are now proven.

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
