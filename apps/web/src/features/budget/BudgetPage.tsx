import {
  filtersToParams,
  monthEnd,
  monthStart,
  parseMoneyInput,
  todayISO,
  type BudgetMonthSummary,
  type BudgetSection,
  type Category,
  type CategoryBudgetRow,
} from '@budget/core';
import { CircleAlert, Copy, PiggyBank, Repeat, TriangleAlert } from 'lucide-react';
import * as React from 'react';
import { Link, useSearchParams } from 'react-router';

import { StatTile } from '@/components/charts/charts';
import { CategoryDot, MonthSwitcher } from '@/components/pickers';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { ActionMenu } from '@/components/ui/menu';
import { EmptyState, ErrorState, Meter, PageHeader, PageLoader, StatusNote } from '@/components/ui/misc';
import { keys, useBudgetMonth, useCategories, useFinancialMutation } from '@/hooks/queries';
import { api } from '@/lib/supabase';
import { cn, errorMessage, money, percent } from '@/lib/utils';

export default function BudgetPage() {
  const [params, setParams] = useSearchParams();
  const month = monthStart(params.get('month') ?? todayISO());
  const setMonth = (m: string) => setParams(m === monthStart(todayISO()) ? {} : { month: m }, { replace: true });

  const categories = useCategories();
  const view = useBudgetMonth(month, categories.data);
  const [error, setError] = React.useState<string | null>(null);

  const copy = useFinancialMutation((m: string) => api.budgets.copyFromPreviousMonth(m), [keys.budgets]);
  const setBudget = useFinancialMutation(
    (v: { categoryId: string; amountCents: number }) => api.budgets.set(v.categoryId, month, v.amountCents),
    [keys.budgets],
  );
  const setRollover = useFinancialMutation(
    (v: { category: Category; enabled: boolean }) =>
      api.categories.update(v.category.id, {
        rolloverEnabled: v.enabled,
        // Start accruing from this month the first time it's enabled.
        ...(v.enabled && !v.category.rolloverStartMonth ? { rolloverStartMonth: month } : {}),
      }),
    [keys.categories],
  );

  const summary = view.data?.summary;
  const isEmpty = view.data && summary!.budgetedCents === 0 && summary!.rolloverCents === 0;

  return (
    <>
      <PageHeader
        title="Budget"
        actions={
          <>
            <MonthSwitcher month={month} onChange={setMonth} />
            <Button
              size="sm"
              loading={copy.isPending}
              onClick={() =>
                copy.mutate(month, {
                  onError: (e) => setError(errorMessage(e)),
                  onSuccess: (n) =>
                    setError(n === 0 ? 'Nothing to copy — last month had no budgets that aren’t already set.' : null),
                })
              }
            >
              <Copy /> Copy last month
            </Button>
          </>
        }
      />

      {(view.error || categories.error) && (
        <ErrorState error={view.error ?? categories.error} onRetry={() => void view.refetch()} />
      )}
      {error && (
        <StatusNote tone="warn" className="mb-4">
          {error}
        </StatusNote>
      )}

      {!view.data ? (
        <PageLoader />
      ) : (
        <div className={cn('flex flex-col gap-6', view.isPlaceholderData && 'opacity-60')}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Budgeted"
              value={money(summary!.availableCents, { whole: true })}
              detail={
                summary!.rolloverCents !== 0
                  ? `includes ${money(summary!.rolloverCents, { sign: 'always' })} rollover`
                  : 'for this month'
              }
            />
            <StatTile
              label="Spent"
              value={money(summary!.spentCents, { whole: true })}
              detail={`${percent(summary!.percentUsed)} of budget`}
            />
            <StatTile
              label={summary!.remainingCents < 0 ? 'Over budget' : 'Left to spend'}
              value={money(Math.abs(summary!.remainingCents), { whole: true })}
              tone={summary!.remainingCents < 0 ? 'bad' : undefined}
              detail={
                <Meter value={summary!.percentUsed} status={summary!.status} label="Budget used" className="mt-1.5" />
              }
            />
            <StatTile
              label="Income"
              value={money(summary!.incomeCents, { whole: true })}
              detail="received this month"
            />
          </div>

          <BudgetWarnings summary={summary!} />

          {isEmpty && (
            <Card>
              <EmptyState
                icon={<PiggyBank />}
                title="No budget for this month yet"
                description="Type an amount next to any category below, or copy last month’s budget."
              />
            </Card>
          )}

          <Card className="overflow-hidden">
            <div className="hidden grid-cols-[minmax(0,1fr)_8rem_7rem_7rem_2rem] gap-4 border-b border-line px-5 py-2.5 text-xs font-medium text-ink-3 sm:grid">
              <span>Category</span>
              <span className="text-right">Budget</span>
              <span className="text-right">Spent</span>
              <span className="text-right">Remaining</span>
              <span />
            </div>
            {view.data.sections.map((section) => (
              <SectionRows
                key={section.row.categoryId}
                section={section}
                month={month}
                categories={categories.data ?? []}
                onBudget={(categoryId, amountCents) =>
                  setBudget.mutate({ categoryId, amountCents }, { onError: (e) => setError(errorMessage(e)) })
                }
                onRollover={(category, enabled) =>
                  setRollover.mutate({ category, enabled }, { onError: (e) => setError(errorMessage(e)) })
                }
              />
            ))}
            {summary!.uncategorizedSpentCents !== 0 && (
              <div className="flex items-center justify-between border-t border-line px-5 py-3 text-sm">
                <Link
                  to={`/transactions?${new URLSearchParams(filtersToParams({ uncategorized: true, kinds: ['expense'], startDate: month, endDate: monthEnd(month) })).toString()}`}
                  className="text-warn-ink hover:underline"
                >
                  Uncategorized spending — review
                </Link>
                <span className="num font-medium">{money(summary!.uncategorizedSpentCents)}</span>
              </div>
            )}
          </Card>
          <p className="text-xs text-ink-3">
            Budgets only count expenses. Income and transfers between your accounts (like credit card payments) never
            use up a budget.
          </p>
        </div>
      )}
    </>
  );
}

