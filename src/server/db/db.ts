import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type Row = Record<string, unknown>;
export type Params = Record<string, unknown> | readonly unknown[] | undefined;
type Bindable = null | number | bigint | string | Uint8Array;
type Prepared = { stmt: StatementSync; names: string[] };

const NAME_RE = /[:@$]([A-Za-z_][A-Za-z0-9_]*)/g;
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/** Named parameters used by a statement, ignoring anything inside string literals or comments. */
function paramNames(sql: string): string[] {
  const stripped = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, '');
  const names = new Set<string>();
  for (const m of stripped.matchAll(NAME_RE)) names.add(m[1]);
  return [...names];
}

function bindValue(v: unknown): Bindable {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  if (v instanceof Uint8Array) return v;
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

/**
 * Thin synchronous wrapper over node:sqlite.
 * - named params (:name) bind from an object; unknown keys are ignored, undefined becomes NULL
 * - booleans become 0/1, arrays/objects are stored as JSON text
 * - tx() nests with savepoints, so services can compose
 */
export class Db {
  readonly raw: DatabaseSync;
  #cache = new Map<string, Prepared>();
  #depth = 0;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  }

  #prepare(sql: string): Prepared {
    let p = this.#cache.get(sql);
    if (!p) {
      p = { stmt: this.raw.prepare(sql), names: paramNames(sql) };
      if (this.#cache.size > 500) this.#cache.clear();
      this.#cache.set(sql, p);
    }
    return p;
  }

  #bind(p: Prepared, params: Params): Bindable[] | [Record<string, Bindable>] {
    if (params === undefined) {
      // SQLite would silently bind a forgotten :param as NULL; fail loudly instead.
      if (p.names.length) throw new Error(`Missing SQL parameter(s): ${p.names.join(', ')}`);
      return [];
    }
    if (Array.isArray(params)) return params.map(bindValue);
    const src = params as Record<string, unknown>;
    const obj: Record<string, Bindable> = {};
    for (const n of p.names) {
      if (!(n in src)) throw new Error(`Missing SQL parameter: ${n}`);
      obj[n] = bindValue(src[n]);
    }
    return [obj];
  }

  all<T = Row>(sql: string, params?: Params): T[] {
    const p = this.#prepare(sql);
    return p.stmt.all(...(this.#bind(p, params) as [])) as T[];
  }

  get<T = Row>(sql: string, params?: Params): T | undefined {
    const p = this.#prepare(sql);
    return p.stmt.get(...(this.#bind(p, params) as [])) as T | undefined;
  }

  /** First column of the first row. */
  value<T = unknown>(sql: string, params?: Params): T | undefined {
    const row = this.get<Row>(sql, params);
    if (!row) return undefined;
    const k = Object.keys(row)[0];
    return row[k] as T;
  }

  run(sql: string, params?: Params): { changes: number; lastInsertRowid: number } {
    const p = this.#prepare(sql);
    const r = p.stmt.run(...(this.#bind(p, params) as []));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** INSERT a row from an object whose keys are column names; returns the new id. */
  insert(table: string, data: Record<string, unknown>): number {
    const cols = Object.keys(data).filter((k) => data[k] !== undefined);
    for (const c of [table, ...cols]) if (!IDENT_RE.test(c)) throw new Error(`Bad identifier: ${c}`);
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => ':' + c).join(', ')})`;
    return this.run(sql, data).lastInsertRowid;
  }

  /** UPDATE the given columns of one row by id; returns the number of changed rows. */
  update(table: string, id: number, data: Record<string, unknown>): number {
    const cols = Object.keys(data).filter((k) => data[k] !== undefined && k !== 'id');
    if (cols.length === 0) return 0;
    for (const c of [table, ...cols]) if (!IDENT_RE.test(c)) throw new Error(`Bad identifier: ${c}`);
    const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = :${c}`).join(', ')} WHERE id = :row_id`;
    return this.run(sql, { ...data, row_id: id }).changes;
  }

  tx<T>(fn: () => T): T {
    const sp = `sp_${this.#depth}`;
    this.raw.exec(this.#depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.#depth++;
    try {
      const out = fn();
      if (out instanceof Promise) throw new Error('Db.tx callbacks must be synchronous');
      this.#depth--;
      this.raw.exec(this.#depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return out;
    } catch (err) {
      this.#depth--;
      if (this.#depth === 0) this.raw.exec('ROLLBACK');
      else this.raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp};`);
      throw err;
    }
  }

  close(): void {
    this.#cache.clear();
    this.raw.close();
  }
}

/** Parse a JSON text column, falling back when it is empty or malformed. */
export function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
