
import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, types, type PoolClient, type QueryResult } from 'pg';

export type Row = Record<string, unknown>;
export type Params = Record<string, unknown> | readonly unknown[] | undefined;

type QueryContext = { client: PoolClient };

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

// pg returns int8/numeric aggregates as strings by default. The application uses safe integer minor units and numeric IDs.
types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(1700, (value) => Number(value));


function bindValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object' && !(value instanceof Uint8Array)) {
    return JSON.stringify(value);
  }
  return value;
}


/**
 * Converts legacy named parameters (:name, @name, $name)
 * into PostgreSQL positional parameters ($1, $2, ...).
 *
 * Quoted strings, identifiers, comments and PostgreSQL dollar-quoted
 * strings are skipped to avoid replacing text that is not a parameter.
 */
export function compileSql(
  sql: string,
  params?: Params,
): { sql: string; values: unknown[] } {
  if (params === undefined) {
    if (/(?<!:):[a-z_][a-z0-9_]*/i.test(sql)) {
      throw new Error('SQL parameters are missing.');
    }
    return { sql, values: [] };
  }

  if (Array.isArray(params)) {

        // Preserve native PostgreSQL placeholders used by insert() and update().
    // These SQL statements already contain $1, $2, etc.
    if (/\$\d+/.test(sql)) {
      const placeholders = [...sql.matchAll(/\$(\d+)/g)]
        .map((match) => Number(match[1]));

      const maxPlaceholder = Math.max(0, ...placeholders);

      if (maxPlaceholder !== params.length) {
        throw new Error(
          `SQL parameter count mismatch: expected ${maxPlaceholder}, received ${params.length}.`,
        );
      }

      return {
        sql,
        values: params.map(bindValue),
      };
    }

    let index = 0;
    let output = '';
    let state:
      | 'normal'
      | 'single'
      | 'double'
      | 'line-comment'
      | 'block-comment' = 'normal';

    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i];
      const next = sql[i + 1];

      if (state === 'single') {
        output += ch;
        if (ch === "'" && next === "'") output += sql[++i];
        else if (ch === "'") state = 'normal';
        continue;
      }

      if (state === 'double') {
        output += ch;
        if (ch === '"' && next === '"') output += sql[++i];
        else if (ch === '"') state = 'normal';
        continue;
      }

      if (state === 'line-comment') {
        output += ch;
        if (ch === '\n') state = 'normal';
        continue;
      }

      if (state === 'block-comment') {
        output += ch;
        if (ch === '*' && next === '/') {
          output += sql[++i];
          state = 'normal';
        }
        continue;
      }

      if (ch === "'") {
        state = 'single';
        output += ch;
      } else if (ch === '"') {
        state = 'double';
        output += ch;
      } else if (ch === '-' && next === '-') {
        state = 'line-comment';
        output += ch + sql[++i];
      } else if (ch === '/' && next === '*') {
        state = 'block-comment';
        output += ch + sql[++i];
      } else if (ch === '?') {
        output += `$${++index}`;
      } else {
        output += ch;
      }
    }

    if (index !== params.length) {
      throw new Error(
        `SQL parameter count mismatch: expected ${index}, received ${params.length}.`,
      );
    }

    return { sql: output, values: params.map(bindValue) };
  }

  

  const source = params as Record<string, unknown>;
  const names: string[] = [];
  const values: unknown[] = [];
  const indexes = new Map<string, number>();

  let output = '';
  let state:
    | 'normal'
    | 'single'
    | 'double'
    | 'line-comment'
    | 'block-comment' = 'normal';

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (state === 'single') {
      output += ch;
      if (ch === "'" && next === "'") output += sql[++i];
      else if (ch === "'") state = 'normal';
      continue;
    }

    if (state === 'double') {
      output += ch;
      if (ch === '"' && next === '"') output += sql[++i];
      else if (ch === '"') state = 'normal';
      continue;
    }

    if (state === 'line-comment') {
      output += ch;
      if (ch === '\n') state = 'normal';
      continue;
    }

    if (state === 'block-comment') {
      output += ch;
      if (ch === '*' && next === '/') {
        output += sql[++i];
        state = 'normal';
      }
      continue;
    }

    if (ch === "'") {
      state = 'single';
      output += ch;
      continue;
    }

    if (ch === '"') {
      state = 'double';
      output += ch;
      continue;
    }

    if (ch === '-' && next === '-') {
      state = 'line-comment';
      output += ch + sql[++i];
      continue;
    }

    if (ch === '/' && next === '*') {
      state = 'block-comment';
      output += ch + sql[++i];
      continue;
    }

    if (
      (ch === ':' || ch === '@' || ch === '$') &&
      next &&
      /[a-z_]/i.test(next) &&
      !(ch === ':' && sql[i - 1] === ':')
    ) {
      let end = i + 2;
      while (end < sql.length && /[a-z0-9_]/i.test(sql[end])) end++;

      const name = sql.slice(i + 1, end);

      if (!(name in source)) {
        throw new Error(`Missing SQL parameter: ${name}`);
      }

      let index = indexes.get(name);

      if (index === undefined) {
        index = values.length + 1;
        indexes.set(name, index);
        names.push(name);
        values.push(bindValue(source[name]));
      }

      output += `$${index}`;
      i = end - 1;
      continue;
    }

    output += ch;
  }

  return { sql: output, values };
}

