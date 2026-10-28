import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { loadConfig } from '../src/server/config.ts';
import { Db } from '../src/server/db/db.ts';
import { migrate } from '../src/server/db/migrations.ts';
import { createContext } from '../src/server/context.ts';
import { createMailer } from '../src/server/services/mailer.ts';

/** Opens the configured database (applying migrations) for command-line scripts. */
export function openContext() {
  const config = loadConfig([]);
  if (config.dbPath !== ':memory:') mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = new Db(config.dbPath);
  const applied = migrate(db);
  const ctx = createContext({ db, config, mailer: createMailer(config.smtp) });
  return { ctx, db, config, applied };
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
