import {
  addMonthsToMonth,
  amountsByCategory,
  amountsByMerchant,
  average,
  cashFlow,
  categoryTrend,
  monthEnd,
  monthStart,
  monthlyCashFlow,
  monthlyTotals,
  monthsInRange,
  savingsRate,
  todayISO,
  topLevelIndex,
  type Category,
  type CategoryMonthTotal,
} from '@budget/core';
import * as Tabs from '@radix-ui/react-tabs';
import * as React from 'react';
import { useSearchParams } from 'react-router';

import {
  BarList,
  ChartOrTable,
  MonthTable,
  MonthlyColumns,
  SERIES,
  StatTile,
  TrendLines,
  type SeriesDef,
} from '@/components/charts/charts';
import { CategoryDot } from '@/components/pickers';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Segmented, Select } from '@/components/ui/form';
import { ErrorState, PageHeader, PageLoader } from '@/components/ui/misc';
import { useBudgets, useCategories, useMerchantTotals, useMonthTotals } from '@/hooks/queries';
import { cn, money, percent } from '@/lib/utils';

type RangeKey = 'this-month' | 'last-month' | '3m' | '6m' | 'ytd' | '12m' | 'custom';

function rangeFor(key: RangeKey, custom: { start: string; end: string }): { start: string; end: string } {
  const today = todayISO();
  const m = monthStart(today);
  switch (key) {
    case 'this-month':
      return { start: m, end: monthEnd(m) };
    case 'last-month': {
      const prev = addMonthsToMonth(m, -1);
      return { start: prev, end: monthEnd(prev) };
    }
    case '3m':
      return { start: addMonthsToMonth(m, -2), end: monthEnd(m) };
    case '6m':
      return { start: addMonthsToMonth(m, -5), end: monthEnd(m) };
    case 'ytd':
      return { start: `${today.slice(0, 4)}-01-01`, end: monthEnd(m) };
    case '12m':
      return { start: addMonthsToMonth(m, -11), end: monthEnd(m) };
    case 'custom':
      return custom;
  }
}

const tabClass =
  'rounded-control px-3 py-1.5 text-sm font-medium whitespace-nowrap text-ink-3 data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-sm';

