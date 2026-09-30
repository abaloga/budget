import {
  addMonthsToMonth,
  budgetFromRow,
  budgetHistoryStart,
  computeBudgetMonth,
  monthEnd,
  monthStart,
  planCopyBudgets,
  type Budget,
  type BudgetMonthView,
  type BudgetRow,
  type Category,
  type Cents,
  type ISODate,
  type MonthStart,
} from '@budget/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import { unwrap } from './errors.ts';
import { reportsApi } from './reports.ts';

export function budgetsApi(sb: SupabaseClient) {
  const reports = reportsApi(sb);

  const api = {
    async list(options: { from?: MonthStart; to?: MonthStart } = {}): Promise<Budget[]> {
      let q = sb.from('budgets').select('category_id, month, amount_cents').order('month');
      if (options.from) q = q.gte('month', options.from);
      if (options.to) q = q.lte('month', options.to);
      return (unwrap(await q) as BudgetRow[]).map(budgetFromRow);
    },

    /** Set a category's budget for a month; 0 removes it. */
    async set(categoryId: string, month: ISODate, amountCents: Cents): Promise<void> {
      const m = monthStart(month);
      if (amountCents <= 0) {
        unwrap(await sb.from('budgets').delete().eq('category_id', categoryId).eq('month', m));
        return;
      }
      unwrap(
        await sb
          .from('budgets')
          .upsert(
            { category_id: categoryId, month: m, amount_cents: amountCents },
            { onConflict: 'user_id,category_id,month' },
          ),
      );
    },

    /** Copy the previous month's budgets into `month` (keeps any already set). Returns count created. */
    async copyFromPreviousMonth(month: ISODate): Promise<number> {
      const target = monthStart(month);
      const source = addMonthsToMonth(target, -1);
      const [from, existing] = await Promise.all([
        api.list({ from: source, to: source }),
        api.list({ from: target, to: target }),
      ]);
      const toCreate = planCopyBudgets(from, existing, target);
      if (toCreate.length) {
        unwrap(
          await sb
            .from('budgets')
            .insert(toCreate.map((b) => ({ category_id: b.categoryId, month: b.month, amount_cents: b.amountCents }))),
        );
      }
      return toCreate.length;
    },

    /**
     * Everything the Budget screen needs for one month, including rollover
     * history. Data is fetched here; all math happens in @budget/core.
     */
    async loadMonth(month: ISODate, categories: readonly Category[]): Promise<BudgetMonthView> {
      const m = monthStart(month);
      const budgets = await api.list({ to: m });
      const start = budgetHistoryStart(categories, m, budgets);
      const totals = await reports.categoryMonthTotals(start, monthEnd(m));
      return computeBudgetMonth({ month: m, categories, budgets, totals });
    },
  };
  return api;
}
