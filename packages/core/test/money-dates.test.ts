import { describe, expect, it } from 'vitest';

import {
  addMonths,
  daysBetween,
  formatMoney,
  isISODate,
  monthDiff,
  monthEnd,
  monthsInRange,
  parseMoneyInput,
  splitEvenly,
  toCents,
} from '../src/index.ts';

describe('money', () => {
  it('converts provider decimals to integer cents without float drift', () => {
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(-4.35)).toBe(-435);
    expect(Object.is(toCents(-0), 0)).toBe(true);
  });

  it('parses user-typed amounts', () => {
    expect(parseMoneyInput('1,234.56')).toBe(123456);
    expect(parseMoneyInput('$12')).toBe(1200);
    expect(parseMoneyInput('-5.5')).toBe(-550);
    expect(parseMoneyInput('(20.00)')).toBe(-2000);
    expect(parseMoneyInput('.5')).toBe(50);
    expect(parseMoneyInput('12.345')).toBeNull();
    expect(parseMoneyInput('abc')).toBeNull();
    expect(parseMoneyInput('')).toBeNull();
  });

  it('formats cents', () => {
    expect(formatMoney(123456)).toBe('$1,234.56');
    expect(formatMoney(-500)).toBe('-$5.00');
    expect(formatMoney(123456, { whole: true })).toBe('$1,235');
    expect(formatMoney(-500, { sign: 'never' })).toBe('$5.00');
  });

  it('splits evenly with the remainder distributed', () => {
    expect(splitEvenly(1000, 3)).toEqual([334, 333, 333]);
    expect(splitEvenly(-1000, 3)).toEqual([-334, -333, -333]);
    expect(splitEvenly(1000, 3).reduce((a, b) => a + b)).toBe(1000);
  });
});

describe('dates', () => {
  it('validates ISO dates', () => {
    expect(isISODate('2026-02-28')).toBe(true);
    expect(isISODate('2026-02-30')).toBe(false);
    expect(isISODate('2026-2-3')).toBe(false);
  });

  it('adds months with clamping and anchor days', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-02-28', 1, 31)).toBe('2026-03-31');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
    expect(addMonths('2026-03-15', -3)).toBe('2025-12-15');
  });

  it('computes month boundaries and ranges', () => {
    expect(monthEnd('2026-02-10')).toBe('2026-02-28');
    expect(monthsInRange('2026-11-20', '2027-02-03')).toEqual(['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01']);
    expect(monthDiff('2026-09-29', '2027-03-01')).toBe(6);
  });

  it('counts days across DST changes correctly', () => {
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetween('2026-11-01', '2026-10-31')).toBe(-1);
  });
});
