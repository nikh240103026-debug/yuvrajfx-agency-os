import { describe, expect, test } from 'vitest';
import { parseCsv, parseCsvObjects, toCsv } from '../src/server/lib/csv.ts';
import { addMonths, endOfQuarter, periodFor, startOfWeek, todayIn, monthRange, relativeDay } from '../src/shared/dates.ts';
import { firstOccurrence, occurrenceAfter, renderTitle, upcomingOccurrences } from '../src/server/services/recurrence.ts';

describe('CSV', () => {
  test('parses quotes, embedded commas/newlines, CRLF and a BOM', () => {
    const text = '﻿name,notes\r\n"Carter, Liam","Line 1\nLine ""2"""\r\nAva,plain\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ['name', 'notes'],
      ['Carter, Liam', 'Line 1\nLine "2"'],
      ['Ava', 'plain'],
    ]);
  });

  test('normalises headers', () => {
    const { headers, rows } = parseCsvObjects('Full Name,E-mail Address\nAva Collins,ava@x.test');
    expect(headers).toEqual(['full_name', 'e_mail_address']);
    expect(rows[0]).toEqual({ full_name: 'Ava Collins', e_mail_address: 'ava@x.test' });
  });

  test('escapes output and neutralises spreadsheet formulas', () => {
    const csv = toCsv(
      [{ a: '=HYPERLINK("http://evil")', b: 'x,"y"', c: -150.5, d: '-42' }],
      [
        { header: 'A', value: (r) => r.a },
        { header: 'B', value: (r) => r.b },
        { header: 'C', value: (r) => r.c },
        { header: 'D', value: (r) => r.d },
      ],
    );
    expect(csv.startsWith('﻿')).toBe(true);
    const line = csv.split('\r\n')[1];
    expect(line).toBe(`"'=HYPERLINK(""http://evil"")","x,""y""",-150.5,-42`);
  });
});

describe('dates', () => {
  test('month arithmetic clamps to month end', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-02-28', 1, 31)).toBe('2026-03-31');
  });
  test('periods and weeks', () => {
    expect(periodFor('quarter', '2026-11-15')).toMatchObject({ start: '2026-10-01', end: '2026-12-31', label: 'Q4 2026' });
    expect(endOfQuarter('2026-02-10')).toBe('2026-03-31');
    expect(startOfWeek('2026-11-01')).toBe('2026-10-26'); // Sunday → previous Monday
    expect(monthRange('2026-10-15', '2027-01-02')).toEqual(['2026-10', '2026-11', '2026-12', '2027-01']);
    expect(relativeDay('2026-10-28', '2026-10-27')).toBe('tomorrow');
  });
  test('"today" follows the business timezone', () => {
    // 20:00 UTC on 27 Oct is already 28 Oct in India.
    const t = new Date('2026-10-27T20:00:00Z');
    expect(todayIn('Asia/Kolkata', t)).toBe('2026-10-28');
    expect(todayIn('America/New_York', t)).toBe('2026-10-27');
  });
});

describe('recurrence', () => {
  test('monthly on the 31st clamps per month; weekly picks the weekday', () => {
    const monthly = { frequency: 'monthly' as const, interval: 1, weekday: null, month_day: 31, start_date: '2026-01-15' };
    expect(firstOccurrence(monthly)).toBe('2026-01-31');
    expect(occurrenceAfter(monthly, '2026-01-31')).toBe('2026-02-28');
    expect(occurrenceAfter(monthly, '2026-02-28')).toBe('2026-03-31');
    const weekly = { frequency: 'weekly' as const, interval: 1, weekday: 5, month_day: null, start_date: '2026-10-27' };
    expect(upcomingOccurrences(weekly, '2026-10-27', 2)).toEqual(['2026-10-30', '2026-11-06']);
    const quarterly = { frequency: 'quarterly' as const, interval: 1, weekday: null, month_day: 1, start_date: '2026-10-01' };
    expect(upcomingOccurrences(quarterly, '2026-10-02', 2)).toEqual(['2027-01-01', '2027-04-01']);
  });
  test('title placeholders', () => {
    expect(renderTitle('Send {{month}} invoices · {{quarter}}', '2026-11-01')).toBe('Send November 2026 invoices · Q4 2026');
  });
});