function BudgetWarnings({ summary }: { summary: BudgetMonthSummary }) {
  const notes: React.ReactNode[] = [];
  if (summary.status === 'over' && summary.availableCents > 0) {
    notes.push(
      <StatusNote key="total" tone="bad">
        Total spending is {money(summary.spentCents - summary.availableCents)} over this month’s budget.
      </StatusNote>,
    );
  }
  if (summary.overBudgetCategoryCount > 0) {
    notes.push(
      <StatusNote key="over" tone="bad">
        {summary.overBudgetCategoryCount} {summary.overBudgetCategoryCount === 1 ? 'category is' : 'categories are'}{' '}
        over budget.
      </StatusNote>,
    );
  }
  if (summary.warningCategoryCount > 0) {
    notes.push(
      <StatusNote key="warn" tone="warn">
        {summary.warningCategoryCount} {summary.warningCategoryCount === 1 ? 'category is' : 'categories are'} close to
        the limit.
      </StatusNote>,
    );
  }
  if (!notes.length) return null;
  return <div className="grid gap-2 sm:grid-cols-2">{notes}</div>;
}

function StatusIcon({ status }: { status: CategoryBudgetRow['status'] }) {
  if (status === 'over') return <CircleAlert className="size-3.5 text-bad-ink" aria-label="Over budget" />;
  if (status === 'warning') return <TriangleAlert className="size-3.5 text-warn-ink" aria-label="Close to budget" />;
  return null;
}

