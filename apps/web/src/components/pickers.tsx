import {
  accountDisplayName,
  addMonthsToMonth,
  formatMonth,
  monthStart,
  todayISO,
  type Account,
  type Category,
  type CategoryKind,
} from '@budget/core';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/form';
import { cn } from '@/lib/utils';

/** Categories grouped for pickers: assignable ones only (leaves + childless top-levels). */
export function groupCategories(
  categories: readonly Category[],
  opts: { kind?: CategoryKind; includeArchived?: boolean } = {},
) {
  const visible = categories.filter(
    (c) => (opts.includeArchived || !c.isArchived) && (!opts.kind || c.kind === opts.kind),
  );
  const tops = visible.filter((c) => !c.parentId).sort((a, b) => a.sortOrder - b.sortOrder);
  return tops.map((top) => ({
    top,
    children: visible.filter((c) => c.parentId === top.id).sort((a, b) => a.sortOrder - b.sortOrder),
  }));
}

export function CategorySelect({
  categories,
  value,
  onChange,
  allowNone = true,
  noneLabel = 'Uncategorized',
  kind,
  id,
  className,
  disabled,
  'aria-label': ariaLabel,
}: {
  categories: readonly Category[];
  value: string | null;
  onChange: (id: string | null) => void;
  allowNone?: boolean;
  noneLabel?: string;
  kind?: CategoryKind;
  id?: string;
  className?: string;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  const groups = groupCategories(categories, kind ? { kind } : {});
  const current = categories.find((c) => c.id === value);
  return (
    <Select
      id={id}
      className={className}
      value={value ?? ''}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value || null)}
    >
      {allowNone && <option value="">{noneLabel}</option>}
      {current?.isArchived && <option value={current.id}>{current.name} (archived)</option>}
      {groups.map(({ top, children }) =>
        children.length === 0 ? (
          <option key={top.id} value={top.id}>
            {top.name}
          </option>
        ) : (
          <optgroup key={top.id} label={top.name}>
            {children.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </optgroup>
        ),
      )}
    </Select>
  );
}

export function AccountSelect({
  accounts,
  value,
  onChange,
  noneLabel = 'No account',
  id,
  className,
}: {
  accounts: readonly Account[];
  value: string | null;
  onChange: (id: string | null) => void;
  noneLabel?: string;
  id?: string;
  className?: string;
}) {
  return (
    <Select id={id} className={className} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{noneLabel}</option>
      {accounts
        .filter((a) => a.isActive || a.id === value)
        .map((a) => (
          <option key={a.id} value={a.id}>
            {accountDisplayName(a)}
          </option>
        ))}
    </Select>
  );
}

export function MonthSwitcher({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  const current = monthStart(todayISO());
  return (
    <div className="flex items-center gap-1">
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Previous month"
        onClick={() => onChange(addMonthsToMonth(month, -1))}
      >
        <ChevronLeft />
      </Button>
      <span className="min-w-36 text-center text-sm font-semibold" aria-live="polite">
        {formatMonth(month)}
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Next month"
        onClick={() => onChange(addMonthsToMonth(month, 1))}
      >
        <ChevronRight />
      </Button>
      {month !== current && (
        <Button size="sm" variant="ghost" onClick={() => onChange(current)}>
          Today
        </Button>
      )}
    </div>
  );
}

export function CategoryDot({ color, className }: { color: string | null | undefined; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2.5 shrink-0 rounded-full', className)}
      style={{ background: color ?? 'var(--ink-3)' }}
    />
  );
}

export function useCategoryLookup(categories: readonly Category[] | undefined) {
  return React.useMemo(() => {
    const byId = new Map((categories ?? []).map((c) => [c.id, c]));
    return {
      byId,
      label(id: string | null | undefined) {
        if (!id) return null;
        const c = byId.get(id);
        if (!c) return null;
        return c.name;
      },
      color(id: string | null | undefined) {
        if (!id) return null;
        const c = byId.get(id);
        if (!c) return null;
        return c.color ?? (c.parentId ? (byId.get(c.parentId)?.color ?? null) : null);
      },
    };
  }, [categories]);
}
