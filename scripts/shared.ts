import { loadConfig } from '../src/server/config.ts';
import { Db } from '../src/server/db/db.ts';
import { migratePostgres } from '../src/server/db/postgres-migrations.ts';
import { createContext } from '../src/server/context.ts';
import { createMailer } from '../src/server/services/mailer.ts';

/** Opens the PostgreSQL database and applies its versioned schema. */
export async function openContext() {
  const config = loadConfig([]);
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required. Configure PostgreSQL first.');
  const db = new Db(config.databaseUrl);
  const applied = await migratePostgres(db.pool);
  const ctx = createContext({ db, config, mailer: createMailer(config.smtp) });
  return { ctx, db, config, applied };
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
