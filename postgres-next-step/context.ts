import type { Db } from './db/db.ts';
import type { Config } from './config.ts';
import type { Mailer } from './services/mailer.ts';
import { readSettings, type Settings } from './lib/settings.ts';
import { todayIn } from '../shared/dates.ts';

export type Clock = { now(): Date };

export type AppContext = {
  db: Db;
  config: Config;
  clock: Clock;
  mailer: Mailer;
  nowIso(): string;
  /** Today's date in the business timezone (Settings → timezone). */
  today(): string;
  settings(): Settings;
  invalidateSettings(): void;
};

export function createContext(opts: { db: Db; config: Config; mailer: Mailer; clock?: Clock }): AppContext {
  const clock = opts.clock ?? { now: () => new Date() };
  let cached: Settings | null = null;
  const ctx: AppContext = {
    db: opts.db,
    config: opts.config,
    clock,
    mailer: opts.mailer,
    nowIso: () => clock.now().toISOString(),
    today: () => todayIn(ctx.settings().timezone, clock.now()),
    settings: () => (cached ??= readSettings(opts.db)),
    invalidateSettings: () => {
      cached = null;
    },
  };
  return ctx;
}
