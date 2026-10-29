import path from 'node:path';
import { mkdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { openContext } from './shared.ts';
import { pgEnvFromUrl } from '../src/server/db/pg-env.ts';
import { ROOT } from '../src/server/config.ts';

const { db, config } = await openContext();
try {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required.');
  const dir = path.join(ROOT, 'data', 'backups');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agency-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`);
  const out = createWriteStream(file, { flags: 'wx' });
  const child = spawn('pg_dump', ['--format=custom', '--no-owner', '--no-privileges'], {
    env: pgEnvFromUrl(config.databaseUrl),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const childClosed = once(child, 'close');
  const outputClosed = once(out, 'close');
  child.stdout.pipe(out);
  const [code] = await childClosed as [number | null];
  await outputClosed;
  if (code !== 0) throw new Error(`pg_dump failed (${code}): ${stderr}`);
  console.log(`PostgreSQL backup written: ${file} (${Math.round(statSync(file).size / 1024)} KB)`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.close();
}
