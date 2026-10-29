# PostgreSQL migration status — do not deploy as PostgreSQL yet

This source snapshot is not yet PostgreSQL-backed end to end.

- `src/server/index.ts` still constructs `new Db(config.dbPath)` from `src/server/db/db.ts`, which imports `node:sqlite`.
- `src/server/db/migrations.ts`, `src/server/context.ts`, authentication middleware, route handlers, and services still use synchronous database operations.
- `src/server/db/postgres.ts` is an asynchronous adapter, and its tests cover adapter behavior only. It is not wired into the app runtime.
- `DATABASE_URL` is read by configuration but is not used to select the runtime database.
- `src/server/db/postgres-schema.sql` is a schema artifact; startup does not apply it.

Do not set `DATABASE_URL` and assume the app will use PostgreSQL. Completing the migration requires propagating async database calls through the application and CLI scripts, updating SQLite-specific SQL, making schema migrations safe/repeatable, and running the full test suite against PostgreSQL before production deployment.

The root `package.json` was reconstructed from the matching `package-lock.json` because it was missing from the supplied archive. Install dependencies with Node.js 24 or newer using `npm ci`.
