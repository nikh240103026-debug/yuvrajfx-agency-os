import path from 'node:path';
import { mkdirSync, statSync } from 'node:fs';
import { openContext } from './shared.ts';
import { ROOT } from '../src/server/config.ts';

// Consistent copy of the live database (safe while the app is running): data/backups/agency-<time>.db
const { db, config } = openContext();
try {
  if (config.dbPath === ':memory:') throw new Error('DB_PATH is :memory:, nothing to back up.');
  const dir = path.join(ROOT, 'data', 'backups');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agency-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  console.log(`Backup written: ${file} (${Math.round(statSync(file).size / 1024)} KB)`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  db.close();
}
