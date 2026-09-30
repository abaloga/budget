import { goalFromRow, type Cents, type GoalRow, type ISODate, type SavingsGoal } from '@budget/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import { unwrap } from './errors.ts';

export interface GoalInput {
  name: string;
  targetCents: Cents;
  currentCents?: Cents;
  accountId?: string | null;
  targetDate?: ISODate | null;
  color?: string | null;
  isArchived?: boolean;
}

function toRow(g: Partial<GoalInput>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (g.name !== undefined) row.name = g.name.trim();
  if (g.targetCents !== undefined) row.target_cents = g.targetCents;
  if (g.currentCents !== undefined) row.current_cents = g.currentCents;
  if (g.accountId !== undefined) row.account_id = g.accountId;
  if (g.targetDate !== undefined) row.target_date = g.targetDate || null;
  if (g.color !== undefined) row.color = g.color;
  if (g.isArchived !== undefined) row.is_archived = g.isArchived;
  return row;
}

export function goalsApi(sb: SupabaseClient) {
  return {
    async list(): Promise<SavingsGoal[]> {
      const rows = unwrap(
        await sb.from('savings_goals').select('*').order('sort_order').order('created_at'),
      ) as GoalRow[];
      return rows.map(goalFromRow);
    },
    async create(input: GoalInput, sortOrder: number): Promise<void> {
      unwrap(await sb.from('savings_goals').insert({ ...toRow(input), sort_order: sortOrder }));
    },
    async update(id: string, patch: Partial<GoalInput>): Promise<void> {
      unwrap(await sb.from('savings_goals').update(toRow(patch)).eq('id', id));
    },
    async remove(id: string): Promise<void> {
      unwrap(await sb.from('savings_goals').delete().eq('id', id));
    },
  };
}
