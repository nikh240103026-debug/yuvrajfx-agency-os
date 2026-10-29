import { openContext } from './shared.ts';
import { demoCounts, loadDemoData, removeDemoData } from '../src/server/services/demo.ts';
import type { Actor } from '../src/server/lib/activity.ts';

// npm run seed:demo    → load clearly-labelled demo data
// npm run demo:remove  → delete every demo row (your real data is untouched)

const action = process.argv[2];
const { ctx, db } = await openContext();
try {
  const owner = await db.get<{ id: number; name: string }>(`SELECT id, name FROM users WHERE role = 'owner' ORDER BY id LIMIT 1`);
  if (!owner) {
    console.error('Finish the first-run setup in the browser first (it creates your owner account).');
    process.exitCode = 1;
  } else {
    const actor: Actor = { type: 'user', id: owner.id, name: owner.name };
    if (action === 'load') {
      if ((await demoCounts(ctx)).total > 0) console.log('Demo data is already loaded.');
      else console.log('Demo data loaded:', await loadDemoData(ctx, actor));
    } else if (action === 'remove') {
      console.log('Removed demo rows:', await removeDemoData(ctx, actor));
    } else {
      console.error('Usage: node scripts/demo.ts load|remove');
      process.exitCode = 1;
    }
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.close();
}
