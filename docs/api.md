# API Reference

Base URL depends on where you deploy it (default `http://127.0.0.1:3000`).

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
curl http://127.0.0.1:3000/health
```

```json
{ "status": "ok", "db": "connected" }
```

`db` is `"error"` if a pooled connection cannot be obtained.

---

## GET /orgs

List operating units so a caller can discover valid `org_id` values.

```bash
curl http://127.0.0.1:3000/orgs \
  -H "X-Client-Secret: $CLIENT_SECRET"
```

```json
[
  { "org_id": 101, "name": "US Operations" },
  { "org_id": 204, "name": "Germany GmbH" }
]
```

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
curl "http://127.0.0.1:3000/invoices?org_id=101&date_from=2026-06-01&limit=50" \
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

## GET /invoices/:id

One invoice plus its lines. `org_id` is not required (`invoice_id` is globally
unique); the invoice's own `org_id` is echoed back.

```bash
curl http://127.0.0.1:3000/invoices/12345 \
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

```bash
curl -X POST http://127.0.0.1:3000/invoices \
  -H "X-Client-Secret: $CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "org_id": 101,
    "invoice_num": "INV-1001",
    "invoice_date": "2026-07-01",
    "vendor_id": 987,
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
{ "status": "submitted", "request_id": 8675309 }
```

Each line requires either `dist_code_combination_id` (numeric code combination
id) or `account` (a concatenated account string, mapped to
`dist_code_concatenated`). Missing required fields → `400`.

---

## GET /invoices/import-status/:request_id

Poll the concurrent request submitted by `POST /invoices`.

```bash
curl http://127.0.0.1:3000/invoices/import-status/8675309 \
  -H "X-Client-Secret: $CLIENT_SECRET"
```

```json
{
  "request_id": 8675309,
  "phase": "Completed",
  "status": "Normal",
  "phase_code": "C",
  "status_code": "C"
}
```

`phase`/`status` are decoded from the raw `phase_code`/`status_code` for
convenience. Poll until `phase` is `Completed`; `status` `Normal` means success,
`Error`/`Warning` means the import rejected or flagged rows (inspect them in
EBS). Unknown request id → `404`.
