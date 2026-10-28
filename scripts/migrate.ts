import { openContext } from './shared.ts';

const { db, config, applied } = openContext();
console.log(applied.length ? `Applied migrations ${applied.join(', ')} to ${config.dbPath}` : `Database is up to date: ${config.dbPath}`);
db.close();
