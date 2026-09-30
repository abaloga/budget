import {
  accountDisplayName,
  addDays,
  addMonthsToMonth,
  monthEnd,
  monthStart,
  parseMoneyInput,
  todayISO,
  type Account,
  type Category,
  type TransactionFilters,
  type TransactionKind,
} from '@budget/core';
import { X } from 'lucide-react';
import * as React from 'react';

import { groupCategories } from '@/components/pickers';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/form';
import { KIND_LABELS, money } from '@/lib/utils';

type Preset = 'all' | 'this-month' | 'last-month' | '30' | '90' | 'ytd' | 'custom';

export function datePreset(preset: Preset): { startDate?: string; endDate?: string } {
  const today = todayISO();
  switch (preset) {
    case 'this-month':
      return { startDate: monthStart(today), endDate: monthEnd(today) };
    case 'last-month': {
      const m = addMonthsToMonth(monthStart(today), -1);
      return { startDate: m, endDate: monthEnd(m) };
    }
    case '30':
      return { startDate: addDays(today, -29), endDate: today };
    case '90':
      return { startDate: addDays(today, -89), endDate: today };
    case 'ytd':
      return { startDate: `${today.slice(0, 4)}-01-01`, endDate: today };
    default:
      return {};
  }
}

function currentPreset(f: TransactionFilters): Preset {
  if (!f.startDate && !f.endDate) return 'all';
  for (const p of ['this-month', 'last-month', '30', '90', 'ytd'] as const) {
    const r = datePreset(p);
    if (r.startDate === f.startDate && r.endDate === f.endDate) return p;
  }
  return 'custom';
}

const centsToText = (c: number | undefined) => (c == null ? '' : String(c / 100));

export function FiltersPanel({
  filters,
  onChange,
  categories,
  accounts,
}: {
  filters: TransactionFilters;
  onChange: (f: TransactionFilters) => void;
  categories: Category[];
  accounts: Account[];
}) {
  const preset = currentPreset(filters);
  const [custom, setCustom] = React.useState(preset === 'custom');
  const set = (patch: Partial<TransactionFilters>) => onChange({ ...filters, ...patch });

  const categoryValue = filters.uncategorized ? '__none' : (filters.categoryIds?.[0] ?? '');

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Date" htmlFor="f-date">
        <Select
          id="f-date"
          value={custom ? 'custom' : preset}
          onChange={(e) => {
            const p = e.target.value as Preset;
            setCustom(p === 'custom');
            if (p !== 'custom') set({ startDate: undefined, endDate: undefined, ...datePreset(p) });
          }}
        >
          <option value="all">All time</option>
          <option value="this-month">This month</option>
          <option value="last-month">Last month</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="ytd">Year to date</option>
          <option value="custom">Custom range…</option>
        </Select>
      </Field>
      {custom && (
        <div className="grid grid-cols-2 gap-2 sm:col-span-1 lg:col-span-1">
          <Field label="From" htmlFor="f-from">
            <Input
              id="f-from"
              type="date"
              value={filters.startDate ?? ''}
              onChange={(e) => set({ startDate: e.target.value || undefined })}
            />
          </Field>
          <Field label="To" htmlFor="f-to">
            <Input
              id="f-to"
              type="date"
              value={filters.endDate ?? ''}
              onChange={(e) => set({ endDate: e.target.value || undefined })}
            />
          </Field>
        </div>
      )}
      <Field label="Category" htmlFor="f-cat">
        <Select
          id="f-cat"
          value={categoryValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '__none') set({ uncategorized: true, categoryIds: undefined });
            else set({ uncategorized: undefined, categoryIds: v ? [v] : undefined });
          }}
        >
          <option value="">All categories</option>
          <option value="__none">Uncategorized</option>
          {groupCategories(categories).flatMap(({ top, children }) => [
            <option key={top.id} value={top.id}>
              {top.name}
            </option>,
            ...children.map((c) => (
              <option key={c.id} value={c.id}>
                {`\u00a0\u00a0\u00a0${c.name}`}
              </option>
            )),
          ])}
        </Select>
      </Field>
      <Field label="Account" htmlFor="f-acct">
        <Select
          id="f-acct"
          value={filters.accountIds?.[0] ?? ''}
          onChange={(e) => set({ accountIds: e.target.value ? [e.target.value] : undefined })}
        >
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {accountDisplayName(a)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Type" htmlFor="f-kind">
        <Select
          id="f-kind"
          value={filters.kinds?.[0] ?? ''}
          onChange={(e) => set({ kinds: e.target.value ? [e.target.value as TransactionKind] : undefined })}
        >
          <option value="">All types</option>
          <option value="expense">Expenses</option>
          <option value="income">Income</option>
          <option value="transfer">Transfers</option>
        </Select>
      </Field>
      <Field label="Status" htmlFor="f-status">
        <Select
          id="f-status"
          value={filters.status ?? ''}
          onChange={(e) => set({ status: (e.target.value || undefined) as TransactionFilters['status'] })}
        >
          <option value="">Pending and posted</option>
          <option value="pending">Pending only</option>
          <option value="posted">Posted only</option>
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Min amount" htmlFor="f-min">
          <Input
            id="f-min"
            inputMode="decimal"
            placeholder="0"
            defaultValue={centsToText(filters.minAmountCents)}
            onBlur={(e) =>
              set({ minAmountCents: e.target.value ? Math.abs(parseMoneyInput(e.target.value) ?? 0) : undefined })
            }
          />
        </Field>
        <Field label="Max amount" htmlFor="f-max">
          <Input
            id="f-max"
            inputMode="decimal"
            placeholder="Any"
            defaultValue={centsToText(filters.maxAmountCents)}
            onBlur={(e) =>
              set({ maxAmountCents: e.target.value ? Math.abs(parseMoneyInput(e.target.value) ?? 0) : undefined })
            }
          />
        </Field>
      </div>
    </div>
  );
}

