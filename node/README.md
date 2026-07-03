# ebs-invoice-api-node

Node.js + Express implementation of the EBS Invoice API Wrapper. Connects to
Oracle E-Business Suite with the `oracledb` driver in **Thin mode** (no Oracle
Instant Client required) and exposes a small, fixed set of Payables invoice
endpoints.

See the repository [root README](../README.md) for the big picture and
[`docs/api.md`](../docs/api.md) for the full request/response reference.

## Requirements

- Node.js 18 or newer.
- Network access from this host to the EBS database listener.
- A dedicated low-privilege DB account created by a DBA using
  [`docs/db-grants.sql`](../docs/db-grants.sql).

Thin mode talks to Oracle directly over TCP, so you do **not** need to install
Instant Client or set `LD_LIBRARY_PATH`.

## Architecture

```
src/
├── server.js                 bootstrap: load config, open pool, listen, graceful shutdown
├── app.js                    Express wiring: json, logging, auth gate, routes, errors
├── config.js                 env -> validated config (fails fast if incomplete)
├── logger.js                 pino structured logger (secret redacted)
├── db.js                     oracledb pool + withConnection() helper + healthCheck()
├── errors.js                 ApiError + badRequest/unauthorized/notFound
├── middleware/
│   ├── auth.js               X-Client-Secret gate (constant-time compare)
│   └── errorHandler.js       ApiError -> JSON; everything else -> generic 500
├── routes/                   one file per resource (health, orgs, invoices)
├── repositories/             all SQL lives here, bind variables only
│   ├── orgRepository.js
│   ├── invoiceRepository.js
│   └── importRepository.js
└── util/validation.js        small input parsers/validators
```

The **routes** parse and validate input, then borrow a pooled connection via
`db.withConnection()` and delegate to a **repository**. Repositories own every
SQL statement; routes never build SQL. This keeps the "no arbitrary SQL" rule
easy to audit — grep `repositories/` and you can see every statement the service
can run.

## Configuration

Copy `.env.example` to `.env` and fill it in. `.env` is gitignored.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `CLIENT_SECRET` | ✅ | — | Value clients must send as `X-Client-Secret` |
| `EBS_DB_USER` | ✅ | — | Service DB user (e.g. `make_ap_svc`) |
| `EBS_DB_PASSWORD` | ✅ | — | Service DB password |
| `EBS_DB_CONNECT_STRING` | ✅ | — | Easy Connect `host:port/service` |
| `HOST` | | `127.0.0.1` | Bind address (keep on loopback) |
| `PORT` | | `3000` | Listen port |
| `LOG_LEVEL` | | `info` | pino level (`info`, `debug`, `silent`, …) |
| `EBS_POOL_MIN` | | `1` | Pool minimum connections |
| `EBS_POOL_MAX` | | `4` | Pool maximum connections |
| `EBS_POOL_INCREMENT` | | `1` | Pool growth step |
| `EBS_POOL_TIMEOUT` | | `60` | Seconds idle before a connection is dropped |
| `EBS_QUEUE_TIMEOUT` | | `60000` | ms to wait for a free connection |
| `DEFAULT_QUERY_LIMIT` | | `50` | Default page size for `GET /invoices` |
| `MAX_QUERY_LIMIT` | | `500` | Hard cap on page size |
| `EBS_IMPORT_PROGRAM_APP` | POST only | `SQLAP` | Concurrent program application short name |
| `EBS_IMPORT_PROGRAM_SHORT` | POST only | `APXIIMPT` | Import program short name |
| `EBS_IMPORT_SOURCE` | POST only | `MAKE_API` | Payables `Source` the import filters on |
| `EBS_APPS_USER_ID` | POST only | — | User id for `FND_GLOBAL.APPS_INITIALIZE` |
| `EBS_APPS_RESP_ID` | POST only | — | Responsibility id for apps init |
| `EBS_APPS_RESP_APPL_ID` | POST only | — | Responsibility application id |

## Database setup

A DBA runs [`docs/db-grants.sql`](../docs/db-grants.sql) once. It creates
`make_ap_svc` and grants only what the endpoints use — read on the invoice/
supplier/operating-unit objects, insert on the interface tables, and execute on
the concurrent-request packages. Object owners (`AP`, `APPS`, `HR`) vary by
instance; verify them before running.

## Running

Install dependencies:

```bash
npm install
```

Development (auto-restart on file change, using Node's built-in watcher — no
nodemon/dev server):

```bash
npm run dev
```

Production — run under a process manager such as `pm2` or a systemd unit:

```bash
npm start
# or
pm2 start src/server.js --name ebs-invoice-api
```

The service binds to `127.0.0.1:3000` by default. Put it behind your firewall/
reverse proxy; do not bind it to `0.0.0.0` unless the network is already
restricted.

## Testing

Tests mock the `db` module, so **no Oracle instance is needed**:

```bash
npm test
```

They cover auth, validation, row→JSON mapping, paging limits, 404s, and the
POST → import-status flow for every endpoint.

## The asynchronous POST flow

`POST /invoices` does not create an invoice synchronously. It:

1. inserts the header + lines into `ap_invoices_interface` /
   `ap_invoice_lines_interface` (with `ORG_ID` set), then
2. submits the **Payables Open Interface Import** concurrent program for that
   operating unit and returns its `request_id`.

Poll `GET /invoices/import-status/:request_id` until `phase` is `Completed`.
A `status` of `Normal` means success; `Error`/`Warning` means EBS rejected or
flagged rows — inspect them in Payables.

> **Instance-specific bits to confirm with a DBA before enabling POST:** the
> program's argument list/positions, the `Source` lookup value, and the
> user/responsibility IDs used by `FND_GLOBAL.APPS_INITIALIZE`. These differ
> between EBS installations. The read endpoints have no such dependency.

## curl examples

See [`docs/api.md`](../docs/api.md) for a copy-pasteable example of every
endpoint.
