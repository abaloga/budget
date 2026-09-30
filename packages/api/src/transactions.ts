import {
  addDays,
  kindAfterCategoryChange,
  normalizeMerchant,
  planRetroactiveRule,
  transactionWithSplitsFromRow,
  type CategorizationRule,
  type Category,
  type Cents,
  type ISODate,
  type Split,
  type SplitRow,
  type TransactionFilters,
  type TransactionKind,
  type TransactionRow,
  type TransactionSort,
  type TransactionWithSplits,
} from '@budget/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import { ApiError, unwrap } from './errors.ts';

export const TRANSACTION_COLUMNS =
  'id, account_id, source, name, date, amount_cents, iso_currency_code, pending, merchant_key, original_name, ' +
  'original_merchant_name, original_date, name_override, date_override, notes, category_id, category_source, kind, ' +
  'kind_source, transfer_pair_id, recurring_id, provider_category_primary, provider_category_detailed, created_at, updated_at';

const WITH_SPLITS = `${TRANSACTION_COLUMNS}, transaction_splits(id, category_id, amount_cents, notes, sort_order)`;

type Row = TransactionRow & { transaction_splits?: SplitRow[] | null };

function filtersToRpc(f: TransactionFilters): Record<string, unknown> {
  return {
    search: f.search?.trim() || undefined,
    category_ids: f.categoryIds?.length ? f.categoryIds : undefined,
    uncategorized: f.uncategorized || undefined,
    account_ids: f.accountIds?.length ? f.accountIds : undefined,
    start_date: f.startDate,
    end_date: f.endDate,
    min_amount_cents: f.minAmountCents,
    max_amount_cents: f.maxAmountCents,
    status: f.status,
    kinds: f.kinds?.length ? f.kinds : undefined,
  };
}

export interface SearchOptions {
  filters?: TransactionFilters;
  sort?: TransactionSort;
  page?: number;
  pageSize?: number;
}

export interface ManualTransactionInput {
  accountId: string | null;
  name: string;
  date: ISODate;
  amountCents: Cents;
  categoryId?: string | null;
  kind?: TransactionKind;
  notes?: string | null;
}

/** Edits allowed on any transaction; stored as overrides for imported ones. */
export interface TransactionEdit {
  name?: string | null;
  date?: ISODate | null;
  notes?: string | null;
}