export default function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const rangeKey = (params.get('range') as RangeKey | null) ?? '6m';
  const custom = {
    start: params.get('from') ?? addMonthsToMonth(monthStart(todayISO()), -2),
    end: params.get('to') ?? todayISO(),
  };
  const { start, end } = rangeFor(rangeKey, custom);
  const tab = params.get('tab') ?? 'spending';
  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  const categories = useCategories();
  const totals = useMonthTotals(start, end);
  const merchants = useMerchantTotals(start, end);
  const budgets = useBudgets(monthStart(start), monthStart(end));
  const months = React.useMemo(() => monthsInRange(start, end), [start, end]);

  const error = totals.error ?? merchants.error ?? categories.error;
  const loading = !totals.data || !categories.data;

  return (
    <>
      <PageHeader title="Reports" description="Transfers between your accounts are excluded from every report." />

      {/* One filter row scoping everything below */}
      <div className="mb-5 flex flex-wrap items-end gap-2">
        <Select
          aria-label="Date range"
          className="w-44"
          value={rangeKey}
          onChange={(e) => setParam({ range: e.target.value })}
        >
          <option value="this-month">This month</option>
          <option value="last-month">Last month</option>
          <option value="3m">Last 3 months</option>
          <option value="6m">Last 6 months</option>
          <option value="ytd">Year to date</option>
          <option value="12m">Last 12 months</option>
          <option value="custom">Custom range</option>
        </Select>
        {rangeKey === 'custom' && (
          <>
            <Input
              type="date"
              aria-label="From"
              className="w-40"
              value={custom.start}
              onChange={(e) => setParam({ from: e.target.value || null })}
            />
            <Input
              type="date"
              aria-label="To"
              className="w-40"
              value={custom.end}
              onChange={(e) => setParam({ to: e.target.value || null })}
            />
          </>
        )}
      </div>

      {error && <ErrorState error={error} />}
      {loading ? (
        <PageLoader />
      ) : (
        <Tabs.Root value={tab} onValueChange={(v) => setParam({ tab: v })}>
          <div className="mb-5 overflow-x-auto">
            <Tabs.List className="inline-flex rounded-control bg-surface-2 p-0.5" aria-label="Report">
              <Tabs.Trigger className={tabClass} value="spending">
                Spending
              </Tabs.Trigger>
              <Tabs.Trigger className={tabClass} value="merchants">
                Merchants
              </Tabs.Trigger>
              <Tabs.Trigger className={tabClass} value="income">
                Income
              </Tabs.Trigger>
              <Tabs.Trigger className={tabClass} value="cashflow">
                Cash flow
              </Tabs.Trigger>
              <Tabs.Trigger className={tabClass} value="budget">
                Budget vs actual
              </Tabs.Trigger>
              <Tabs.Trigger className={tabClass} value="trends">
                Trends
              </Tabs.Trigger>
            </Tabs.List>
          </div>
          <div
            className={cn((totals.isPlaceholderData || merchants.isPlaceholderData) && 'opacity-60 transition-opacity')}
          >
            <Tabs.Content value="spending">
              <SpendingReport totals={totals.data!} categories={categories.data!} months={months} />
            </Tabs.Content>
            <Tabs.Content value="merchants">
              <Card>
                <CardHeader title="Top merchants" description="Spending by merchant for the selected range" />
                <CardBody>
                  <BarList
                    items={amountsByMerchant(merchants.data ?? [], 'expense', 25).map((m) => ({
                      id: m.merchantKey,
                      label: m.name,
                      value: m.amountCents,
                      sublabel: `${m.count}×`,
                    }))}
                    emptyLabel="No spending in this range."
                  />
                </CardBody>
              </Card>
            </Tabs.Content>
            <Tabs.Content value="income">
              <IncomeReport
                totals={totals.data!}
                categories={categories.data!}
                months={months}
                merchants={merchants.data ?? []}
              />
            </Tabs.Content>
            <Tabs.Content value="cashflow">
              <CashFlowReport totals={totals.data!} months={months} />
            </Tabs.Content>
            <Tabs.Content value="budget">
              <BudgetVsActual
                totals={totals.data!}
                categories={categories.data!}
                months={months}
                budgets={budgets.data ?? []}
              />
            </Tabs.Content>
            <Tabs.Content value="trends">
              <TrendsReport totals={totals.data!} categories={categories.data!} months={months} />
            </Tabs.Content>
          </div>
        </Tabs.Root>
      )}
    </>
  );
}

const SPENDING: SeriesDef[] = [{ key: 'spending', label: 'Spending', color: SERIES[0]! }];

function SpendingReport({
  totals,
  categories,
  months,
}: {
  totals: CategoryMonthTotal[];
  categories: Category[];
  months: string[];
}) {
  const [level, setLevel] = React.useState<'group' | 'category'>('group');
  const monthly = monthlyTotals(totals, months, 'expense');
  const rows = monthly.map((m) => ({ month: m.month, spending: m.amountCents }));
  const byCategory = amountsByCategory(totals, categories, { level });
  const total = monthly.reduce((a, m) => a + m.amountCents, 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:max-w-lg">
        <StatTile label="Total spending" value={money(total, { whole: true })} />
        <StatTile
          label="Monthly average"
          value={money(Math.round(average(monthly.map((m) => m.amountCents))), { whole: true })}
        />
      </div>
      <Card>
        <CardHeader title="Monthly spending" />
        <CardBody>
          <ChartOrTable
            chart={<MonthlyColumns data={rows} series={SPENDING} />}
            table={<MonthTable data={rows} series={SPENDING} />}
          />
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="Spending by category"
          action={
            <Segmented
              label="Grouping"
              value={level}
              onChange={setLevel}
              options={[
                { value: 'group', label: 'Groups' },
                { value: 'category', label: 'Categories' },
              ]}
            />
          }
        />
        <CardBody>
          <BarList
            items={byCategory.map((c) => ({
              id: c.categoryId ?? 'none',
              label: c.name,
              value: c.amountCents,
              color: c.color,
            }))}
            total={total}
          />
        </CardBody>
      </Card>
    </div>
  );
}

const INCOME: SeriesDef[] = [{ key: 'income', label: 'Income', color: SERIES[0]! }];