function BudgetInput({ row, onSave }: { row: CategoryBudgetRow; onSave: (cents: number) => void }) {
  const initial = row.budgetedCents ? (row.budgetedCents / 100).toFixed(0) : '';
  const [value, setValue] = React.useState(initial);
  const commit = () => {
    const cents = value.trim() ? parseMoneyInput(value) : 0;
    if (cents === null) return setValue(initial);
    if (Math.abs(cents) !== row.budgetedCents) onSave(Math.abs(cents));
  };
  return (
    <div className="relative">
      <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-xs text-ink-3">$</span>
      <Input
        aria-label={`Budget for ${row.name}`}
        inputMode="decimal"
        className="num h-8 pl-5 text-right"
        placeholder="0"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setValue(initial);
        }}
      />
    </div>
  );
}

function SectionRows({
  section,
  month,
  categories,
  onBudget,
  onRollover,
}: {
  section: BudgetSection;
  month: string;
  categories: Category[];
  onBudget: (categoryId: string, cents: number) => void;
  onRollover: (category: Category, enabled: boolean) => void;
}) {
  const { row, children } = section;
  const leafRows = children.length ? children : [row];
  const txLink = (categoryId: string) =>
    `/transactions?${new URLSearchParams(filtersToParams({ categoryIds: [categoryId], startDate: month, endDate: monthEnd(month) })).toString()}`;

  return (
    <div className="border-b border-line last:border-0">
      {children.length > 0 && (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 bg-surface-2/60 px-5 py-2 text-xs font-semibold text-ink-2 sm:grid-cols-[minmax(0,1fr)_8rem_7rem_7rem_2rem]">
          <span className="flex items-center gap-2">
            <CategoryDot color={row.color} />
            {row.name}
          </span>
          <span className="num hidden text-right sm:block">{money(row.availableCents)}</span>
          <span className="num hidden text-right sm:block">{money(row.spentCents)}</span>
          <span className={cn('num text-right', row.remainingCents < 0 && 'text-bad-ink')}>
            {money(row.remainingCents)}
          </span>
          <span className="hidden sm:block" />
        </div>
      )}
      {leafRows.map((r) => {
        const category = categories.find((c) => c.id === r.categoryId);
        return (
          <div
            key={r.categoryId}
            className="grid grid-cols-[minmax(0,1fr)_6.5rem] items-center gap-x-4 gap-y-2 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_8rem_7rem_7rem_2rem]"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm">
                {!children.length && <CategoryDot color={r.color} />}
                <Link to={txLink(r.categoryId)} className="truncate text-ink hover:underline">
                  {r.name}
                </Link>
                <StatusIcon status={r.status} />
                {r.rolloverEnabled && (
                  <span className="flex items-center gap-0.5 text-xs text-ink-3" title="Unused budget rolls over">
                    <Repeat className="size-3" />
                    {r.rolloverCents !== 0 && money(r.rolloverCents, { sign: 'always' })}
                  </span>
                )}
              </div>
              <Meter
                value={r.percentUsed ?? (r.spentCents > 0 ? 1 : 0)}
                status={r.status}
                label={`${r.name} budget used`}
                className="mt-2"
              />
            </div>
            {/* Keyed by the saved amount so the field resets when the server value changes. */}
            <BudgetInput
              key={`${r.categoryId}:${r.budgetedCents}`}
              row={r}
              onSave={(cents) => onBudget(r.categoryId, cents)}
            />
            <div className="col-span-2 flex justify-between text-xs text-ink-3 sm:contents">
              <span className="num text-ink-2 sm:text-right sm:text-sm">
                <span className="sm:hidden">Spent </span>
                {money(r.spentCents)}
              </span>
              <span
                className={cn(
                  'num sm:text-right sm:text-sm',
                  r.remainingCents < 0 ? 'font-medium text-bad-ink' : 'text-ink-2',
                )}
              >
                {r.remainingCents < 0 ? `${money(-r.remainingCents)} over` : `${money(r.remainingCents)} left`}
              </span>
              {category ? (
                <ActionMenu
                  className="hidden sm:block"
                  items={[
                    {
                      label: category.rolloverEnabled ? 'Turn off rollover' : 'Roll over unused budget',
                      icon: <Repeat />,
                      onSelect: () => onRollover(category, !category.rolloverEnabled),
                    },
                  ]}
                />
              ) : (
                <span />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
