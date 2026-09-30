/**
 * Reporting calculations over aggregated lines (category_month_totals /
 * merchant_totals). Every function is pure and platform-agnostic.
 */
import { monthStart } from './dates.ts';
import type { Category, CategoryMonthTotal, Cents, MerchantTotal, MonthStart, TransactionKind } from './types.ts';

export interface CategoryAmount {
  categoryId: string | null;
  name: string;
  color: string | null;
  amountCents: Cents;
  /** Share of the total (0..1). */
  share: number;
}

export interface MonthAmount {
  month: MonthStart;
  amountCents: Cents;
}

export const UNCATEGORIZED_LABEL = 'Uncategorized';

/** Map every category id to its top-level (group) category. */
export function topLevelIndex(categories: readonly Category[]): Map<string, Category> {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const out = new Map<string, Category>();
  for (const c of categories) {
    const top = c.parentId ? (byId.get(c.parentId) ?? c) : c;
    out.set(c.id, top);
  }
  return out;
}

/** Signed amount a line contributes to a kind's total, as a positive number for that kind. */
function kindValue(kind: TransactionKind, totalCents: Cents): Cents {
  return kind === 'expense' ? -totalCents : totalCents;
}

/**
 * Spending (or income) by category, largest first.
 * `level: 'group'` rolls subcategories into their parent group.
 */
export function amountsByCategory(
  totals: readonly CategoryMonthTotal[],
  categories: readonly Category[],
  options: { kind?: 'expense' | 'income'; level?: 'category' | 'group' } = {},
): CategoryAmount[] {
  const kind = options.kind ?? 'expense';
  const level = options.level ?? 'category';
  const byId = new Map(categories.map((c) => [c.id, c]));
  const tops = topLevelIndex(categories);

  const sums = new Map<string | null, Cents>();
  for (const t of totals) {
    if (t.kind !== kind) continue;
    let id: string | null = t.categoryId && byId.has(t.categoryId) ? t.categoryId : null;
    if (id && level === 'group') id = tops.get(id)?.id ?? id;
    sums.set(id, (sums.get(id) ?? 0) + kindValue(kind, t.totalCents));
  }

  const total = [...sums.values()].reduce((a, v) => a + Math.max(v, 0), 0);
  return [...sums.entries()]
    .map(([id, amountCents]) => {
      const c = id ? byId.get(id) : undefined;
      return {
        categoryId: id,
        name: c?.name ?? UNCATEGORIZED_LABEL,
        color: c?.color ?? null,
        amountCents,
        share: total > 0 ? Math.max(amountCents, 0) / total : 0,
      };
    })
    .filter((r) => r.amountCents !== 0)
    .sort((a, b) => b.amountCents - a.amountCents || a.name.localeCompare(b.name));
}

/** Monthly totals of one kind (expense shown positive), zero-filled across `months`. */
export function monthlyTotals(
  totals: readonly CategoryMonthTotal[],
  months: readonly MonthStart[],
  kind: 'expense' | 'income',
  filter?: (t: CategoryMonthTotal) => boolean,
): MonthAmount[] {
  const byMonth = new Map<string, Cents>();
  for (const t of totals) {
    if (t.kind !== kind || (filter && !filter(t))) continue;
    const m = monthStart(t.month);
    byMonth.set(m, (byMonth.get(m) ?? 0) + kindValue(kind, t.totalCents));
  }
  return months.map((month) => ({ month, amountCents: byMonth.get(month) ?? 0 }));
}

/** Monthly spending per category (for trend charts): rows = months, one series per category. */
export function categoryTrend(
  totals: readonly CategoryMonthTotal[],
  categories: readonly Category[],
  months: readonly MonthStart[],
  categoryIds: readonly string[],
  level: 'category' | 'group' = 'group',
): { month: MonthStart; values: Record<string, Cents> }[] {
  const tops = topLevelIndex(categories);
  const wanted = new Set(categoryIds);
  const cell = new Map<string, Cents>();
  for (const t of totals) {
    if (t.kind !== 'expense' || !t.categoryId) continue;
    const id = level === 'group' ? (tops.get(t.categoryId)?.id ?? t.categoryId) : t.categoryId;
    if (!wanted.has(id)) continue;
    const k = `${monthStart(t.month)}|${id}`;
    cell.set(k, (cell.get(k) ?? 0) - t.totalCents);
  }
  return months.map((month) => ({
    month,
    values: Object.fromEntries(categoryIds.map((id) => [id, cell.get(`${month}|${id}`) ?? 0])),
  }));
}

export interface MerchantAmount {
  merchantKey: string;
  name: string;
  amountCents: Cents;
  count: number;
  share: number;
}

/** Top merchants for a kind (spending shown positive). */
export function amountsByMerchant(
  totals: readonly MerchantTotal[],
  kind: 'expense' | 'income',
  limit = 20,
): MerchantAmount[] {
  const rows = totals
    .filter((t) => t.kind === kind)
    .map((t) => ({
      merchantKey: t.merchantKey,
      name: t.name,
      amountCents: kindValue(kind, t.totalCents),
      count: t.lineCount,
    }))
    .filter((r) => r.amountCents > 0)
    .sort((a, b) => b.amountCents - a.amountCents || a.name.localeCompare(b.name));
  const total = rows.reduce((a, r) => a + r.amountCents, 0);
  return rows.slice(0, limit).map((r) => ({ ...r, share: total > 0 ? r.amountCents / total : 0 }));
}

export function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, v) => a + v, 0) / values.length;
}

/** Percent change from previous to current, or null when previous is zero. */
export function percentChange(previous: number, current: number): number | null {
  return previous === 0 ? null : (current - previous) / Math.abs(previous);
}
