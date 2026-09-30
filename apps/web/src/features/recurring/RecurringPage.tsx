import type { RecurringInput } from '@budget/api';
import {
  FREQUENCIES,
  FREQUENCY_LABELS,
  accountDisplayName,
  formatShortDate,
  monthlyEquivalent,
  parseMoneyInput,
  todayISO,
  upcomingBills,
  type Account,
  type Category,
  type RecurringFrequency,
  type RecurringSeries,
} from '@budget/core';
import * as Tabs from '@radix-ui/react-tabs';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Eye, EyeOff, Pencil, Plus, RefreshCw, Repeat, Trash } from 'lucide-react';
import * as React from 'react';

import { AccountSelect, CategorySelect, useCategoryLookup } from '@/components/pickers';
import { UpcomingList } from '@/components/UpcomingList';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Segmented, Select, Textarea } from '@/components/ui/form';
import { ActionMenu } from '@/components/ui/menu';
import { Badge, EmptyState, ErrorState, PageHeader, PageLoader, StatusNote } from '@/components/ui/misc';
import { invalidateAll, keys, useAccounts, useCategories, useRecurring } from '@/hooks/queries';
import { api } from '@/lib/supabase';
import { errorMessage, money } from '@/lib/utils';

const tabClass =
  'rounded-control px-3 py-1.5 text-sm font-medium text-ink-3 data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-sm';

