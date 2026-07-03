# EBS Invoice API Wrapper

A small, secure middleware service that exposes a stable HTTP/JSON API over
**Oracle E-Business Suite (EBS) Payables** invoice data.

It exists so that automation platforms (for example Make.com via an on-prem
agent + HTTP module) can **read and create Accounts Payable invoices** without
being granted ORDS/ISG access or a direct database connection into EBS. The
service sits in front of the database as a thin, tightly-scoped proxy: every
endpoint maps to exactly one fixed, parameterized query or procedure call —
there is no generic "run SQL" surface.

> Status: **invoices** today. The same pattern can be extended to other EBS
> objects later.

## Why this exists

Exposing EBS directly to an integration tool is risky and awkward:

- ORDS/ISG setup is heavyweight and often not available.
- Handing out DB credentials to a SaaS automation tool is a non-starter.
- Ad-hoc SQL from an external system is an injection and blast-radius problem.

This wrapper solves that by running **inside your network**, connecting to EBS
as a **dedicated low-privilege database user**, and offering only a handful of
well-defined invoice endpoints protected by a shared client secret.

## Two implementations, one contract

The repository ships the same API — identical routes, request/response shapes,
and behavior — in two stacks so you can deploy whichever fits your environment:

| Directory | Stack | Status |
|-----------|-------|--------|
| [`node/`](./node) | Node.js + Express + `oracledb` | ✅ Implemented & tested against live EBS 12.2 |
| `python/` | Flask + `oracledb` | ⏳ Planned |
| `docker/` | Dockerfiles / compose for both | ⏳ Planned |

Both use the `oracledb` driver. It runs in **Thin mode** by default (pure
JavaScript, nothing to install). Databases that **enforce Oracle Native Network
Encryption** — common in production EBS — additionally need **Thick mode**,
which the service supports via a one-command download of the Oracle client into
the app folder (no database change, no system install). The Node README walks
through both.

> **New here? Start with the [Node setup guide](./node/README.md)** — it is
> written for admins with no prior Oracle knowledge.

## Repository layout

```
.
├── README.md            <- you are here
├── LICENSE              <- BSD 3-Clause
├── docs/
│   ├── tech-spec.md     <- the authoritative design/spec
│   ├── api.md           <- endpoint reference (request/response)
│   └── db-grants.sql    <- DBA grant template for the service account
└── node/                <- Node.js implementation (see node/README.md)
```

## Endpoints (summary)

| Method & path | Auth | Purpose |
|---------------|------|---------|
| `GET /health` | none | Liveness + DB pool connectivity |
| `GET /orgs` | secret | List operating units (discover valid `org_id`) |
| `GET /invoices` | secret | Paginated invoice list for one operating unit |
| `GET /invoices/:id` | secret | One invoice + its lines |
| `POST /invoices` | secret | Stage an invoice and submit Payables Open Interface Import |
| `GET /invoices/import-status/:request_id` | secret | Poll the import concurrent request |

Full details, including field shapes and examples, are in
[`docs/api.md`](./docs/api.md) and the implementation READMEs.

## A word on operating units (`org_id`)

EBS stores many business units in one database. The Payables tables
(`ap_invoices_all`, …) are **multi-org**: every row carries an `ORG_ID`
identifying which **operating unit** it belongs to. This API never mixes
operating units implicitly:

- `GET /orgs` lets a caller discover the available operating units.
- `GET /invoices` and `POST /invoices` **require** an `org_id` so reads and
  writes always target exactly one operating unit.

If you are new to EBS multi-org, see the explanation in
[`docs/tech-spec.md`](./docs/tech-spec.md).

## Security model

- **No arbitrary SQL.** Each endpoint is one fixed, bind-variable query/procedure.
- **Least privilege.** Connects as a dedicated account with only the grants in
  [`docs/db-grants.sql`](./docs/db-grants.sql). No DBA/superuser accounts.
- **Shared secret.** Every non-health request must send `X-Client-Secret`,
  compared against a server-side environment variable (constant-time compare).
- **Local binding.** Binds to `127.0.0.1` by default; restrict exposure at the
  network/firewall layer.
- **No secrets in logs.** Structured logs record method/path/status/duration;
  the secret header is redacted.

## Getting started

**Follow the step-by-step [Node setup guide](./node/README.md#setup--step-by-step).**
The short version:

```bash
cd node
npm install
npm test                  # runs against a mocked DB, no Oracle needed
cp .env.example .env      # then fill in DB credentials + client secret
npm start                 # (or `npm run start:thick` if the DB enforces encryption)
```

Before it can talk to a real instance, a DBA must create the service account
using [`docs/db-grants.sql`](./docs/db-grants.sql) as a template. The Node guide
covers the encryption (Thin vs Thick) decision and troubleshooting in full.

## License

BSD 3-Clause. See [LICENSE](./LICENSE).
