/**
 * Transaction filters. One definition used by every client; the database RPC
 * `search_transactions` implements the same semantics server-side, and
 * `matchesFilters` implements them in memory (optimistic updates, tests).
 * All filters combine with AND.
 */
import type { Cents, ISODate, Split, Transaction, TransactionKind } from './types.ts';

export interface TransactionFilters {
  search?: string;
  categoryIds?: string[];
  uncategorized?: boolean;
  accountIds?: string[];
  startDate?: ISODate;
  endDate?: ISODate;
  /** Magnitude (absolute value), inclusive. */
  minAmountCents?: Cents;
  maxAmountCents?: Cents;
  status?: 'pending' | 'posted';
  kinds?: TransactionKind[];
}

export type TransactionSortField = 'date' | 'amount' | 'name';

export interface TransactionSort {
  field: TransactionSortField;
  descending: boolean;
}

export const DEFAULT_SORT: TransactionSort = { field: 'date', descending: true };

export function matchesFilters(tx: Transaction & { splits?: readonly Split[] }, f: TransactionFilters): boolean {
  const search = f.search?.trim().toLowerCase();
  if (search) {
    const hay = [tx.name, tx.originalName, tx.notes ?? ''].map((s) => s.toLowerCase());
    if (!hay.some((h) => h.includes(search))) return false;
  }
  const splits = tx.splits ?? [];
  if (f.categoryIds?.length) {
    const wanted = new Set(f.categoryIds);
    const hit = (tx.categoryId && wanted.has(tx.categoryId)) || splits.some((s) => wanted.has(s.categoryId));
    if (!hit) return false;
  }
  if (f.uncategorized && (tx.categoryId || tx.kind === 'transfer' || splits.length > 0)) return false;
  if (f.accountIds?.length && (!tx.accountId || !f.accountIds.includes(tx.accountId))) return false;
  if (f.startDate && tx.date < f.startDate) return false;
  if (f.endDate && tx.date > f.endDate) return false;
  const magnitude = Math.abs(tx.amountCents);
  if (f.minAmountCents != null && magnitude < f.minAmountCents) return false;
  if (f.maxAmountCents != null && magnitude > f.maxAmountCents) return false;
  if (f.status === 'pending' && !tx.pending) return false;
  if (f.status === 'posted' && tx.pending) return false;
  if (f.kinds?.length && !f.kinds.includes(tx.kind)) return false;
  return true;
}

export function activeFilterCount(f: TransactionFilters): number {
  let n = 0;
  if (f.search?.trim()) n++;
  if (f.categoryIds?.length) n++;
  if (f.uncategorized) n++;
  if (f.accountIds?.length) n++;
  if (f.startDate || f.endDate) n++;
  if (f.minAmountCents != null || f.maxAmountCents != null) n++;
  if (f.status) n++;
  if (f.kinds?.length) n++;
  return n;
}

// URL/deep-link persistence (works with URLSearchParams on web and RN).

export function filtersToParams(f: TransactionFilters, sort?: TransactionSort): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.search?.trim()) p.q = f.search.trim();
  if (f.categoryIds?.length) p.cat = f.categoryIds.join(',');
  if (f.uncategorized) p.uncat = '1';
  if (f.accountIds?.length) p.acct = f.accountIds.join(',');
  if (f.startDate) p.from = f.startDate;
  if (f.endDate) p.to = f.endDate;
  if (f.minAmountCents != null) p.min = String(f.minAmountCents);
  if (f.maxAmountCents != null) p.max = String(f.maxAmountCents);
  if (f.status) p.status = f.status;
  if (f.kinds?.length) p.kind = f.kinds.join(',');
  if (sort && (sort.field !== DEFAULT_SORT.field || sort.descending !== DEFAULT_SORT.descending)) {
    p.sort = `${sort.field}:${sort.descending ? 'desc' : 'asc'}`;
  }
  return p;
}

const KINDS: readonly TransactionKind[] = ['expense', 'income', 'transfer'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function filtersFromParams(get: (key: string) => string | null): {
  filters: TransactionFilters;
  sort: TransactionSort;
} {
  const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : undefined);
  const int = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  const date = (v: string | null) => (v && DATE_RE.test(v) ? v : undefined);
  const status = get('status');
  const kinds = list(get('kind'))?.filter((k): k is TransactionKind => (KINDS as string[]).includes(k));

  const filters: TransactionFilters = {};
  const q = get('q');
  if (q) filters.search = q;
  const cat = list(get('cat'));
  if (cat?.length) filters.categoryIds = cat;
  if (get('uncat') === '1') filters.uncategorized = true;
  const acct = list(get('acct'));
  if (acct?.length) filters.accountIds = acct;
  const from = date(get('from'));
  if (from) filters.startDate = from;
  const to = date(get('to'));
  if (to) filters.endDate = to;
  const min = int(get('min'));
  if (min !== undefined) filters.minAmountCents = min;
  const max = int(get('max'));
  if (max !== undefined) filters.maxAmountCents = max;
  if (status === 'pending' || status === 'posted') filters.status = status;
  if (kinds?.length) filters.kinds = kinds;

  let sort = DEFAULT_SORT;
  const s = get('sort');
  if (s) {
    const [field, dir] = s.split(':');
    if (field === 'date' || field === 'amount' || field === 'name') sort = { field, descending: dir !== 'asc' };
  }
  return { filters, sort };
}
