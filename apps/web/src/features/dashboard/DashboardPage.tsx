import {
  accountDisplayName,
  addMonthsToMonth,
  amountsByCategory,
  balanceTotals,
  filtersToParams,
  formatMonth,
  goalProgress,
  isLiability,
  monthEnd,
  monthStart,
  monthlyCashFlow,
  todayISO,
  upcomingBills,
} from '@budget/core';
import { ArrowRight, Landmark, RefreshCw } from 'lucide-react';
import * as React from 'react';
import { Link, useNavigate } from 'react-router';

import {
  BarList,
  ChartOrTable,
  MonthTable,
  MonthlyColumns,
  StatTile,
  type SeriesDef,
} from '@/components/charts/charts';
import { PlaidLinkButton } from '@/components/PlaidLinkButton';
import { useCategoryLookup } from '@/components/pickers';
import { TransactionRow } from '@/components/TransactionRow';
import { UpcomingList } from '@/components/UpcomingList';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState, Meter, PageHeader, PageLoader, StatusNote } from '@/components/ui/misc';
import {
  useAccounts,
  useBudgetMonth,
  useCategories,
  useConnections,
  useGoals,
  useRecentTransactions,
  useRecurring,
  useSync,
  useTrailingTotals,
} from '@/hooks/queries';
import { cn, compactMoney, money, percent, relativeTime } from '@/lib/utils';

const CASH_FLOW_SERIES: SeriesDef[] = [
  { key: 'income', label: 'Income', color: 'var(--series-1)' },
  { key: 'expenses', label: 'Spending', color: 'var(--series-2)' },
];

