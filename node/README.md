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

## Configuring after installation

Once the code is deployed on the host (for example under `/home/opc/rest-api`),
configure it like this. The app reads everything from a `.env` file next to
`package.json`; `.env` is never committed.

1. **Create your `.env` from the template:**

   ```bash
   cp .env.example .env
   ```

2. **Generate and set the client secret** (the value callers send as
   `X-Client-Secret`):

   ```bash
   openssl rand -hex 32        # copy the output into CLIENT_SECRET
   ```

3. **Set the database connection** using the low-privilege account created from
   [`docs/db-grants.sql`](../docs/db-grants.sql):

   ```dotenv
   EBS_DB_USER=make_ap_svc
   EBS_DB_PASSWORD=<the password the DBA set>
   EBS_DB_CONNECT_STRING=<db-host>:1521/<db-service-name>
   ```

   `EBS_DB_CONNECT_STRING` is the **database** Easy Connect string
   (`host:port/service_name`), not the EBS application URL. Ask your DBA for the
   service name (e.g. `EBSPDB`, `PROD`). Thin mode connects straight over TCP —
   no Oracle client install needed.

4. **(Optional) Tune** pool size (`EBS_POOL_*`), paging limits
   (`DEFAULT_QUERY_LIMIT`, `MAX_QUERY_LIMIT`), `HOST`/`PORT`, and `LOG_LEVEL`.
   The defaults are fine for most deployments.

5. **(Only if you enable `POST /invoices`)** fill in the import settings —
   `EBS_IMPORT_SOURCE`, `EBS_IMPORT_PROGRAM_APP`/`_SHORT`, and the apps-context
   IDs (`EBS_APPS_USER_ID`, `EBS_APPS_RESP_ID`, `EBS_APPS_RESP_APPL_ID`). These
   are instance-specific; confirm them with your DBA. If you only expose the read
   endpoints, leave these as-is.

6. **Verify the config loads** and the DB is reachable:

   ```bash
   node -e "require('dotenv').config(); require('./src/config').loadConfig(); console.log('config OK')"
   npm start &                 # then, from the same host:
   curl -s http://127.0.0.1:3000/health
   # -> {"status":"ok","db":"connected"}
   ```

   `"db":"error"` means the credentials or connect string are wrong, or the DB
   host/port is not reachable from this machine.

7. **Restart the service** after any `.env` change (env is read once at startup):

   ```bash
   pm2 restart ebs-invoice-api      # or: systemctl restart <your-unit>
   ```

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
