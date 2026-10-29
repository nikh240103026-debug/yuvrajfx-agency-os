import { loadConfig } from '../src/server/config.ts';
import { Pool } from 'pg';
import { migratePostgres } from '../src/server/db/postgres-migrations.ts';

const config = loadConfig();
if (!config.databaseUrl) {
  console.error('DATABASE_URL is required. No database was changed.');
  process.exit(1);
}
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 2,
  connectionTimeoutMillis: 10_000,
  application_name: 'yuvrajfx-agency-os-migrator',
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined,
});
try {
  const applied = await migratePostgres(pool);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'PostgreSQL schema is already up to date.');
} catch (error) {
  console.error('PostgreSQL migration failed; transaction rolled back.', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