function SeeAll({ to, label = 'See all' }: { to: string; label?: string }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 text-xs font-medium text-ink-3 hover:text-ink">
      {label} <ArrowRight className="size-3" />
    </Link>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const today = todayISO();
  const month = monthStart(today);
  const categories = useCategories();
  const connections = useConnections();
  const accounts = useAccounts();
  const budget = useBudgetMonth(month, categories.data);
  const totals = useTrailingTotals(month, 6);
  const recurring = useRecurring();
  const goals = useGoals();
  const recent = useRecentTransactions(8);
  const sync = useSync();
  const lookup = useCategoryLookup(categories.data);

  const months = Array.from({ length: 6 }, (_, i) => addMonthsToMonth(month, i - 5));
  const cashFlow = monthlyCashFlow(totals.data ?? [], months);
  const cashRows = cashFlow.map((m) => ({
    month: m.month,
    income: m.incomeCents,
    expenses: m.expenseCents,
    net: m.netCents,
  }));
  const thisMonth = cashFlow[cashFlow.length - 1];

  const topCategories = amountsByCategory(
    (totals.data ?? []).filter((t) => t.month === month),
    categories.data ?? [],
    { level: 'group' },
  ).slice(0, 6);

  const bills = upcomingBills(recurring.data ?? [], today, { horizonDays: 14, soonDays: 3 });
  const balances = balanceTotals(accounts.data ?? []);
  const visibleAccounts = (accounts.data ?? []).filter((a) => !a.isHidden && a.isActive);
  const accountName = (id: string | null) => {
    const a = accounts.data?.find((x) => x.id === id);
    return a ? accountDisplayName(a) : null;
  };
  const lastSync =
    (connections.data ?? [])
      .map((c) => c.lastSyncedAt)
      .filter(Boolean)
      .sort()
      .pop() ?? null;
  const summary = budget.data?.summary;

  if (categories.isLoading || connections.isLoading) return <PageLoader />;

  const noConnections = connections.data?.length === 0;

  return (
    <>
      <PageHeader
        title={formatMonth(month)}
        description={connections.data?.length ? `Last synced ${relativeTime(lastSync)}` : undefined}
        actions={
          connections.data?.length ? (
            <Button size="sm" onClick={() => sync.mutate(undefined)} loading={sync.isPending}>
              {!sync.isPending && <RefreshCw />} Sync now
            </Button>
          ) : null
        }
      />

      {noConnections && (
        <Card className="mb-6">
          <EmptyState
            icon={<Landmark />}
            title="Connect an account to get started"
            description="Link your checking, savings and credit cards. Transactions import and categorize themselves."
            action={<PlaidLinkButton />}
          />
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Spent this month"
          value={money(summary?.spentCents ?? 0, { whole: true })}
          detail={
            summary && summary.availableCents > 0
              ? `of ${money(summary.availableCents, { whole: true })} budgeted`
              : 'no budget set'
          }
        />
        <StatTile
          label="Income this month"
          value={money(summary?.incomeCents ?? 0, { whole: true })}
          detail="after transfers are excluded"
        />
        <StatTile
          label={summary && summary.remainingCents < 0 ? 'Over budget' : 'Left to spend'}
          value={money(Math.abs(summary?.remainingCents ?? 0), { whole: true })}
          tone={summary && summary.remainingCents < 0 ? 'bad' : undefined}
          detail={
            summary && summary.availableCents > 0 ? (
              <Meter value={summary.percentUsed} status={summary.status} label="Budget used" className="mt-1.5" />
            ) : (
              'set a budget to track this'
            )
          }
        />
        <StatTile
          label="Net cash flow"
          value={money(thisMonth?.netCents ?? 0, { whole: true, sign: 'always' })}
          tone={thisMonth && thisMonth.netCents < 0 ? 'bad' : undefined}
          detail="income minus spending"
        />
      </div>

      {summary && (summary.overBudgetCategoryCount > 0 || summary.warningCategoryCount > 0) && (
        <StatusNote tone={summary.overBudgetCategoryCount ? 'bad' : 'warn'} className="mt-4">
          {summary.overBudgetCategoryCount > 0 && `${summary.overBudgetCategoryCount} over budget. `}
          {summary.warningCategoryCount > 0 && `${summary.warningCategoryCount} close to the limit. `}
          <Link to="/budget" className="font-medium underline underline-offset-2">
            Review budget
          </Link>
        </StatusNote>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card>
            <CardHeader
              title="Where your money went"
              description={`Spending by category, ${formatMonth(month)}`}
              action={<SeeAll to="/reports" label="Reports" />}
            />
            <CardBody>
              <BarList
                items={topCategories.map((c) => ({
                  id: c.categoryId ?? 'none',
                  label: c.name,
                  value: c.amountCents,
                  color: c.color,
                }))}
                total={summary?.spentCents}
                emptyLabel="No spending yet this month."
                onSelect={(item) =>
                  item.id !== 'none' &&
                  navigate(
                    `/transactions?${new URLSearchParams(filtersToParams({ categoryIds: [item.id], startDate: month, endDate: monthEnd(month) }))}`,
                  )
                }
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Cash flow" description="Last 6 months · transfers excluded" />
            <CardBody>
              <ChartOrTable
                chart={<MonthlyColumns data={cashRows} series={CASH_FLOW_SERIES} height={200} />}
                table={<MonthTable data={cashRows} series={CASH_FLOW_SERIES} extra={[{ key: 'net', label: 'Net' }]} />}
              />
            </CardBody>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Recent transactions" action={<SeeAll to="/transactions" />} />
            {recent.data?.length ? (
              <ul className="border-t border-line">
                {recent.data.map((tx) => (
                  <TransactionRow
                    key={tx.id}
                    tx={tx}
                    compact
                    categoryName={lookup.label(tx.categoryId)}
                    categoryColor={lookup.color(tx.categoryId)}
                    accountName=""
                    onOpen={() => navigate(`/transactions?tx=${tx.id}`)}
                  />
                ))}
              </ul>
            ) : (
              <CardBody>
                <p className="text-sm text-ink-3">No transactions yet.</p>
              </CardBody>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card className="overflow-hidden">
            <CardHeader title="Upcoming bills" description="Next 14 days" action={<SeeAll to="/recurring" />} />
            {bills.length ? (
              <div className="border-t border-line">
                <UpcomingList bills={bills} lookup={lookup} accountName={accountName} limit={6} />
              </div>
            ) : (
              <CardBody>
                <p className="text-sm text-ink-3">Nothing due in the next two weeks.</p>
              </CardBody>
            )}
          </Card>

          <Card>
            <CardHeader title="Savings goals" action={<SeeAll to="/goals" />} />
            <CardBody className="flex flex-col gap-4">
              {(goals.data ?? [])
                .filter((g) => !g.isArchived)
                .slice(0, 4)
                .map((g) => {
                  const account = accounts.data?.find((a) => a.id === g.accountId);
                  const p = goalProgress(g, today, account?.currentBalanceCents);
                  return (
                    <div key={g.id}>
                      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
                        <span className="truncate font-medium">{g.name}</span>
                        <span className="num shrink-0 text-xs text-ink-3">
                          {compactMoney(p.currentCents)} / {compactMoney(g.targetCents)} · {percent(p.percent)}
                        </span>
                      </div>
                      <Meter value={p.percent} status="accent" label={`${g.name} progress`} />
                    </div>
                  );
                })}
              {!goals.data?.some((g) => !g.isArchived) && (
                <p className="text-sm text-ink-3">
                  No goals yet.{' '}
                  <Link to="/goals" className="text-accent hover:underline">
                    Create one
                  </Link>
                </p>
              )}
            </CardBody>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader
              title="Balances"
              description={`${money(balances.cashCents, { whole: true })} cash · ${money(balances.creditOwedCents, { whole: true })} on cards`}
              action={<SeeAll to="/accounts" />}
            />
            <ul className="divide-y divide-line border-t border-line">
              {visibleAccounts.slice(0, 8).map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                  <span className="truncate text-ink-2">{accountDisplayName(a)}</span>
                  <span className={cn('num shrink-0 font-medium', isLiability(a.type) && 'text-ink-2')}>
                    {a.currentBalanceCents == null ? '—' : money(a.currentBalanceCents)}
                    {isLiability(a.type) && <span className="ml-1 text-xs font-normal text-ink-3">owed</span>}
                  </span>
                </li>
              ))}
              {!visibleAccounts.length && <li className="px-5 py-3 text-sm text-ink-3">No accounts connected.</li>}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
