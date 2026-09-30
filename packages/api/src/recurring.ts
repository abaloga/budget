import {
  dayOfMonth,
  nextOccurrence,
  recurringFromRow,
  type CategoryKind,
  type Cents,
  type ISODate,
  type RecurringFrequency,
  type RecurringRow,
  type RecurringSeries,
  type Transaction,
} from '@budget/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import { unwrap } from './errors.ts';

export interface RecurringInput {
  name: string;
  frequency: RecurringFrequency;
  expectedAmountCents: Cents;
  amountMinCents?: Cents | null;
  amountMaxCents?: Cents | null;
  kind?: CategoryKind;
  accountId?: string | null;
  categoryId?: string | null;
  nextDate: ISODate | null;
  lastDate?: ISODate | null;
  merchantKey?: string | null;
  notes?: string | null;
}

function toRow(r: Partial<RecurringInput>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (r.name !== undefined) row.name = r.name.trim();
  if (r.frequency !== undefined) row.frequency = r.frequency;
  if (r.expectedAmountCents !== undefined) row.expected_amount_cents = Math.abs(r.expectedAmountCents);
  if (r.amountMinCents !== undefined) row.amount_min_cents = r.amountMinCents;
  if (r.amountMaxCents !== undefined) row.amount_max_cents = r.amountMaxCents;
  if (r.kind !== undefined) row.kind = r.kind;
  if (r.accountId !== undefined) row.account_id = r.accountId;
  if (r.categoryId !== undefined) row.category_id = r.categoryId;
  if (r.nextDate !== undefined) row.next_date = r.nextDate;
  if (r.lastDate !== undefined) row.last_date = r.lastDate;
  if (r.merchantKey !== undefined) row.merchant_key = r.merchantKey;
  if (r.notes !== undefined) row.notes = r.notes?.trim() || null;
  return row;
}

export function recurringApi(sb: SupabaseClient) {
  const api = {
    async list(): Promise<RecurringSeries[]> {
      const rows = unwrap(
        await sb.from('recurring_series').select('*').order('next_date', { nullsFirst: false }),
      ) as RecurringRow[];
      return rows.map(recurringFromRow);
    },

    async create(input: RecurringInput): Promise<RecurringSeries> {
      const row = unwrap(
        await sb
          .from('recurring_series')
          .insert({ ...toRow(input), source: 'manual', status: 'active' })
          .select('*')
          .single(),
      ) as RecurringRow;
      return recurringFromRow(row);
    },

    /** User edits make the series "manual": detection will then only move its dates forward. */
    async update(id: string, patch: Partial<RecurringInput>): Promise<void> {
      unwrap(
        await sb
          .from('recurring_series')
          .update({ ...toRow(patch), source: 'manual' })
          .eq('id', id),
      );
    },

    async setStatus(id: string, status: 'active' | 'ignored'): Promise<void> {
      unwrap(await sb.from('recurring_series').update({ status }).eq('id', id));
    },

    async remove(id: string): Promise<void> {
      unwrap(await sb.from('recurring_series').delete().eq('id', id));
    },

    async transactions(seriesId: string, limit = 12) {
      return unwrap(
        await sb
          .from('transactions')
          .select('id, date, name, amount_cents, pending')
          .eq('recurring_id', seriesId)
          .order('date', { ascending: false })
          .limit(limit),
      ) as { id: string; date: string; name: string; amount_cents: number; pending: boolean }[];
    },

    /** Manually mark a transaction as recurring: creates (or reuses) a series and links it. */
    async markTransaction(
      tx: Pick<Transaction, 'id' | 'name' | 'merchantKey' | 'amountCents' | 'date' | 'accountId' | 'categoryId'>,
      frequency: RecurringFrequency,
    ): Promise<RecurringSeries> {
      const existing = unwrap(
        await sb.from('recurring_series').select('*').eq('merchant_key', tx.merchantKey).maybeSingle(),
      ) as RecurringRow | null;
      const anchor = frequency === 'weekly' || frequency === 'biweekly' ? undefined : dayOfMonth(tx.date);
      const fields: RecurringInput = {
        name: tx.name,
        merchantKey: tx.merchantKey,
        frequency,
        expectedAmountCents: Math.abs(tx.amountCents),
        amountMinCents: Math.abs(tx.amountCents),
        amountMaxCents: Math.abs(tx.amountCents),
        kind: tx.amountCents > 0 ? 'income' : 'expense',
        accountId: tx.accountId,
        categoryId: tx.categoryId,
        lastDate: tx.date,
        nextDate: nextOccurrence(tx.date, frequency, anchor),
      };
      let series: RecurringSeries;
      if (existing) {
        await api.update(existing.id, { ...fields });
        await api.setStatus(existing.id, 'active');
        series = { ...recurringFromRow(existing), status: 'active' };
      } else {
        series = await api.create(fields);
      }
      unwrap(await sb.from('transactions').update({ recurring_id: series.id }).eq('id', tx.id));
      return series;
    },
  };
  return api;
}
