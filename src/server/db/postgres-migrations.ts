import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { ROOT } from '../config.ts';

/**
 * Applies the PostgreSQL schema as one atomic first migration. This is the only application schema migration path. Runtime startup requires PostgreSQL.
 */
export async function migratePostgres(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version BIGINT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const applied = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations WHERE version = $1', [1],
    );
    if (applied.rowCount) {
      await client.query('COMMIT');
      return [];
    }

    const schemaPath = path.join(ROOT, 'src', 'server', 'db', 'postgres-schema.sql');
    const schema = await readFile(schemaPath, 'utf8');
    await client.query(schema);
    await client.query(
      'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
      [1, 'PostgreSQL initial schema'],
    );
    await client.query('COMMIT');
    return ['1: PostgreSQL initial schema'];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
