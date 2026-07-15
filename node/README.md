# ebs-invoice-api-node

A small web service that lets other software **read and create Accounts Payable
(AP) invoices in Oracle E-Business Suite (EBS)** over a simple, secure HTTP/JSON
API — without giving that software direct database access.

This is the Node.js implementation. If you just want to get it running, follow
**[Setup — step by step](#setup--step-by-step)** below. You do not need to be an
Oracle expert.

---

## What this is, in plain language

- EBS stores invoices in an Oracle database. Talking to that database directly
  from an automation tool (Make.com, a script, another app) is awkward and
  risky.
- This service sits **in front of** the database, on a machine inside your
  network. It connects to EBS as **one dedicated, low-privilege database user**
  and exposes a handful of fixed, safe endpoints like `GET /invoices` and
  `POST /invoices`.
- Callers talk plain HTTP/JSON and prove who they are with a single shared
  password (the `X-Client-Secret` header). They never see the database.

There is **no "run any SQL" endpoint**. Every endpoint maps to one fixed,
pre-written query — so it is easy to audit and hard to misuse.

## How it works (the flow)

```
   Caller (Make.com / script)                 This service                     Oracle EBS DB
   ---------------------------                 ------------                     -------------
   GET /invoices?org_id=204   ─── HTTPS ──▶   check secret
     header: X-Client-Secret                  run ONE fixed query  ─── SQL ──▶  ap_invoices_all
                              ◀── JSON ─────   shape rows to JSON   ◀── rows ──  (+ ap_suppliers)
```

- **Reads** (`GET`) run a fixed query and return JSON.
- **Creating an invoice** (`POST`) is **asynchronous**: the service stages the
  invoice into EBS's standard import tables and launches EBS's "Payables Open
  Interface Import" job, then returns a `request_id` you can poll. (See
  [Creating invoices](#creating-invoices-the-post-flow).)

## What you need before you start

| # | Requirement | Notes |
|---|-------------|-------|
| 1 | A host to run this on | Small Linux VM or Windows machine **inside your network**, able to reach the EBS database. Node.js 18+ installed. |
| 2 | A database account | A dedicated low-privilege Oracle user. Your DBA creates it once (see step 2). |
| 3 | The DB connection details | Host, port (usually `1521`), and the **service name**. Ask your DBA. |
| 4 | To know if the DB requires encryption | Determines Thin vs Thick mode (step 6). If you don't know, that's fine — the setup tells you exactly what to do. |

> **The service runs on a host you control, not on the Oracle database server.**
> It only needs a network path to the database.

---

## Setup — step by step

### 1. Get the code and install dependencies

```bash
cd node
npm install
```

### 2. Create the database account (your DBA does this once)

Hand your DBA [`docs/db-grants.sql`](../docs/db-grants.sql). It creates a
dedicated user (default name `make_ap_svc`) and grants **only** what the
endpoints use — nothing more. No DBA/superuser account is ever used by this
service.

Ask the DBA to give you back:
- the **username and password** of that account, and
- the database **connect string**: `host:port/service_name`
  (e.g. `db.example.com:1521/EBSPROD`). This is the *database* service name, not
  the EBS website address.

### 3. Create your configuration file

```bash
cp .env.example .env
```

`.env` holds all settings and is **never committed to git**. Open it in an
editor for the next steps.

### 4. Set the client secret

This is the password callers must send in the `X-Client-Secret` header. Generate
a strong random one:

```bash
openssl rand -hex 32
```

Put it in `.env`:

```dotenv
CLIENT_SECRET=<paste the generated value>
```

### 5. Set the database connection

Use the account and connect string from step 2:

```dotenv
EBS_DB_USER=make_ap_svc
EBS_DB_PASSWORD=<password the DBA gave you>
EBS_DB_CONNECT_STRING=db.example.com:1521/EBSPROD
```

### 6. Choose the driver mode (Thin or Thick)

Oracle can require connections to be **encrypted** (a feature called *Native
Network Encryption*). This decides how you connect:

> **Does your Oracle database require encrypted connections?**
> - **No, or you don't know** → start with **Thin mode**. Nothing to install.
>   Leave `EBS_DB_THICK=false`. Continue to step 7.
> - **Yes** (or you later hit error `ORA-12660` / `NJS-533`) → use **Thick
>   mode**. Two commands, no database changes — see below.

**Enabling Thick mode** (only if needed). Download the small Oracle client
libraries into the app folder — no admin rights, nothing installed system-wide:

```bash
# Linux / macOS:
npm run fetch-client

# Windows (PowerShell):
npm run fetch-client:win
```

It prints two lines; put them in `.env`:

```dotenv
EBS_DB_THICK=true
EBS_CLIENT_LIB_DIR=/absolute/path/to/node/vendor/instantclient
```

That's it — the database is **not** changed in any way. (Licensing: these Oracle
libraries are free and redistributable; they are downloaded at deploy time and
never stored in this repository.)

### 7. Start the service

```bash
npm start
```

That's it — on every OS and in both Thin and Thick mode. In Thick mode on
Linux/macOS the app automatically re-launches itself with the correct library
path, so you don't need any special command. The service listens on
`127.0.0.1:3000` by default (controlled by `HOST`/`PORT` in `.env`) — that's
just the bind address on the machine running the process, not necessarily
where external callers reach it (there's often an SSH tunnel, reverse proxy,
or load balancer in front, with its own hostname/port). See
[`docs/api.md`](../docs/api.md) for the `$BASE_URL` convention used in the
full API reference.

### 8. Verify it works

Run these on the same machine you just started the service on:

```bash
# 1) Is it alive and connected to the DB? (no secret needed)
curl -s http://127.0.0.1:3000/health
# expect: {"status":"ok","db":"connected"}

# 2) List operating units (use your real CLIENT_SECRET)
curl -s -H "X-Client-Secret: <your secret>" http://127.0.0.1:3000/orgs

# 3) List invoices for one operating unit (use an org_id from step 2's output)
curl -s -H "X-Client-Secret: <your secret>" \
  "http://127.0.0.1:3000/invoices?org_id=204&limit=5"
```

If `/health` shows `"db":"error"`, jump to [Troubleshooting](#troubleshooting).

### 9. Keep it running (production)

Run it under a process manager so it restarts on reboot/crash, and so you can
check status and logs with one command. With
[pm2](https://pm2.keymetrics.io/):

```bash
pm2 start npm --name ebs-invoice-api -- start   # works in Thin or Thick mode
pm2 save                                        # remember it across restarts
pm2 startup                                      # (optional) start on boot — prints a sudo command to run
```

Then: `pm2 status` (is it running?), `pm2 logs ebs-invoice-api` (live logs),
`pm2 restart ebs-invoice-api` (after a `.env` change).

Keep it bound to `127.0.0.1` and place it behind your firewall/reverse proxy.
Do **not** expose it on `0.0.0.0` unless the network is already restricted.

> The service reads `.env` once at startup. **Restart it after any `.env`
> change.**

---

## API endpoints

| Method & path | Auth | What it does |
|---------------|------|--------------|
| `GET /health` | none | Liveness + database connectivity |
| `GET /orgs` | secret | List operating units (to discover valid `org_id`) |
| `GET /vendors?org_id=…` | secret | List suppliers usable in an operating unit (to discover valid `vendor_id`) |
| `GET /vendor-sites?org_id=…&vendor_id=…` | secret | List a supplier's sites (to discover valid `vendor_site_id`, required by `POST /invoices`) |
| `GET /terms` | secret | List payment terms (to discover valid `terms_id`) |
| `GET /currencies` | secret | List enabled currencies (to discover valid `currency_code`) |
| `GET /purchase-orders?org_id=…&vendor_id=…` | secret | List open POs for a vendor (to discover valid `po_header_id`, for PO-matched lines) |
| `GET /purchase-orders/:po_header_id/lines` | secret | List a PO's invoiceable shipments (to discover valid `po_line_location_id`/`po_release_id`) |
| `GET /invoices?org_id=…` | secret | Paginated invoice list for one operating unit |
| `GET /invoices/:id` | secret | One invoice + its lines |
| `GET /invoices/dff-schema` | secret | Column → label metadata for `custom_fields` (attribute1-15), per context |
| `POST /invoices` | secret | Stage an invoice + launch the import job |
| `GET /invoices/import-status/:request_id?interface_invoice_id=` | secret | Poll the import job — pass `interface_invoice_id` for an unambiguous result |

Full request/response examples for every endpoint are in
**[`docs/api.md`](../docs/api.md)**.

### About `org_id` (operating units)

EBS holds many business units in one database. Every invoice belongs to an
**operating unit**, identified by a number (`org_id`). Call `GET /orgs` to see
the available ones, then pass `org_id` when listing or creating invoices. (More
background in [`docs/tech-spec.md`](../docs/tech-spec.md).)

---

## Configuration reference

Everything is set in `.env`. Only the first four are required.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `CLIENT_SECRET` | ✅ | — | Value callers must send as `X-Client-Secret` |
| `EBS_DB_USER` | ✅ | — | Service DB user (e.g. `make_ap_svc`) |
| `EBS_DB_PASSWORD` | ✅ | — | Service DB password |
| `EBS_DB_CONNECT_STRING` | ✅ | — | Easy Connect `host:port/service_name` |
| `EBS_DB_THICK` | | `false` | `true` for databases that enforce encryption (step 6) |
| `EBS_CLIENT_LIB_DIR` | | — | Path to Oracle Instant Client (Thick mode) |
| `HOST` | | `127.0.0.1` | Bind address — keep on loopback |
| `PORT` | | `3000` | Listen port |
| `LOG_LEVEL` | | `info` | Log level: `info`, `debug`, `warn`, `error`, `silent` |
| `EBS_POOL_MIN` | | `1` | Connection pool minimum |
| `EBS_POOL_MAX` | | `4` | Connection pool maximum |
| `EBS_POOL_INCREMENT` | | `1` | Pool growth step |
| `EBS_POOL_TIMEOUT` | | `60` | Seconds before an idle connection is dropped |
| `EBS_QUEUE_TIMEOUT` | | `60000` | ms to wait for a free connection |
| `DEFAULT_QUERY_LIMIT` | | `50` | Default page size for `GET /invoices` |
| `MAX_QUERY_LIMIT` | | `500` | Maximum allowed page size |
| `EBS_IMPORT_SOURCE` | POST only\* | `MAKE_API` | Payables `Source` value the import filters on — **must already be registered** in `AP_LOOKUP_CODES` (lookup_type `SOURCE`) on the target instance. The default, `MAKE_API`, is not registered anywhere out of the box; either register it (see below) or point this at an existing value like `MANUAL INVOICE ENTRY` |
| `EBS_IMPORT_BATCH_NAME` | POST only | `N/A` | Payables `Batch Name` SRS parameter — required by the concurrent program even when invoice batch controls are off. `N/A` is the value Oracle Forms itself resolves to by default; only change this if `AP_USE_INV_BATCH_CONTROLS` is `Y` on your instance |
| `EBS_IMPORT_PROGRAM_APP` | POST only | `SQLAP` | Concurrent program application short name |
| `EBS_IMPORT_PROGRAM_SHORT` | POST only | `APXIIMPT` | Import program short name |
| `EBS_APPS_USER_ID` | POST only\* | — | User id for `FND_GLOBAL.APPS_INITIALIZE` |
| `EBS_APPS_RESP_ID` | POST only\* | — | Responsibility id for apps init |
| `EBS_APPS_RESP_APPL_ID` | POST only\* | — | Responsibility application id |

\* Marked "POST only" but not actually optional if you use POST: leaving
`EBS_APPS_USER_ID`/`EBS_APPS_RESP_ID`/`EBS_APPS_RESP_APPL_ID` unset does **not**
fail startup or the request — `FND_GLOBAL.APPS_INITIALIZE(NULL, NULL, NULL)`
runs "successfully" but `FND_REQUEST.SUBMIT_REQUEST` then silently fails and
returns `request_id: 0`, while the API still responds `202 submitted`. Always
confirm a POST actually returned a real (non-zero) `request_id` when setting
this up for a new instance.

---

## Creating invoices (the POST flow)

`POST /invoices` does **not** create the invoice instantly. It mirrors how EBS
itself imports invoices:

1. It inserts the header + lines into EBS's standard interface tables
   (`ap_invoices_interface`, `ap_invoice_lines_interface`) with the `org_id` set.
2. It launches the **Payables Open Interface Import** concurrent program and
   returns `{ request_id, interface_invoice_id }`.
3. You poll `GET /invoices/import-status/:request_id?interface_invoice_id=`
   (pass both) until `phase` is `Completed`, then check `interface_status`:
   `PROCESSED` = success (`invoice_id` is the real invoice), `REJECTED` =
   check `rejection_reasons`.

**Always pass `interface_invoice_id`.** Oracle's import run sweeps *every*
pending/rejected interface row for that org+source together, not just the one
you just staged - `request_id` by itself can span old, unrelated backlog rows
too. Without `interface_invoice_id`, the status endpoint only reports an
outcome when it can do so unambiguously, which silently gives you less
information rather than a wrong answer.

**Before enabling POST, confirm these instance-specific values with your DBA**
and put them in `.env`: the `Source` lookup value (`EBS_IMPORT_SOURCE`), the
import program identifiers, and the apps-context IDs
(`EBS_APPS_USER_ID`, `EBS_APPS_RESP_ID`, `EBS_APPS_RESP_APPL_ID`). The **read**
endpoints need none of this.

You'll also need a valid `vendor_site_id` per invoice — Payables rejects any
invoice with no resolvable supplier site. Look one up with `GET /vendors` then
`GET /vendor-sites?org_id=&vendor_id=` rather than guessing a number.

**Registering a custom `Source` value.** If you want invoices tagged with your
own source name (e.g. `MAKE_API`) instead of reusing an existing one like
`MANUAL INVOICE ENTRY`, that name has to be added to `AP_LOOKUP_CODES`
(lookup_type `SOURCE`) first — this is normal, expected EBS setup for any
external system integrating with Payables, not a code change. Don't `INSERT`
into that table directly: it's a translated view over `FND_LOOKUP_VALUES`
(multi-org/multi-language), and a naive insert fails on `NOT NULL` columns
like `LANGUAGE` that the view hides. Use Oracle's supported API,
`FND_LOOKUP_VALUES_PKG.LOAD_ROW`, or add it through the Lookups setup screen
under Application Developer.

**GL period gotcha.** Even with everything above correct, an invoice still
gets rejected (`ACCT DATE NOT IN OPEN PD`) if `invoice_date` falls in a GL
period that isn't open for that org's ledger. This is pure EBS data/setup
state — periods are opened manually, month by month — and has nothing to do
with this API. If every invoice you submit fails the same way, check open
periods before assuming something here is broken.

---

## Security model

- **No arbitrary SQL.** Every endpoint is one fixed, bind-variable query — audit
  them all under `src/repositories/`.
- **Least privilege.** Connects only as the dedicated account from
  `docs/db-grants.sql`. Never a DBA/superuser account.
- **Shared secret** on every request except `/health`, compared in constant time.
- **Local binding** to `127.0.0.1` by default.
- **No secrets in logs** — the secret header is redacted; logs are structured
  (method, path, status, duration).

---

## Logs & monitoring

Logs are **human-readable by default** — one clean line per event. No tools or
scripts needed: read the file, or follow it live.

```bash
tail -f server.log          # or, under pm2:  pm2 logs ebs-invoice-api
```

```
2026-07-03 14:16:37 WARN: auth failed: X-Client-Secret header not present
2026-07-03 14:16:37 WARN: GET /orgs 401 1ms          <- call missing/invalid secret
2026-07-03 14:16:37 INFO: GET /orgs 200 3ms          <- call with the correct secret
2026-07-03 14:00:45 INFO: ebs-invoice-api listening
```

Each request logs method, path, **status**, and duration. **Headers are never
logged**, so the client secret cannot leak. Errors are logged in full
server-side and never returned to the caller.

**Diagnosing 401s:** a failed auth logs *why* — either
`X-Client-Secret header not present` (caller sent no header) or `present but did
not match` with `receivedLength` vs `expectedLength`, so you can spot an empty or
truncated value. The secret value itself is never logged.

**Format:** default `pretty` is the readable form above; set `LOG_FORMAT=json`
in `.env` for raw JSON lines (for log shippers/aggregators). Colors are added
only on a real terminal, so a redirected `server.log` stays clean text.

> `server.log` grows unbounded when you redirect to a file. For production, run
> under **pm2** (`pm2 logs`, with rotation) or systemd + journald.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `/health` returns `"db":"error"` | Wrong DB credentials/connect string, or DB not reachable | Recheck `EBS_DB_*`; confirm host/port/service with DBA; ensure network path to the DB |
| Startup error `ORA-12660` / `NJS-533` (encryption) | The DB **requires** Native Network Encryption; Thin mode can't do it | Enable **Thick mode** — step 6 |
| Startup error `DPI-1047 … libnnz.so` (Linux) | Thick mode on, but the client libraries aren't where configured | Check `EBS_CLIENT_LIB_DIR` points to the folder from `npm run fetch-client` (an **absolute** path); re-run the fetch if missing. (`npm start` sets the library path automatically.) |
| Startup error `DPI-1047 … cannot locate Oracle Client` (Windows) | Client libs missing or VC++ runtime absent | Re-run `npm run fetch-client:win`, check `EBS_CLIENT_LIB_DIR`, install the Microsoft Visual C++ Redistributable |
| `401 Unauthorized` | Missing/wrong `X-Client-Secret` | Send the header matching `CLIENT_SECRET` in `.env` |
| `400 org_id is required` | Listing/creating without an operating unit | Add `?org_id=<n>` (get valid values from `GET /orgs`) |
| `POST /invoices` returns `202` but `request_id` is `0` | `EBS_APPS_USER_ID`/`EBS_APPS_RESP_ID`/`EBS_APPS_RESP_APPL_ID` unset, so `FND_GLOBAL.APPS_INITIALIZE` ran with no real apps session and `FND_REQUEST.SUBMIT_REQUEST` silently failed | Set all three to a valid Oracle Applications user/responsibility (see [Creating invoices](#creating-invoices-the-post-flow)) |
| Import status is `Completed`/`Normal` but the response has no `interface_status`/`invoice_id` | `interface_invoice_id` wasn't passed on the status call, and more than one interface row shares this `request_id` (old backlog swept in together) | Pass `?interface_invoice_id=<value from the POST response>` — see [Creating invoices](#creating-invoices-the-post-flow) |
| `interface_status: "REJECTED"` | The interface row was rejected for a business reason, not a submission failure | Check `rejection_reasons` in the response — `ACCT DATE NOT IN OPEN PD` (GL period closed), `NO SUPPLIER SITE` (missing/invalid `vendor_site_id`), `DUPLICATE INVOICE NUMBER` (reused `invoice_num`) are the most common |
| `ORA-00942: table or view does not exist` | Missing grants, or wrong schema owner on this instance | Re-check `docs/db-grants.sql` was run and object owners match your instance |
| Startup: `Missing required environment variables` | `.env` incomplete | Fill in `CLIENT_SECRET`, `EBS_DB_USER`, `EBS_DB_PASSWORD`, `EBS_DB_CONNECT_STRING` |

---

## Project layout

```
src/
├── server.js          start-up: load config, open DB pool, listen, graceful shutdown
├── app.js             Express wiring: JSON, logging, auth gate, routes, errors
├── config.js          reads + validates .env (refuses to start if incomplete)
├── db.js              connection pool, Thin/Thick handling, health check
├── logger.js          structured logging (secret redacted)
├── errors.js          typed API errors
├── middleware/        auth (secret check) + error handler
├── routes/            one file per resource: health, orgs, vendors, terms, currencies, purchaseOrders, invoices
├── repositories/      ALL SQL lives here (bind variables only) — audit surface
└── util/              input validation helpers
scripts/
├── fetch-instantclient.sh    download Oracle client (Linux/macOS)
├── fetch-instantclient.ps1   download Oracle client (Windows)
└── start.sh                  Thick-mode launcher for Linux/macOS
```

Routes validate input, borrow a pooled connection, and call a repository.
Repositories own every SQL statement; routes never build SQL.

## Testing

Tests mock the database, so **no Oracle instance is required**:

```bash
npm test
```

They cover auth, validation, JSON mapping, paging limits, 404s, and the
create → import-status flow for every endpoint.

## License

BSD 3-Clause. See [LICENSE](../LICENSE).
