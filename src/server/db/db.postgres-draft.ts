
import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient, type QueryResult } from 'pg';

export type Row = Record<string, unknown>;
export type Params = Record<string, unknown> | readonly unknown[] | undefined;

type TransactionContext = {
  client: PoolClient;
  depth: number;
};

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

const transactionContext = new AsyncLocalStorage<TransactionContext>();

function normalizeValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();

  if (
    value !== null &&
    typeof value === 'object' &&
    !(value instanceof Uint8Array)
  ) {
    return JSON.stringify(value);
  }

  return value;
}

/**
 * Convert SQLite-style named parameters to PostgreSQL positional parameters.
 * Named parameters must use the form :name.
 */
function prepareSql(
  source: string,
  params: Params,
): { sql: string; values: unknown[] } {
  let sql = '';
  const values: unknown[] = [];
  const positions = new Map<string, number>();

  let index = 0;
  let quote: "'" | '"' | '`' | null = null;
  let lineComment = false;
  let blockComment = false;

  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];

    if (lineComment) {
      sql += char;
      if (char === '\n') lineComment = false;
      index++;
      continue;
    }

    if (blockComment) {
      sql += char;
      if (char === '*' && next === '/') {
        sql += '/';
        index += 2;
        blockComment = false;
      } else {
        index++;
      }
      continue;
    }

    if (quote) {
      sql += char;

      if (char === quote) {
        if (next === quote && quote !== '`') {
          sql += next;
          index += 2;
          continue;
        }
        quote = null;
      } else if (char === '\\' && next && quote !== '`') {
        sql += next;
        index += 2;
        continue;
      }

      index++;
      continue;
    }

    if (char === '-' && next === '-') {
      sql += '--';
      index += 2;
      lineComment = true;
      continue;
    }

    if (char === '/' && next === '*') {
      sql += '/*';
      index += 2;
      blockComment = true;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      sql += char;
      index++;
      continue;
    }

    // Preserve PostgreSQL's ::type casts.
    if (char === ':' && next === ':') {
      sql += '::';
      index += 2;
      continue;
    }

    if (char === ':' && /[A-Za-z_]/.test(next ?? '')) {
      let end = index + 2;

      while (end < source.length && /[A-Za-z0-9_]/.test(source[end]!)) {
        end++;
      }

      const name = source.slice(index + 1, end);
      let position = positions.get(name);

      if (position === undefined) {
        let value: unknown;

        if (Array.isArray(params)) {
          throw new Error(
            `Named SQL parameter :${name} cannot use positional parameters`,
          );
        }

        if (!params || !(name in params)) {
          throw new Error(`Missing SQL parameter: ${name}`);
        }

        value = normalizeValue((params as Record<string, unknown>)[name]);

        values.push(value);
        position = values.length;
        positions.set(name, position);
      }

      sql += `$${position}`;
      index = end;
      continue;
    }

    sql += char;
    index++;
  }

  if (Array.isArray(params)) {
    if (values.length > 0) {
      throw new Error('Cannot mix named and positional SQL parameters');
    }

    return {
      sql: source,
      values: params.map(normalizeValue),
    };
  }

  return { sql, values };
}

/**
 * Translate the SQLite-specific SQL patterns still present in the
 * application. Each query must still be audited during migration.
 */
function translateSql(source: string): string {
  let sql = source.trim().replace(/;\s*$/, '');

  // SQLite case-insensitive sort annotations.
  sql = sql.replace(/\s+COLLATE\s+NOCASE\b/gi, '');

  // SQLite INSERT OR IGNORE becomes PostgreSQL ON CONFLICT DO NOTHING.
  const ignoreInsert = /^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql);

  if (ignoreInsert) {
    sql = sql.replace(
      /^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i,
      'INSERT INTO',
    );

    if (!/\bON\s+CONFLICT\b/i.test(sql)) {
      sql += ' ON CONFLICT DO NOTHING';
    }
  }

  // SQLite JSON lookup used by workspace activity filtering.
  sql = sql.replace(
    /json_extract\(\s*([a-z_][a-z0-9_.]*)\s*,\s*'\$\.([a-z_][a-z0-9_]*)'\s*\)/gi,
    "(\\1::jsonb ->> '\\2')",
  );

  return sql;
}

export class Db {
  readonly pool: Pool;
  readonly databaseUrl: string;

  #closed = false;

