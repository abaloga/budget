import {
  ruleFromRow,
  type CategorizationRule,
  type Cents,
  type RuleDirection,
  type RuleNameOperator,
  type RuleRow,
  type TransactionKind,
} from '@budget/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import { unwrap } from './errors.ts';

export interface RuleInput {
  isEnabled: boolean;
  priority: number;
  nameOperator: RuleNameOperator | null;
  nameValue: string | null;
  accountId: string | null;
  direction: RuleDirection | null;
  amountMinCents: Cents | null;
  amountMaxCents: Cents | null;
  setCategoryId: string | null;
  setKind: TransactionKind | null;
}

const toRow = (r: Partial<RuleInput>) => {
  const row: Record<string, unknown> = {};
  if (r.isEnabled !== undefined) row.is_enabled = r.isEnabled;
  if (r.priority !== undefined) row.priority = r.priority;
  if (r.nameOperator !== undefined) row.name_operator = r.nameValue?.trim() ? r.nameOperator : null;
  if (r.nameValue !== undefined) row.name_value = r.nameValue?.trim() || null;
  if (r.accountId !== undefined) row.account_id = r.accountId;
  if (r.direction !== undefined) row.direction = r.direction;
  if (r.amountMinCents !== undefined) row.amount_min_cents = r.amountMinCents;
  if (r.amountMaxCents !== undefined) row.amount_max_cents = r.amountMaxCents;
  if (r.setCategoryId !== undefined) row.set_category_id = r.setCategoryId;
  if (r.setKind !== undefined) row.set_kind = r.setKind;
  return row;
};

export function rulesApi(sb: SupabaseClient) {
  return {
    async list(): Promise<CategorizationRule[]> {
      const rows = unwrap(
        await sb.from('categorization_rules').select('*').order('priority').order('created_at'),
      ) as RuleRow[];
      return rows.map(ruleFromRow);
    },

    async create(input: RuleInput): Promise<CategorizationRule> {
      const row = unwrap(await sb.from('categorization_rules').insert(toRow(input)).select('*').single()) as RuleRow;
      return ruleFromRow(row);
    },

    async update(id: string, patch: Partial<RuleInput>): Promise<CategorizationRule> {
      const row = unwrap(
        await sb.from('categorization_rules').update(toRow(patch)).eq('id', id).select('*').single(),
      ) as RuleRow;
      return ruleFromRow(row);
    },

    async remove(id: string): Promise<void> {
      unwrap(await sb.from('categorization_rules').delete().eq('id', id));
    },
  };
}
