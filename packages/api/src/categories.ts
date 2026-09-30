import { categoryFromRow, type Category, type CategoryKind, type CategoryRow, type MonthStart } from '@budget/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import { unwrap } from './errors.ts';

export const CATEGORY_COLUMNS =
  'id, parent_id, name, kind, system_key, color, sort_order, rollover_enabled, rollover_start_month, is_archived';

export interface CategoryInput {
  name: string;
  parentId?: string | null;
  kind?: CategoryKind;
  color?: string | null;
}

export interface CategoryPatch {
  name?: string;
  color?: string | null;
  parentId?: string | null;
  isArchived?: boolean;
  rolloverEnabled?: boolean;
  rolloverStartMonth?: MonthStart | null;
}

export function categoriesApi(sb: SupabaseClient) {
  return {
    async list(): Promise<Category[]> {
      const rows = unwrap(
        await sb.from('categories').select(CATEGORY_COLUMNS).order('sort_order').order('name'),
      ) as CategoryRow[];
      return rows.map(categoryFromRow);
    },

    async create(input: CategoryInput, existing: readonly Category[]): Promise<Category> {
      const siblings = existing.filter((c) => c.parentId === (input.parentId ?? null));
      const parent = input.parentId ? existing.find((c) => c.id === input.parentId) : undefined;
      const sortOrder = siblings.length
        ? Math.max(...siblings.map((c) => c.sortOrder)) + 1
        : (parent?.sortOrder ?? existing.reduce((m, c) => Math.max(m, c.sortOrder), 0)) + 1;
      const row = unwrap(
        await sb
          .from('categories')
          .insert({
            name: input.name.trim(),
            parent_id: input.parentId ?? null,
            kind: parent?.kind ?? input.kind ?? 'expense',
            color: input.color ?? parent?.color ?? null,
            sort_order: sortOrder,
          })
          .select(CATEGORY_COLUMNS)
          .single(),
      ) as CategoryRow;
      return categoryFromRow(row);
    },

    async update(id: string, patch: CategoryPatch): Promise<void> {
      const row: Record<string, unknown> = {};
      if (patch.name !== undefined) row.name = patch.name.trim();
      if (patch.color !== undefined) row.color = patch.color;
      if (patch.parentId !== undefined) row.parent_id = patch.parentId;
      if (patch.isArchived !== undefined) row.is_archived = patch.isArchived;
      if (patch.rolloverEnabled !== undefined) row.rollover_enabled = patch.rolloverEnabled;
      if (patch.rolloverStartMonth !== undefined) row.rollover_start_month = patch.rolloverStartMonth;
      unwrap(await sb.from('categories').update(row).eq('id', id));
    },

    /** Persist a new order: ids in display order (sort_order = index). */
    async reorder(orderedIds: readonly string[]): Promise<void> {
      const results = await Promise.all(
        orderedIds.map((id, index) =>
          sb
            .from('categories')
            .update({ sort_order: (index + 1) * 10 })
            .eq('id', id),
        ),
      );
      for (const r of results) unwrap(r);
    },

    /** Only succeeds for categories that nothing references; otherwise archive. */
    async remove(id: string): Promise<void> {
      unwrap(await sb.from('categories').delete().eq('id', id));
    },
  };
}
