import { openContext } from './shared.ts';
const { db, applied } = await openContext();
try {
  console.log(applied.length ? `Applied PostgreSQL migrations: ${applied.join(', ')}` : 'PostgreSQL schema is up to date.');
} catch (error) {
  console.error('PostgreSQL migration failed.', error);
  process.exitCode = 1;
} finally {
  await db.close();
}
