
import { describe, expect, test } from 'vitest';
import { compileSql } from '../src/server/db/postgres.ts';

describe('PostgreSQL SQL compiler', () => {
  test('converts named parameters to PostgreSQL placeholders', () => {
    const result = compileSql(
      'SELECT * FROM clients WHERE id = :id AND status = @status',
      { id: 12, status: 'active' },
    );

    expect(result.sql).toBe(
      'SELECT * FROM clients WHERE id = $1 AND status = $2',
    );
    expect(result.values).toEqual([12, 'active']);
  });

  test('preserves PostgreSQL boolean values', () => {
    const result = compileSql(
      'UPDATE team_members SET is_active = :active WHERE id = :id',
      { active: true, id: 1 },
    );

    expect(result.sql).toBe(
      'UPDATE team_members SET is_active = $1 WHERE id = $2',
    );
    expect(result.values).toEqual([true, 1]);
  });

  test('reuses named parameters', () => {
    const result = compileSql(
      'SELECT * FROM clients WHERE owner_id = :id OR created_by = :id',
      { id: 7 },
    );

    expect(result.sql).toBe(
      'SELECT * FROM clients WHERE owner_id = $1 OR created_by = $1',
    );
    expect(result.values).toEqual([7]);
  });

  test('does not replace parameter-like text inside SQL strings or comments', () => {
    const result = compileSql(
      "SELECT ':name' AS label, id FROM clients -- :ignored\nWHERE id = :id",
      { id: 3 },
    );

    expect(result.sql).toBe(
      "SELECT ':name' AS label, id FROM clients -- :ignored\nWHERE id = $1",
    );
    expect(result.values).toEqual([3]);
  });

  test('converts question-mark placeholders', () => {
    const result = compileSql(
      'SELECT * FROM clients WHERE id = ? AND status = ?',
      [4, 'active'],
    );

    expect(result.sql).toBe(
      'SELECT * FROM clients WHERE id = $1 AND status = $2',
    );
    expect(result.values).toEqual([4, 'active']);
  });

  test('rejects missing named parameters', () => {
    expect(() =>
      compileSql('SELECT * FROM clients WHERE id = :id', {}),
    ).toThrow('Missing SQL parameter: id');
  });

  test('rejects mismatched positional parameter counts', () => {
    expect(() =>
      compileSql(
        'SELECT * FROM clients WHERE id = ? AND status = ?',
        [4],
      ),
    ).toThrow('SQL parameter count mismatch');
  });
});
