# PostgreSQL migration status

## Implemented in this working copy

- The runtime database adapter is PostgreSQL-only (`pg` Pool + async queries and transactions).
- Server startup and CLI context require `DATABASE_URL`; the SQLite runtime adapter and SQLite schema migration runner have been removed.
- PostgreSQL schema/migration runner and PostgreSQL-only backup flow are wired into startup and settings.
- Database reads/writes, transaction callbacks, settings access, and business-timezone access have been converted to async call paths.
- SQLite-specific runtime SQL has been converted, including JSON array lookups, case-insensitive ordering, insert-on-conflict behavior, and boolean aggregate queries.
- The settings UI now reports PostgreSQL as the database engine.
- Tests now expect a disposable PostgreSQL database (`TEST_DATABASE_URL` targeting `yuvraj_agency_test`) and create isolated schemas.
- The former local database file was preserved outside the project working copy at `/mnt/data/yuvraj_recovery/legacy-sqlite-data/` rather than destroyed.

## Verification limitation — not production-certified

- TypeScript syntax transpilation passed for the source, scripts, and tests.
- PostgreSQL schema table/column names were statically compared against the prior schema.
- Full typecheck, build, unit/integration tests, and a live PostgreSQL migration could not be run in this environment: the available Node version is 22.16 (the project requires Node 24+), dependency installation timed out, and no PostgreSQL server/client is installed.
- Do not deploy this working copy until `npm ci`, `npm run check`, and migration/workflow tests pass in a Node 24+ environment with a disposable PostgreSQL database. In particular, verify auth, client/project workflows, invoice/payment integrity, portal isolation, automation runs, and backup/restore.