  constructor(databaseUrl: string) {
    if (
      !databaseUrl ||
      !/^postgres(?:ql)?:\/\//i.test(databaseUrl)
    ) {
      throw new Error(
        'A valid PostgreSQL DATABASE_URL is required. ' +
        'SQLite paths and :memory: are not supported by this adapter.',
      );
    }

    this.databaseUrl = databaseUrl;

    this.pool = new Pool({
      connectionString: databaseUrl,
      max: Number(process.env.DB_POOL_MAX) || 10,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: false,
      application_name: 'yuvrajfx-agency-os',
    });

    this.pool.on('error', (error) => {
      console.error('Unexpected idle PostgreSQL client error:', error);
    });
  }

  async #query<T extends Row = Row>(
    source: string,
    params?: Params,
  ): Promise<QueryResult<T>> {
    if (this.#closed) {
      throw new Error('Database connection pool is closed.');
    }

    const translated = translateSql(source);
    const prepared = prepareSql(translated, params);
    const transaction = transactionContext.getStore();

    if (transaction) {
      return transaction.client.query<T>(
        prepared.sql,
        prepared.values,
      );
    }

    return this.pool.query<T>(
      prepared.sql,
      prepared.values,
    );
  }

  async all<T = Row>(
    sql: string,
    params?: Params,
  ): Promise<T[]> {
    const result = await this.#query(sql, params);
    return result.rows as T[];
  }

  async get<T = Row>(
    sql: string,
    params?: Params,
  ): Promise<T | undefined> {
    const result = await this.#query(sql, params);
    return result.rows[0] as T | undefined;
  }

  async value<T = unknown>(
    sql: string,
    params?: Params,
  ): Promise<T | undefined> {
    const row = await this.get<Row>(sql, params);

    if (!row) return undefined;

    const key = Object.keys(row)[0];
    return row[key] as T;
  }

  async run(
    sql: string,
    params?: Params,
  ): Promise<{ changes: number; lastInsertRowid: number }> {
    const result = await this.#query(sql, params);
    const firstRow = result.rows[0] as
      | { id?: number | string }
      | undefined;

    return {
      changes: result.rowCount ?? 0,
      lastInsertRowid:
        firstRow?.id === undefined ? 0 : Number(firstRow.id),
    };
  }

  async exec(sql: string): Promise<void> {
    if (this.#closed) {
      throw new Error('Database connection pool is closed.');
    }

    const transaction = transactionContext.getStore();

    if (transaction) {
      await transaction.client.query(sql);
      return;
    }

    await this.pool.query(sql);
  }

  async insert(
    table: string,
    data: Record<string, unknown>,
  ): Promise<number> {
    const columns = Object.keys(data).filter(
      (key) => data[key] !== undefined,
    );

    if (!IDENT_RE.test(table)) {
      throw new Error(`Invalid table identifier: ${table}`);
    }

    if (columns.length === 0) {
      throw new Error('Cannot insert an empty row.');
    }

    for (const column of columns) {
      if (!IDENT_RE.test(column)) {
        throw new Error(`Invalid column identifier: ${column}`);
      }
    }

    const sql = `
      INSERT INTO ${table} (${columns.join(', ')})
      VALUES (${columns.map((column) => `:${column}`).join(', ')})
      RETURNING id
    `;

    const result = await this.#query<{ id: number | string }>(
      sql,
      data,
    );

    const id = result.rows[0]?.id;

    if (id === undefined) {
      throw new Error(`Insert into ${table} did not return an id.`);
    }

    return Number(id);
  }

  async update(
    table: string,
    id: number,
    data: Record<string, unknown>,
  ): Promise<number> {
    const columns = Object.keys(data).filter(
      (key) => data[key] !== undefined && key !== 'id',
    );

    if (!IDENT_RE.test(table)) {
      throw new Error(`Invalid table identifier: ${table}`);
    }

    if (columns.length === 0) return 0;

    for (const column of columns) {
      if (!IDENT_RE.test(column)) {
        throw new Error(`Invalid column identifier: ${column}`);
      }
    }

    const sql = `
      UPDATE ${table}
      SET ${columns.map((column) => `${column} = :${column}`).join(', ')}
      WHERE id = :row_id
    `;

    const result = await this.#query(sql, {
      ...data,
      row_id: id,
    });

    return result.rowCount ?? 0;
  }

  async tx<T>(fn: () => T | Promise<T>): Promise<T> {
    const existing = transactionContext.getStore();

    if (existing) {
      const savepoint = `sp_${existing.depth + 1}`;

      await existing.client.query(`SAVEPOINT ${savepoint}`);

      try {
        const result = await fn();

        await existing.client.query(`RELEASE SAVEPOINT ${savepoint}`);

        return result;
      } catch (error) {
        await existing.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await existing.client.query(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    }

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const result = await transactionContext.run(
        { client, depth: 1 },
        async () => await fn(),
      );

      await client.query('COMMIT');

      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Database rollback failed:', rollbackError);
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