function IncomeReport({
  totals,
  categories,
  months,
  merchants,
}: {
  totals: CategoryMonthTotal[];
  categories: Category[];
  months: string[];
  merchants: Parameters<typeof amountsByMerchant>[0];
}) {
  const monthly = monthlyTotals(totals, months, 'income');
  const rows = monthly.map((m) => ({ month: m.month, income: m.amountCents }));
  const total = monthly.reduce((a, m) => a + m.amountCents, 0);
  const sources = amountsByMerchant(merchants, 'income', 15);
  const byCategory = amountsByCategory(totals, categories, { kind: 'income', level: 'category' });
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:max-w-lg">
        <StatTile label="Total income" value={money(total, { whole: true })} />
        <StatTile
          label="Monthly average"
          value={money(Math.round(average(monthly.map((m) => m.amountCents))), { whole: true })}
        />
      </div>
      <Card>
        <CardHeader title="Monthly income" />
        <CardBody>
          <ChartOrTable
            chart={<MonthlyColumns data={rows} series={INCOME} />}
            table={<MonthTable data={rows} series={INCOME} />}
          />
        </CardBody>
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Income by source" />
          <CardBody>
            <BarList
              items={sources.map((s) => ({
                id: s.merchantKey,
                label: s.name,
                value: s.amountCents,
                sublabel: `${s.count}×`,
              }))}
              total={total}
              emptyLabel="No income in this range."
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Income by category" />
          <CardBody>
            <BarList
              items={byCategory.map((c) => ({
                id: c.categoryId ?? 'none',
                label: c.name,
                value: c.amountCents,
                color: c.color,
              }))}
              total={total}
              emptyLabel="No income in this range."
            />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

const CASH: SeriesDef[] = [
  { key: 'income', label: 'Income', color: SERIES[0]! },
  { key: 'expenses', label: 'Spending', color: SERIES[1]! },
];

function CashFlowReport({ totals, months }: { totals: CategoryMonthTotal[]; months: string[] }) {
  const overall = cashFlow(totals);
  const rows = monthlyCashFlow(totals, months).map((m) => ({
    month: m.month,
    income: m.incomeCents,
    expenses: m.expenseCents,
    net: m.netCents,
  }));
  const rate = savingsRate(overall);
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Income" value={money(overall.incomeCents, { whole: true })} />
        <StatTile label="Spending" value={money(overall.expenseCents, { whole: true })} />
        <StatTile
          label="Net cash flow"
          value={money(overall.netCents, { whole: true, sign: 'always' })}
          tone={overall.netCents < 0 ? 'bad' : undefined}
        />
        <StatTile label="Savings rate" value={percent(rate)} detail="net ÷ income" />
      </div>
      <Card>
        <CardHeader title="Income vs spending" description="Income − Spending = Net cash flow" />
        <CardBody>
          <MonthlyColumns data={rows} series={CASH} />
          <div className="mt-5">
            <MonthTable data={rows} series={CASH} extra={[{ key: 'net', label: 'Net' }]} />
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

const BVA: SeriesDef[] = [
  { key: 'budgeted', label: 'Budgeted', color: SERIES[0]! },
  { key: 'spent', label: 'Spent', color: SERIES[1]! },
];

function BudgetVsActual({
  totals,
  categories,
  months,
  budgets,
}: {
  totals: CategoryMonthTotal[];
  categories: Category[];
  months: string[];
  budgets: { categoryId: string; month: string; amountCents: number }[];
}) {
  const monthlySpent = monthlyTotals(totals, months, 'expense');
  const rows = months.map((m, i) => ({
    month: m,
    budgeted: budgets.filter((b) => b.month === m).reduce((a, b) => a + b.amountCents, 0),
    spent: monthlySpent[i]!.amountCents,
  }));

  const tops = topLevelIndex(categories);
  const perGroup = new Map<string, { budgeted: number; spent: number }>();
  for (const b of budgets) {
    const g = tops.get(b.categoryId);
    if (!g) continue;
    const cur = perGroup.get(g.id) ?? { budgeted: 0, spent: 0 };
    cur.budgeted += b.amountCents;
    perGroup.set(g.id, cur);
  }
  for (const c of amountsByCategory(totals, categories, { level: 'group' })) {
    if (!c.categoryId) continue;
    const cur = perGroup.get(c.categoryId) ?? { budgeted: 0, spent: 0 };
    cur.spent += c.amountCents;
    perGroup.set(c.categoryId, cur);
  }
  const table = [...perGroup.entries()]
    .map(([id, v]) => ({ category: categories.find((c) => c.id === id)!, ...v }))
    .filter((r) => r.category)
    .sort((a, b) => a.category.sortOrder - b.category.sortOrder);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader title="Budgeted vs spent by month" description="Base budgets (rollover not included)" />
        <CardBody>
          <ChartOrTable
            chart={<MonthlyColumns data={rows} series={BVA} />}
            table={<MonthTable data={rows} series={BVA} />}
          />
        </CardBody>
      </Card>
      <Card className="overflow-hidden">
        <CardHeader title="By category group" description="Totals for the selected range" />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-line text-left text-xs text-ink-3">
                <th className="px-5 py-2 font-medium">Category</th>
                <th className="px-5 py-2 text-right font-medium">Budgeted</th>
                <th className="px-5 py-2 text-right font-medium">Spent</th>
                <th className="px-5 py-2 text-right font-medium">Difference</th>
              </tr>
            </thead>
            <tbody>
              {table.map((r) => {
                const diff = r.budgeted - r.spent;
                return (
                  <tr key={r.category.id} className="border-b border-line last:border-0">
                    <td className="px-5 py-2.5">
                      <span className="flex items-center gap-2">
                        <CategoryDot color={r.category.color} /> {r.category.name}
                      </span>
                    </td>
                    <td className="num px-5 py-2.5 text-right">{money(r.budgeted)}</td>
                    <td className="num px-5 py-2.5 text-right">{money(r.spent)}</td>
                    <td className={cn('num px-5 py-2.5 text-right', r.budgeted > 0 && diff < 0 && 'text-bad-ink')}>
                      {r.budgeted === 0 ? '—' : diff < 0 ? `${money(-diff)} over` : `${money(diff)} under`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function TrendsReport({
  totals,
  categories,
  months,
}: {
  totals: CategoryMonthTotal[];
  categories: Category[];
  months: string[];
}) {
  const groups = amountsByCategory(totals, categories, { level: 'group' }).filter((g) => g.categoryId);
  // Each selected group owns a color slot until it's deselected, so toggling
  // one series never repaints the others (color follows the entity, not rank).
  const [slots, setSlots] = React.useState<(string | null)[]>(() =>
    SERIES.map((_, i) => groups[i]?.categoryId ?? null).map((id, i) => (i < 4 ? id : null)),
  );
  const selected = slots.filter((id): id is string => id !== null);

  const series: SeriesDef[] = slots.flatMap((id, i) => {
    const c = id ? categories.find((x) => x.id === id) : undefined;
    return c ? [{ key: c.id, label: c.name, color: SERIES[i]! }] : [];
  });
  const rows = categoryTrend(
    totals,
    categories,
    months,
    series.map((s) => s.key),
  ).map((r) => ({ month: r.month, ...r.values }));

  const toggle = (id: string) =>
    setSlots((current) => {
      const at = current.indexOf(id);
      if (at >= 0) return current.map((x, i) => (i === at ? null : x));
      const free = current.indexOf(null);
      return free < 0 ? current : current.map((x, i) => (i === free ? id : x));
    });

  return (
    <Card>
      <CardHeader title="Spending trends" description={`Pick up to ${SERIES.length} category groups to compare`} />
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          {groups.map((g) => (
            <button
              key={g.categoryId}
              type="button"
              aria-pressed={selected.includes(g.categoryId!)}
              onClick={() => toggle(g.categoryId!)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                selected.includes(g.categoryId!)
                  ? 'border-accent bg-accent-wash text-accent'
                  : 'border-line text-ink-2 hover:border-line-strong',
              )}
            >
              {g.name}
            </button>
          ))}
        </div>
        {series.length ? (
          <ChartOrTable
            chart={<TrendLines data={rows} series={series} />}
            table={<MonthTable data={rows} series={series} />}
          />
        ) : (
          <p className="py-8 text-center text-sm text-ink-3">Select a category group to see its trend.</p>
        )}
      </CardBody>
    </Card>
  );
}
