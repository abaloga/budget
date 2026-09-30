import {
  categoryMonthTotalFromRow,
  merchantTotalFromRow,
  type CategoryMonthTotal,
  type CategoryMonthTotalRow,
  type ISODate,
  type MerchantTotal,
  type MerchantTotalRow,
} from '@budget/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import { unwrap } from './errors.ts';

/** Aggregates computed in SQL (group + sum only); meaning is applied in @budget/core. */
export function reportsApi(sb: SupabaseClient) {
  return {
    async categoryMonthTotals(start: ISODate, end: ISODate): Promise<CategoryMonthTotal[]> {
      const rows = unwrap(
        await sb.rpc('category_month_totals', { p_start: start, p_end: end }),
      ) as CategoryMonthTotalRow[];
      return rows.map(categoryMonthTotalFromRow);
    },

    async merchantTotals(start: ISODate, end: ISODate): Promise<MerchantTotal[]> {
      const rows = unwrap(await sb.rpc('merchant_totals', { p_start: start, p_end: end })) as MerchantTotalRow[];
      return rows.map(merchantTotalFromRow);
    },
  };
}
