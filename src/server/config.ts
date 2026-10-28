import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
  from: string;
};

export type Config = {
  host: string;
  port: number;
  dbPath: string;
  cookieSecure: boolean;
  isDev: boolean;
  smtp: SmtpConfig | null;
};

function bool(v: string | undefined, fallback = false): boolean {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function flag(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

/**
 * Reads .env (if present), the environment, and optional --db=<file> / --port=<n> flags.
 * Secrets are never hardcoded; SMTP stays off unless configured.
 */
export function loadConfig(argv: string[] = process.argv): Config {
  const envFile = path.join(ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const env = process.env;
  const dbPath = flag(argv, 'db') || env.DB_PATH?.trim() || 'data/agency.db';
  const smtpHost = env.SMTP_HOST?.trim();
  return {
    host: env.HOST?.trim() || '127.0.0.1',
    port: Number(flag(argv, 'port')) || Number(env.PORT) || 4747,
    dbPath: dbPath === ':memory:' ? dbPath : path.resolve(ROOT, dbPath),
    cookieSecure: bool(env.COOKIE_SECURE),
    isDev: argv.includes('--dev'),
    smtp: smtpHost
      ? {
          host: smtpHost,
          port: Number(env.SMTP_PORT) || 587,
          secure: bool(env.SMTP_SECURE),
          user: env.SMTP_USER?.trim() || null,
          pass: env.SMTP_PASS || null,
          from: env.SMTP_FROM?.trim() || env.SMTP_USER?.trim() || 'no-reply@localhost',
        }
      : null,
  };
}
