import { describe, test, expect } from 'vitest';
import { toCents, fmtCents, fmtMoney, statusBadge, initials, hashString, fmtDate } from './format';

describe('toCents', () => {
  test('converts decimal currency to integer cents', () => {
    expect(toCents(19.99)).toBe(1999);
    expect(toCents('0.05')).toBe(5);
    expect(toCents(0)).toBe(0);
  });

  test('treats junk input as zero', () => {
    expect(toCents('abc')).toBe(0);
    expect(toCents(null)).toBe(0);
    expect(toCents(undefined)).toBe(0);
  });
});

describe('fmtCents / fmtMoney', () => {
  test('formats whole and fractional amounts', () => {
    expect(fmtCents(1500)).toBe('$15.00');
    expect(fmtCents(1599)).toBe('$15.99');
    expect(fmtCents(0)).toBe('$0.00');
  });

  test('groups thousands and keeps the sign', () => {
    expect(fmtCents(1234567)).toBe('$12,345.67');
    expect(fmtCents(-250)).toBe('-$2.50');
  });

  test('supports a custom currency symbol', () => {
    expect(fmtCents(1500, 'P')).toBe('P15.00');
    expect(fmtMoney(2000, 'P')).toBe('P20.00');
  });

  test('treats null / NaN as zero', () => {
    expect(fmtCents(null)).toBe('$0.00');
    expect(fmtCents(NaN)).toBe('$0.00');
  });
});

describe('statusBadge', () => {
  test('maps known statuses to colour classes', () => {
    expect(statusBadge('PAID')).toEqual({ cls: 'badge-green', label: 'PAID' });
    expect(statusBadge('OPEN')).toEqual({ cls: 'badge-amber', label: 'OPEN' });
    expect(statusBadge('VOID')).toEqual({ cls: 'badge-red', label: 'VOID' });
  });

  test('falls back to gray for unknown or empty statuses', () => {
    expect(statusBadge('WEIRD')).toEqual({ cls: 'badge-gray', label: 'WEIRD' });
    expect(statusBadge(undefined)).toEqual({ cls: 'badge-gray', label: '—' });
  });
});

describe('initials', () => {
  test('takes up to two initials, uppercased', () => {
    expect(initials('John Doe')).toBe('JD');
    expect(initials('jane')).toBe('J');
  });

  test('defaults to ? for empty input', () => {
    expect(initials('')).toBe('?');
    expect(initials()).toBe('?');
  });
});

describe('hashString', () => {
  test('is deterministic, non-negative, and changes with input', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).toBeGreaterThanOrEqual(0);
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });
});

describe('fmtDate', () => {
  test('renders an em-dash for empty or invalid dates', () => {
    expect(fmtDate('')).toBe('—');
    expect(fmtDate(null)).toBe('—');
    expect(fmtDate('not-a-date')).toBe('—');
  });

  test('formats a real ISO date as DD/MM/YYYY', () => {
    expect(fmtDate('2026-10-06T08:00:00Z')).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });
});
