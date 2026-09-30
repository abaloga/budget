/**
 * TanStack Query hooks over @budget/api. These hooks contain no business
 * logic (that lives in @budget/core) and would work unchanged in React Native.
 */
import {
  addMonthsToMonth,
  monthEnd,
  monthStart,
  type Category,
  type ISODate,
  type TransactionFilters,
  type TransactionSort,
} from '@budget/core';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api } from '@/lib/supabase';

export const keys = {
  categories: ['categories'] as const,
  accounts: ['accounts'] as const,
  connections: ['connections'] as const,
  transactions: ['transactions'] as const,
  transaction: (id: string) => ['transaction', id] as const,
  recent: ['recent'] as const,
  budgetMonth: (month: string) => ['budgetMonth', month] as const,
  totals: (start: string, end: string) => ['totals', start, end] as const,
  merchantTotals: (start: string, end: string) => ['merchantTotals', start, end] as const,
  rules: ['rules'] as const,
  recurring: ['recurring'] as const,
  goals: ['goals'] as const,
  budgets: ['budgets'] as const,
};

/** Anything that can change what a transaction contributes to totals. */
export function invalidateFinancialData(qc: QueryClient) {
  for (const key of [
    keys.transactions,
    ['transaction'],
    keys.recent,
    ['budgetMonth'],
    ['totals'],
    ['merchantTotals'],
    keys.recurring,
  ]) {
    void qc.invalidateQueries({ queryKey: key });
  }
}

export function invalidateAll(qc: QueryClient) {
  void qc.invalidateQueries();
}

export const useCategories = () =>
  useQuery({ queryKey: keys.categories, queryFn: () => api.categories.list(), staleTime: 5 * 60_000 });

export const useAccounts = () => useQuery({ queryKey: keys.accounts, queryFn: () => api.accounts.listAccounts() });

export const useConnections = () =>
  useQuery({ queryKey: keys.connections, queryFn: () => api.accounts.listConnections() });

export function useTransactions(filters: TransactionFilters, sort: TransactionSort, page: number, pageSize = 50) {
  return useQuery({
    queryKey: [...keys.transactions, filters, sort, page, pageSize],
    queryFn: () => api.transactions.search({ filters, sort, page, pageSize }),
    placeholderData: keepPreviousData,
  });
}

export const useTransaction = (id: string | null) =>
  useQuery({
    queryKey: keys.transaction(id ?? ''),
    queryFn: () => api.transactions.get(id!),
    enabled: Boolean(id),
  });

export const useRecentTransactions = (limit = 8) =>
  useQuery({ queryKey: [...keys.recent, limit], queryFn: () => api.transactions.recent(limit) });

export function useBudgetMonth(month: ISODate, categories: Category[] | undefined) {
  const m = monthStart(month);
  // The result depends on category settings (rollover, hierarchy, archive), so
  // they're part of the key: a settings change can't reuse a stale computation.
  const signature = (categories ?? [])
    .map((c) => `${c.id}:${c.parentId ?? ''}:${+c.rolloverEnabled}:${c.rolloverStartMonth ?? ''}:${+c.isArchived}`)
    .join('|');
  return useQuery({
    queryKey: [...keys.budgetMonth(m), signature],
    queryFn: () => api.budgets.loadMonth(m, categories!),
    enabled: Boolean(categories),
    placeholderData: keepPreviousData,
  });
}

export function useMonthTotals(start: ISODate, end: ISODate) {
  return useQuery({
    queryKey: keys.totals(start, end),
    queryFn: () => api.reports.categoryMonthTotals(start, end),
    placeholderData: keepPreviousData,
  });
}

/** Totals for the `count` months ending with `month` (inclusive). */
export function useTrailingTotals(month: ISODate, count: number) {
  const end = monthEnd(month);
  const start = addMonthsToMonth(monthStart(month), -(count - 1));
  return useMonthTotals(start, end);
}

export function useMerchantTotals(start: ISODate, end: ISODate) {
  return useQuery({
    queryKey: keys.merchantTotals(start, end),
    queryFn: () => api.reports.merchantTotals(start, end),
    placeholderData: keepPreviousData,
  });
}

export const useBudgets = (from: ISODate, to: ISODate) =>
  useQuery({ queryKey: [...keys.budgets, from, to], queryFn: () => api.budgets.list({ from, to }) });

export const useRules = () => useQuery({ queryKey: keys.rules, queryFn: () => api.rules.list() });

export const useRecurring = () => useQuery({ queryKey: keys.recurring, queryFn: () => api.recurring.list() });

export const useGoals = () => useQuery({ queryKey: keys.goals, queryFn: () => api.goals.list() });

/** Mutation helper that refreshes financial data afterwards. */
export function useFinancialMutation<TVars, TResult = unknown>(
  fn: (vars: TVars) => Promise<TResult>,
  extraKeys: readonly (readonly unknown[])[] = [],
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      invalidateFinancialData(qc);
      for (const k of extraKeys) void qc.invalidateQueries({ queryKey: k });
    },
  });
}

/** Sync all connections (or one) through the edge function. */
export function useSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (connectionId?: string) => api.plaid.sync(connectionId),
    onSettled: () => invalidateAll(qc),
  });
}
