import type { Cents } from './types.ts';

/** Convert a decimal currency amount (e.g. from a provider API) to integer cents. */
export function toCents(amount: number): Cents {
  if (!Number.isFinite(amount)) throw new RangeError(`Invalid amount: ${amount}`);
  const cents = Math.round(amount * 100);
  return cents === 0 ? 0 : cents; // normalize -0
}

export function fromCents(cents: Cents): number {
  return cents / 100;
}

export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/**
 * Parse user-typed money ("1,234.56", "$12", "-5.5", "(20.00)").
 * Returns null when the input isn't a valid amount.
 */
export function parseMoneyInput(input: string): Cents | null {
  let s = input.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  }
  s = s.replace(/^\$/, '').replace(/,/g, '').trim();
  if (!/^\d+(\.\d{0,2})?$|^\.\d{1,2}$/.test(s)) return null;
  const [whole = '0', frac = ''] = s.split('.');
  const cents = Number(whole || '0') * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return null;
  return negative && cents !== 0 ? -cents : cents;
}

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(currency: string, fractionDigits: 0 | 2, signDisplay: 'auto' | 'always' | 'never') {
  const key = `${currency}|${fractionDigits}|${signDisplay}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
      signDisplay,
    });
    formatters.set(key, f);
  }
  return f;
}

export interface FormatMoneyOptions {
  currency?: string;
  /** Drop cents (e.g. chart axes, large summary numbers). */
  whole?: boolean;
  /** 'always' shows +/-; 'never' shows magnitude only. */
  sign?: 'auto' | 'always' | 'never';
}

export function formatMoney(cents: Cents, options: FormatMoneyOptions = {}): string {
  const { currency = 'USD', whole = false, sign = 'auto' } = options;
  return formatter(currency, whole ? 0 : 2, sign).format(whole ? Math.round(cents / 100) : cents / 100);
}

/** Ratio of part to whole, or null when whole is zero. */
export function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

/** Split `total` into `n` integer parts that differ by at most one cent and sum exactly to total. */
export function splitEvenly(total: Cents, n: number): Cents[] {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError('n must be a positive integer');
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const base = Math.floor(abs / n);
  const remainder = abs - base * n;
  return Array.from({ length: n }, (_, i) => sign * (base + (i < remainder ? 1 : 0)));
}