/** Async PostgreSQL adapter. Not yet wired into the application's routes. */
export class Db {
  readonly pool: Pool;
  #context = new AsyncLocalStorage<QueryContext>();
  #closed = false;

  constructor(connectionString: string, schema?: string) {
    if (!connectionString?.trim()) {
      throw new Error('DATABASE_URL is required for PostgreSQL.');
    }

    this.pool = new Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      application_name: 'yuvrajfx-agency-os',
      allowExitOnIdle: true,
      options: schema ? `-c search_path=${schema}` : undefined,
      ssl: process.env.PGSSL === 'true'
        ? { rejectUnauthorized: true }
        : undefined,
    });

    this.pool.on('error', (error) => {
      console.error('Unexpected idle PostgreSQL client error:', error);
    });
  }

  async #query(
    sql: string,
    params?: Params,
  ): Promise<QueryResult<Row>> {
    if (this.#closed) throw new Error('PostgreSQL database is closed.');

    const compiled = compileSql(sql, params);
    const client = this.#context.getStore()?.client;

    if (client) {
      return client.query(compiled.sql, compiled.values) as Promise<QueryResult<Row>>;
    }

    return this.pool.query(compiled.sql, compiled.values) as Promise<QueryResult<Row>>;
  }

  async all<T = Row>(sql: string, params?: Params): Promise<T[]> {
    const result = await this.#query(sql, params);
    return result.rows as T[];
  }

  async get<T = Row>(sql: string, params?: Params): Promise<T | undefined> {
    const result = await this.#query(sql, params);
    return result.rows[0] as T | undefined;
  }

  async value<T = unknown>(sql: string, params?: Params): Promise<T | undefined> {
    const row = await this.get<Row>(sql, params);
    if (!row) return undefined;
    return row[Object.keys(row)[0]] as T;
  }

  async run(
    sql: string,
    params?: Params,
  ): Promise<{ changes: number; lastInsertRowid: number }> {
    const result = await this.#query(sql, params);
    const id = result.rows[0]?.id;

    return {
      changes: result.rowCount ?? 0,
      lastInsertRowid: id === undefined ? 0 : Number(id),
    };
  }

  async exec(sql: string): Promise<void> {
    if (this.#closed) throw new Error('PostgreSQL database is closed.');

    const client = this.#context.getStore()?.client;

    if (client) {
      await client.query(sql);
    } else {
      await this.pool.query(sql);
    }
  }

  async insert(table: string, data: Record<string, unknown>): Promise<number> {
    const columns = Object.keys(data).filter((key) => data[key] !== undefined);

    if (!IDENT_RE.test(table) || columns.length === 0) {
      throw new Error('Invalid table name or empty insert data.');
    }

    for (const column of columns) {
      if (!IDENT_RE.test(column)) throw new Error(`Bad column identifier: ${column}`);
    }

    const values = columns.map((column) => data[column]);
    const placeholders = columns.map((_, index) => `$${index + 1}`);

    const result = await this.#query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
      values,
    );

    const id = result.rows[0]?.id;

    if (id === undefined) {
      throw new Error(`INSERT into ${table} did not return an id.`);
    }

    const numericId = Number(id);
    return Number.isFinite(numericId) ? numericId : 0;
  }

  async update(
    table: string,
    id: number,
    data: Record<string, unknown>,
  ): Promise<number> {
    if (!IDENT_RE.test(table)) throw new Error(`Bad table identifier: ${table}`);

    const columns = Object.keys(data).filter(
      (key) => data[key] !== undefined && key !== 'id',
    );

    if (columns.length === 0) return 0;

    for (const column of columns) {
      if (!IDENT_RE.test(column)) throw new Error(`Bad column identifier: ${column}`);
    }

    const values = columns.map((column) => bindValue(data[column]));
    values.push(id);

    const assignments = columns.map(
      (column, index) => `${column} = $${index + 1}`,
    );

    const result = await this.#query(
      `UPDATE ${table} SET ${assignments.join(', ')} WHERE id = $${values.length}`,
      values,
    );

    return result.rowCount ?? 0;
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    const parent = this.#context.getStore();

    if (parent) {
      const savepoint = `sp_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
      await parent.client.query(`SAVEPOINT ${savepoint}`);

      try {
        const result = await fn();
        await parent.client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        await parent.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await parent.client.query(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    }

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const result = await this.#context.run({ client }, fn);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.pool.end();
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
