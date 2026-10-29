# Supabase PostgreSQL migration audit

## Current state

The deployed service is still using SQLite. The server log confirms `DB_PATH=data/agency.db`, and the current database implementation imports `DatabaseSync` from `node:sqlite`. Adding `DATABASE_URL` to Render does not switch the application to PostgreSQL.

## Confirmed migration surface

- `src/server/db/db.ts`: synchronous SQLite-specific database adapter (`all`, `get`, `value`, `run`, `insert`, `update`, `exec`, nested synchronous `tx`).
- `src/server/db/migrations.ts`: SQLite schema, SQLite timestamp defaults (`strftime`), `COLLATE NOCASE`, and SQLite triggers.
- 25 server/script files call the database adapter; scanned usage counts: `run` 71, `insert` 54, `tx` 46, `get` 39, `all` 18, `update` 14, `exec` 4.
- SQLite-only SQL found in application code includes `INSERT OR IGNORE`, `json_extract`, `COLLATE NOCASE`, and `strftime`.
- `scripts/shared.ts`, `scripts/migrate.ts`, `scripts/create-user.ts`, `scripts/backup.ts`, server startup, and tests also construct or rely on the SQLite adapter.

## Why changing only the connection string is unsafe

The app assumes database calls are synchronous. PostgreSQL drivers for Node are asynchronous, so database calls and transaction boundaries need to be propagated through services and Express routes. PostgreSQL also needs its own schema migrations and equivalent financial-integrity constraints. A thin `DATABASE_URL` configuration change would leave the app talking to SQLite and would not persist data in Supabase.

## Safe migration sequence

1. Add a PostgreSQL-backed adapter and make database access/transactions asynchronous, retaining a compatibility boundary where practical.
2. Convert schema migrations to PostgreSQL and reproduce constraints/triggers for invoices and payments.
3. Convert SQL dialect differences (`INSERT OR IGNORE`, JSON access, case-insensitive comparisons, timestamps, generated IDs) and audit all parameter binding.
4. Update startup, CLI scripts, backup/restore, tests, and Render configuration so every runtime uses the same database selection.
5. Add migration tests against a real PostgreSQL instance, run the existing test suite, then deploy to a staging service and verify auth, client/project workflows, invoice/payment integrity, portal access, and automations before production cutover.
6. Only after verification, migrate any existing SQLite data and remove the temporary SQLite deployment path if PostgreSQL is to be the sole production database.

## Deployment safety

- Do not treat the current live service as migrated merely because `DATABASE_URL` exists in Render.
- Do not run account creation or production writes against an unverified migration.
- Keep the Supabase password in Render's secret environment settings; never commit it or paste it into source files.
- Keep a verified backup of any SQLite data before changing production storage.