/** Removable chips for each active filter. */
export function FilterChips({
  filters,
  onChange,
  categories,
  accounts,
}: {
  filters: TransactionFilters;
  onChange: (f: TransactionFilters) => void;
  categories: Category[];
  accounts: Account[];
}) {
  const chips: { key: string; label: string; clear: Partial<TransactionFilters> }[] = [];
  if (filters.startDate || filters.endDate)
    chips.push({
      key: 'date',
      label: `${filters.startDate ?? '…'} → ${filters.endDate ?? '…'}`,
      clear: { startDate: undefined, endDate: undefined },
    });
  if (filters.categoryIds?.length)
    chips.push({
      key: 'cat',
      label: filters.categoryIds.map((id) => categories.find((c) => c.id === id)?.name ?? 'Category').join(', '),
      clear: { categoryIds: undefined },
    });
  if (filters.uncategorized) chips.push({ key: 'uncat', label: 'Uncategorized', clear: { uncategorized: undefined } });
  if (filters.accountIds?.length)
    chips.push({
      key: 'acct',
      label: filters.accountIds
        .map((id) => {
          const a = accounts.find((x) => x.id === id);
          return a ? accountDisplayName(a) : 'Account';
        })
        .join(', '),
      clear: { accountIds: undefined },
    });
  if (filters.kinds?.length)
    chips.push({
      key: 'kind',
      label: filters.kinds.map((k) => KIND_LABELS[k]).join(', '),
      clear: { kinds: undefined },
    });
  if (filters.status)
    chips.push({
      key: 'status',
      label: filters.status === 'pending' ? 'Pending' : 'Posted',
      clear: { status: undefined },
    });
  if (filters.minAmountCents != null || filters.maxAmountCents != null)
    chips.push({
      key: 'amount',
      label: `${filters.minAmountCents != null ? money(filters.minAmountCents) : '$0'} – ${filters.maxAmountCents != null ? money(filters.maxAmountCents) : 'any'}`,
      clear: { minAmountCents: undefined, maxAmountCents: undefined },
    });
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((c) => (
        <span
          key={c.key}
          className="inline-flex items-center gap-1 rounded-full bg-accent-wash py-1 pr-1 pl-3 text-xs font-medium text-accent"
        >
          {c.label}
          <button
            type="button"
            aria-label={`Remove filter ${c.label}`}
            className="rounded-full p-0.5 hover:bg-accent/15"
            onClick={() => onChange({ ...filters, ...c.clear })}
          >
            <X className="size-3.5" />
          </button>
        </span>
      ))}
      <Button size="sm" variant="ghost" onClick={() => onChange(filters.search ? { search: filters.search } : {})}>
        Clear all
      </Button>
    </div>
  );
}