export default function RecurringPage() {
  const qc = useQueryClient();
  const recurring = useRecurring();
  const categories = useCategories();
  const accounts = useAccounts();
  const lookup = useCategoryLookup(categories.data);
  const [editing, setEditing] = React.useState<RecurringSeries | 'new' | null>(null);
  const [scanning, setScanning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const today = todayISO();
  const series = recurring.data ?? [];
  const active = series.filter((s) => s.status === 'active');
  const ignored = series.filter((s) => s.status === 'ignored');
  const upcoming = upcomingBills(active, today, { horizonDays: 30, soonDays: 3 });
  const monthlyBills = active
    .filter((s) => s.kind === 'expense')
    .reduce((sum, s) => sum + monthlyEquivalent(s.expectedAmountCents, s.frequency), 0);
  const accountName = (id: string | null) => {
    const a = accounts.data?.find((x) => x.id === id);
    return a ? accountDisplayName(a) : null;
  };

  async function act(fn: () => Promise<unknown>) {
    try {
      setError(null);
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      void qc.invalidateQueries({ queryKey: keys.recurring });
    }
  }

  async function scan() {
    setScanning(true);
    await act(() => api.plaid.rescan());
    invalidateAll(qc);
    setScanning(false);
  }

  const seriesActions = (s: RecurringSeries) => [
    { label: 'Edit', icon: <Pencil />, onSelect: () => setEditing(s) },
    s.status === 'active'
      ? { label: 'Ignore', icon: <EyeOff />, onSelect: () => void act(() => api.recurring.setStatus(s.id, 'ignored')) }
      : {
          label: 'Track again',
          icon: <Eye />,
          onSelect: () => void act(() => api.recurring.setStatus(s.id, 'active')),
        },
    {
      label: 'Delete',
      icon: <Trash />,
      danger: true,
      onSelect: () => {
        if (
          window.confirm(
            `Delete “${s.name}”? If it was detected automatically and still recurs, it may be detected again — use Ignore to prevent that.`,
          )
        )
          void act(() => api.recurring.remove(s.id));
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Recurring"
        description={
          active.length ? `About ${money(monthlyBills, { whole: true })} a month in recurring bills` : undefined
        }
        actions={
          <>
            <Button size="sm" onClick={scan} loading={scanning}>
              {!scanning && <RefreshCw />} Scan for recurring
            </Button>
            <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
              <Plus /> Add
            </Button>
          </>
        }
      />
      {error && (
        <StatusNote tone="bad" className="mb-4">
          {error}
        </StatusNote>
      )}
      {recurring.error && <ErrorState error={recurring.error} onRetry={() => void recurring.refetch()} />}

      {recurring.isLoading ? (
        <PageLoader />
      ) : (
        <Tabs.Root defaultValue="upcoming">
          <Tabs.List className="mb-4 inline-flex rounded-control bg-surface-2 p-0.5" aria-label="Recurring views">
            <Tabs.Trigger value="upcoming" className={tabClass}>
              Upcoming
            </Tabs.Trigger>
            <Tabs.Trigger value="all" className={tabClass}>
              All ({active.length})
            </Tabs.Trigger>
            <Tabs.Trigger value="ignored" className={tabClass}>
              Ignored ({ignored.length})
            </Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="upcoming">
            <Card className="overflow-hidden">
              {upcoming.length === 0 ? (
                <EmptyState
                  icon={<CalendarClock />}
                  title="No bills expected in the next 30 days"
                  description="Recurring bills are detected automatically from your history, or you can add them yourself."
                />
              ) : (
                <UpcomingList bills={upcoming} lookup={lookup} accountName={accountName} />
              )}
            </Card>
          </Tabs.Content>

          <Tabs.Content value="all">
            <SeriesList
              list={active}
              lookup={lookup}
              accountName={accountName}
              actions={seriesActions}
              empty="No recurring transactions yet."
            />
          </Tabs.Content>
          <Tabs.Content value="ignored">
            <SeriesList
              list={ignored}
              lookup={lookup}
              accountName={accountName}
              actions={seriesActions}
              empty="Nothing ignored."
            />
          </Tabs.Content>
        </Tabs.Root>
      )}

      <RecurringDialog
        series={editing === 'new' ? null : editing}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        categories={categories.data ?? []}
        accounts={accounts.data ?? []}
      />
    </>
  );
}

function SeriesList({
  list,
  lookup,
  accountName,
  actions,
  empty,
}: {
  list: RecurringSeries[];
  lookup: ReturnType<typeof useCategoryLookup>;
  accountName: (id: string | null) => string | null;
  actions: (s: RecurringSeries) => Parameters<typeof ActionMenu>[0]['items'];
  empty: string;
}) {
  if (!list.length)
    return (
      <Card>
        <EmptyState icon={<Repeat />} title={empty} />
      </Card>
    );
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-line">
        {[...list]
          .sort((a, b) => (a.nextDate ?? '9999').localeCompare(b.nextDate ?? '9999'))
          .map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 truncate text-sm font-medium">
                  {s.name}
                  {s.kind === 'income' && <Badge tone="good">Income</Badge>}
                  {s.source === 'detected' && <Badge tone="outline">Detected</Badge>}
                </p>
                <p className="truncate text-xs text-ink-3">
                  {FREQUENCY_LABELS[s.frequency]}
                  {s.nextDate && ` · next ${formatShortDate(s.nextDate, new Date().getFullYear())}`}
                  {lookup.label(s.categoryId) && ` · ${lookup.label(s.categoryId)}`}
                  {accountName(s.accountId) && ` · ${accountName(s.accountId)}`}
                </p>
              </div>
              <span className="num text-sm font-medium">{money(s.expectedAmountCents)}</span>
              <ActionMenu items={actions(s)} />
            </li>
          ))}
      </ul>
    </Card>
  );
}