export function transactionsApi(sb: SupabaseClient) {
  const api = {
    async search(opts: SearchOptions = {}): Promise<{ rows: TransactionWithSplits[]; total: number }> {
      const page = opts.page ?? 0;
      const pageSize = opts.pageSize ?? 50;
      const sort = opts.sort ?? { field: 'date', descending: true };
      const res = await sb
        .rpc(
          'search_transactions',
          { p_filters: filtersToRpc(opts.filters ?? {}), p_sort: sort.field, p_desc: sort.descending },
          { count: 'exact' },
        )
        .select(WITH_SPLITS)
        .range(page * pageSize, page * pageSize + pageSize - 1);
      const rows = unwrap(res) as unknown as Row[];
      return { rows: rows.map(transactionWithSplitsFromRow), total: res.count ?? rows.length };
    },

    async recent(limit = 8): Promise<TransactionWithSplits[]> {
      const rows = unwrap(
        await sb
          .from('transactions')
          .select(WITH_SPLITS)
          .order('date', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(limit),
      ) as unknown as Row[];
      return rows.map(transactionWithSplitsFromRow);
    },

    async get(id: string): Promise<TransactionWithSplits> {
      const row = unwrap(await sb.from('transactions').select(WITH_SPLITS).eq('id', id).single()) as unknown as Row;
      return transactionWithSplitsFromRow(row);
    },

    /** Name/date/notes edits. For imported transactions these are overrides; raw data is untouched. */
    async edit(tx: Pick<TransactionWithSplits, 'id' | 'source'>, edit: TransactionEdit): Promise<void> {
      const patch: Record<string, unknown> = {};
      if (tx.source === 'manual') {
        if (edit.name != null) {
          patch.original_name = edit.name.trim();
          patch.merchant_key = normalizeMerchant(edit.name);
        }
        if (edit.date != null) patch.original_date = edit.date;
      } else {
        if (edit.name !== undefined) patch.name_override = edit.name?.trim() || null;
        if (edit.date !== undefined) patch.date_override = edit.date || null;
      }
      if (edit.notes !== undefined) patch.notes = edit.notes?.trim() || null;
      if (Object.keys(patch).length) unwrap(await sb.from('transactions').update(patch).eq('id', tx.id));
    },

    /** Amount can only change on manual transactions (imported amounts are authoritative). */
    async setManualAmount(
      tx: Pick<TransactionWithSplits, 'id' | 'source' | 'splits'>,
      amountCents: Cents,
    ): Promise<void> {
      if (tx.source !== 'manual')
        throw new ApiError('Imported amounts come from your bank and can’t be edited.', 'read_only');
      if (tx.splits.length) {
        throw new ApiError('Remove the split before changing the amount.', 'split_exists');
      }
      unwrap(await sb.from('transactions').update({ amount_cents: amountCents }).eq('id', tx.id));
    },

    /** User picks a category: recorded as an explicit choice (feeds merchant history). */
    async setCategory(
      tx: Pick<TransactionWithSplits, 'id' | 'kind' | 'kindSource'>,
      category: Pick<Category, 'id' | 'kind'> | null,
    ): Promise<void> {
      const next = kindAfterCategoryChange(tx, category);
      unwrap(
        await sb
          .from('transactions')
          .update({
            category_id: category?.id ?? null,
            category_source: category ? 'user' : 'none',
            kind: next.kind,
            kind_source: next.kindSource,
          })
          .eq('id', tx.id),
      );
    },

    /** Mark as expense / income / transfer (explicit user decision). */
    async setKind(id: string, kind: TransactionKind): Promise<void> {
      unwrap(await sb.rpc('set_transaction_kind', { p_id: id, p_kind: kind }));
    },

    async setSplits(id: string, splits: readonly Split[]): Promise<void> {
      unwrap(
        await sb.rpc('set_transaction_splits', {
          p_transaction_id: id,
          p_splits: splits.map((s) => ({
            category_id: s.categoryId,
            amount_cents: s.amountCents,
            notes: s.notes ?? null,
          })),
        }),
      );
    },

    async linkTransfer(a: string, b: string): Promise<void> {
      unwrap(await sb.rpc('link_transfer', { p_a: a, p_b: b }));
    },

    /** Possible other sides of a transfer: opposite amount, different account, within ±7 days. */
    async transferCandidates(tx: Pick<TransactionWithSplits, 'id' | 'amountCents' | 'date' | 'accountId'>) {
      let q = sb
        .from('transactions')
        .select(TRANSACTION_COLUMNS)
        .eq('amount_cents', -tx.amountCents)
        .gte('date', addDays(tx.date, -7))
        .lte('date', addDays(tx.date, 7))
        .is('transfer_pair_id', null)
        .neq('id', tx.id)
        .limit(10);
      if (tx.accountId) q = q.neq('account_id', tx.accountId);
      const rows = unwrap(await q) as unknown as Row[];
      return rows.map(transactionWithSplitsFromRow);
    },

    async createManual(input: ManualTransactionInput): Promise<string> {
      const row = unwrap(
        await sb
          .from('transactions')
          .insert({
            source: 'manual',
            account_id: input.accountId,
            original_name: input.name.trim(),
            original_date: input.date,
            amount_cents: input.amountCents,
            merchant_key: normalizeMerchant(input.name),
            category_id: input.categoryId ?? null,
            category_source: input.categoryId ? 'user' : 'none',
            kind: input.kind ?? (input.amountCents > 0 ? 'income' : 'expense'),
            kind_source: input.kind ? 'user' : 'auto',
            notes: input.notes?.trim() || null,
          })
          .select('id')
          .single(),
      ) as { id: string };
      return row.id;
    },

    async deleteManual(id: string): Promise<void> {
      const res = unwrap(
        await sb.from('transactions').delete().eq('id', id).eq('source', 'manual').select('id'),
      ) as unknown[];
      if (!res.length) throw new ApiError('Only manually added transactions can be deleted.', 'read_only');
    },

    /**
     * Apply a rule to existing transactions (never overriding explicit user
     * choices). Returns the number of transactions changed.
     */
    async applyRuleRetroactively(rule: CategorizationRule): Promise<number> {
      const filters: TransactionFilters = {};
      if (rule.nameValue) filters.search = rule.nameValue;
      if (rule.accountId) filters.accountIds = [rule.accountId];
      const candidates: TransactionWithSplits[] = [];
      for (let page = 0; page < 50; page++) {
        const { rows } = await api.search({ filters, page, pageSize: 500 });
        candidates.push(...rows);
        if (rows.length < 500) break;
      }
      const updates = planRetroactiveRule(rule, candidates);

      // Group identical patches into one request each.
      const groups = new Map<string, { patch: Record<string, unknown>; ids: string[] }>();
      for (const u of updates) {
        const patch: Record<string, unknown> = {};
        if (u.categoryId !== undefined) {
          patch.category_id = u.categoryId;
          patch.category_source = u.categorySource;
        }
        if (u.kind !== undefined) {
          patch.kind = u.kind;
          patch.kind_source = u.kindSource;
        }
        const key = JSON.stringify(patch);
        const g = groups.get(key) ?? { patch, ids: [] };
        g.ids.push(u.id);
        groups.set(key, g);
      }
      for (const { patch, ids } of groups.values()) {
        for (let i = 0; i < ids.length; i += 200) {
          unwrap(
            await sb
              .from('transactions')
              .update(patch)
              .in('id', ids.slice(i, i + 200)),
          );
        }
      }
      return updates.length;
    },
  };
  return api;
}
