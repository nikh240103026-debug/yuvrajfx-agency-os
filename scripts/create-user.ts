import { openContext, arg } from './shared.ts';
import { generatePassword, hashPassword } from '../src/server/lib/auth.ts';

// Account recovery from the command line. Prints a one-time password that must be changed at first sign-in.
//   npm run user:create -- --email you@example.com --name "Your Name" [--role owner|admin|member]
//   npm run user:create -- --email you@example.com --reset      (forgot your password)

const email = arg('email')?.trim().toLowerCase();
const name = arg('name')?.trim();
const role = (arg('role') ?? 'admin') as 'owner' | 'admin' | 'member';
const reset = process.argv.includes('--reset');

const { db, ctx } = openContext();
try {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Pass --email with a valid address.');
  const temporary = generatePassword();
  const hash = await hashPassword(temporary);
  const existing = db.get<{ id: number; role: string }>('SELECT id, role FROM users WHERE email = :email', { email });
  if (reset) {
    if (!existing) throw new Error(`No account with email ${email}.`);
    db.run('UPDATE users SET password_hash = :hash, must_change_password = 1, disabled = 0, updated_at = :now WHERE id = :id', { hash, now: ctx.nowIso(), id: existing.id });
    db.run('DELETE FROM sessions WHERE user_id = :id', { id: existing.id });
    console.log(`Password reset for ${email}.`);
  } else {
    if (existing) throw new Error(`An account with ${email} already exists. Use --reset to set a new password.`);
    if (!['owner', 'admin', 'member'].includes(role)) throw new Error('Role must be owner, admin or member.');
    if (role === 'owner' && db.get(`SELECT 1 FROM users WHERE role = 'owner'`)) throw new Error('An owner already exists. Create an admin instead.');
    if (!name) throw new Error('Pass --name "Full Name".');
    const now = ctx.nowIso();
    db.insert('users', { email, name, role, password_hash: hash, must_change_password: 1, created_at: now, updated_at: now });
    console.log(`Created ${role} account for ${email}.`);
  }
  console.log(`One-time password: ${temporary}`);
  console.log('Sign in with it; you will be asked to choose your own password straight away.');
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  db.close();
}