function RecurringDialog({
  series,
  open,
  onOpenChange,
  categories,
  accounts,
}: {
  series: RecurringSeries | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  categories: Category[];
  accounts: Account[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={series ? 'Edit recurring' : 'Add recurring'}
        description="Bills, subscriptions and paychecks that repeat."
      >
        <RecurringForm
          series={series}
          categories={categories}
          accounts={accounts}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

const centsText = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2));

function RecurringForm({
  series,
  categories,
  accounts,
  onClose,
}: {
  series: RecurringSeries | null;
  categories: Category[];
  accounts: Account[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = React.useState(series?.name ?? '');
  const [kind, setKind] = React.useState<'expense' | 'income'>(series?.kind ?? 'expense');
  const [frequency, setFrequency] = React.useState<RecurringFrequency>(series?.frequency ?? 'monthly');
  const [amount, setAmount] = React.useState(centsText(series?.expectedAmountCents));
  const [min, setMin] = React.useState(centsText(series?.amountMinCents));
  const [max, setMax] = React.useState(centsText(series?.amountMaxCents));
  const [nextDate, setNextDate] = React.useState(series?.nextDate ?? todayISO());
  const [accountId, setAccountId] = React.useState<string | null>(series?.accountId ?? null);
  const [categoryId, setCategoryId] = React.useState<string | null>(series?.categoryId ?? null);
  const [notes, setNotes] = React.useState(series?.notes ?? '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const expected = parseMoneyInput(amount);
    const lo = min.trim() ? parseMoneyInput(min) : null;
    const hi = max.trim() ? parseMoneyInput(max) : null;
    if (!name.trim()) return setError('Enter a name.');
    if (expected === null) return setError('Enter the expected amount.');
    if (lo !== null && hi !== null && Math.abs(lo) > Math.abs(hi))
      return setError('The minimum must be below the maximum.');
    const input: RecurringInput = {
      name,
      kind,
      frequency,
      expectedAmountCents: Math.abs(expected),
      amountMinCents: lo === null ? null : Math.abs(lo),
      amountMaxCents: hi === null ? null : Math.abs(hi),
      nextDate: nextDate || null,
      accountId,
      categoryId,
      notes,
    };
    setBusy(true);
    try {
      if (series) await api.recurring.update(series.id, input);
      else await api.recurring.create(input);
      void qc.invalidateQueries({ queryKey: keys.recurring });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Segmented
        label="Kind"
        value={kind}
        onChange={setKind}
        options={[
          { value: 'expense', label: 'Bill' },
          { value: 'income', label: 'Income' },
        ]}
      />
      <Field label="Name" htmlFor="rec-name">
        <Input id="rec-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rent" required />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Expected amount" htmlFor="rec-amount">
          <Input
            id="rec-amount"
            inputMode="decimal"
            className="num"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </Field>
        <Field label="Frequency" htmlFor="rec-freq">
          <Select id="rec-freq" value={frequency} onChange={(e) => setFrequency(e.target.value as RecurringFrequency)}>
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {FREQUENCY_LABELS[f]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Usually at least" htmlFor="rec-min" hint="Optional range for variable bills">
          <Input
            id="rec-min"
            inputMode="decimal"
            className="num"
            value={min}
            onChange={(e) => setMin(e.target.value)}
          />
        </Field>
        <Field label="Usually at most" htmlFor="rec-max">
          <Input
            id="rec-max"
            inputMode="decimal"
            className="num"
            value={max}
            onChange={(e) => setMax(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Next expected date" htmlFor="rec-next">
        <Input id="rec-next" type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Account" htmlFor="rec-account">
          <AccountSelect
            id="rec-account"
            accounts={accounts}
            value={accountId}
            onChange={setAccountId}
            noneLabel="Any account"
          />
        </Field>
        <Field label="Category" htmlFor="rec-category">
          <CategorySelect
            id="rec-category"
            categories={categories}
            value={categoryId}
            onChange={setCategoryId}
            noneLabel="None"
          />
        </Field>
      </div>
      <Field label="Notes" htmlFor="rec-notes">
        <Textarea id="rec-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      {series?.source === 'detected' && (
        <p className="text-xs text-ink-3">
          Saving your edits stops automatic detection from changing this bill’s amount or schedule.
        </p>
      )}
      {error && <StatusNote tone="bad">{error}</StatusNote>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>
          Save
        </Button>
      </div>
    </form>
  );
}
