import {
  accountDisplayName,
  activeFilterCount,
  filtersFromParams,
  filtersToParams,
  type TransactionFilters,
  type TransactionSort,
} from '@budget/core';
import { ArrowLeftRight, ChevronLeft, ChevronRight, Plus, Search, SlidersHorizontal } from 'lucide-react';
import * as React from 'react';
import { useSearchParams } from 'react-router';

import { useCategoryLookup } from '@/components/pickers';
import { TransactionRow } from '@/components/TransactionRow';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/form';
import { Badge, EmptyState, ErrorState, PageHeader, PageLoader } from '@/components/ui/misc';
import { useAccounts, useCategories, useTransactions } from '@/hooks/queries';
import { cn } from '@/lib/utils';

import { AddTransactionDialog } from './AddTransactionDialog';
import { FilterChips, FiltersPanel } from './FiltersPanel';
import { TransactionDetail } from './TransactionDetail';

const PAGE_SIZE = 50;

const SORTS: { value: string; label: string; sort: TransactionSort }[] = [
  { value: 'date:desc', label: 'Newest first', sort: { field: 'date', descending: true } },
  { value: 'date:asc', label: 'Oldest first', sort: { field: 'date', descending: false } },
  { value: 'amount:desc', label: 'Largest amount', sort: { field: 'amount', descending: true } },
  { value: 'amount:asc', label: 'Smallest amount', sort: { field: 'amount', descending: false } },
  { value: 'name:asc', label: 'Name A–Z', sort: { field: 'name', descending: false } },
];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function TransactionsPage() {
  const [params, setParams] = useSearchParams();
  const { filters, sort } = React.useMemo(() => filtersFromParams((k) => params.get(k)), [params]);
  const page = Math.max(Number(params.get('page') ?? '0') || 0, 0);
  const selectedId = params.get('tx');

  const [search, setSearch] = React.useState(filters.search ?? '');
  const debounced = useDebounced(search, 300);
  const [showFilters, setShowFilters] = React.useState(false);
  const [adding, setAdding] = React.useState(false);

  const categories = useCategories();
  const accounts = useAccounts();
  const lookup = useCategoryLookup(categories.data);
  const accountsById = React.useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a])), [accounts.data]);

  const update = React.useCallback(
    (next: TransactionFilters, nextSort: TransactionSort = sort, extra: Record<string, string> = {}) => {
      setParams({ ...filtersToParams(next, nextSort), ...extra }, { replace: true });
    },
    [setParams, sort],
  );

  React.useEffect(() => {
    if ((filters.search ?? '') !== debounced) update({ ...filters, search: debounced || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const txs = useTransactions(filters, sort, page, PAGE_SIZE);
  const total = txs.data?.total ?? 0;
  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);

  const setPage = (p: number) => update(filters, sort, p > 0 ? { page: String(p) } : {});
  const openTx = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('tx', id);
    else next.delete('tx');
    setParams(next, { replace: true });
  };

  const sortValue = `${sort.field}:${sort.descending ? 'desc' : 'asc'}`;
  const filterCount = activeFilterCount({ ...filters, search: undefined });

  return (
    <>
      <PageHeader
        title="Transactions"
        description={txs.data ? `${total.toLocaleString()} transaction${total === 1 ? '' : 's'}` : undefined}
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus /> Add
          </Button>
        }
      />

      <div className="mb-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-52 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
            <Input
              type="search"
              aria-label="Search transactions"
              placeholder="Search merchant, description or notes"
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>
            <SlidersHorizontal /> Filters
            {filterCount > 0 && <Badge tone="accent">{filterCount}</Badge>}
          </Button>
          <Select
            aria-label="Sort"
            className="w-44"
            value={sortValue}
            onChange={(e) => update(filters, SORTS.find((s) => s.value === e.target.value)!.sort)}
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </div>
        {showFilters && categories.data && accounts.data && (
          <Card className="p-4">
            <FiltersPanel
              filters={filters}
              onChange={(f) => update(f)}
              categories={categories.data}
              accounts={accounts.data}
            />
          </Card>
        )}
        <FilterChips
          filters={filters}
          onChange={(f) => update(f)}
          categories={categories.data ?? []}
          accounts={accounts.data ?? []}
        />
      </div>

      {txs.error && <ErrorState error={txs.error} onRetry={() => void txs.refetch()} />}
      {txs.isLoading ? (
        <PageLoader />
      ) : txs.data && txs.data.rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ArrowLeftRight />}
            title={activeFilterCount(filters) ? 'No transactions match these filters' : 'No transactions yet'}
            description={
              activeFilterCount(filters)
                ? 'Try widening the date range or clearing filters.'
                : 'Connect an account or add one manually.'
            }
          />
        </Card>
      ) : (
        <Card className={cn('overflow-hidden', txs.isPlaceholderData && 'opacity-60 transition-opacity')}>
          <div className="hidden grid-cols-[6rem_minmax(0,1fr)_12rem_10rem_8rem] gap-4 border-b border-line px-5 py-2.5 text-xs font-medium text-ink-3 md:grid">
            <span>Date</span>
            <span>Name</span>
            <span>Category</span>
            <span>Account</span>
            <span className="text-right">Amount</span>
          </div>
          <ul>
            {txs.data?.rows.map((tx) => (
              <TransactionRow
                key={tx.id}
                tx={tx}
                categoryName={lookup.label(tx.categoryId)}
                categoryColor={lookup.color(tx.categoryId)}
                accountName={
                  tx.accountId
                    ? accountsById.get(tx.accountId)
                      ? accountDisplayName(accountsById.get(tx.accountId)!)
                      : ''
                    : 'Cash'
                }
                onOpen={() => openTx(tx.id)}
              />
            ))}
          </ul>
          {pages > 1 && (
            <div className="flex items-center justify-between border-t border-line px-5 py-3 text-sm text-ink-3">
              <span>
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total.toLocaleString()}
              </span>
              <div className="flex gap-1">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Previous page"
                  disabled={page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  <ChevronLeft />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Next page"
                  disabled={page >= pages - 1}
                  onClick={() => setPage(page + 1)}
                >
                  <ChevronRight />
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      <TransactionDetail
        id={selectedId}
        onClose={() => openTx(null)}
        categories={categories.data ?? []}
        accounts={accounts.data ?? []}
      />
      <AddTransactionDialog
        open={adding}
        onOpenChange={setAdding}
        categories={categories.data ?? []}
        accounts={accounts.data ?? []}
      />
    </>
  );
}
