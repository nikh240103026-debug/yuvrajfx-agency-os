# YuvrajFX Agency OS — PostgreSQL schema replacement

## What this package contains

- `postgres-schema.sql`: the database schema for the application, including tables, constraints, indexes, the invoice balance view, payment/invoice integrity triggers, and a `schema_migrations` record. It is made re-runnable for existing objects where PostgreSQL supports that safely.

## Apply the SQL

Use a PostgreSQL database created for this application. Back up any existing database first. Run from a machine with `psql` installed:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f postgres-schema.sql
```

Do not point this at a production database containing data you need to preserve without taking a backup and reviewing the schema first.

## Important application-runtime limitation

This SQL file provisions PostgreSQL. It does **not by itself complete the application's SQLite-to-PostgreSQL migration**. The supplied source snapshot still has synchronous SQLite calls throughout routes, services, authentication, settings, and scripts; `src/server/index.ts` still creates the SQLite `Db` and runs SQLite migrations. PostgreSQL's `pg` driver is asynchronous, so swapping a single `db.ts` file or setting `DATABASE_URL` is not a safe drop-in replacement. The full app is not deployable against PostgreSQL until those call sites are converted to async and tested against a real PostgreSQL instance.

This limitation is stated explicitly rather than claiming a deployable app when it is not one.
