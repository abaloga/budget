/**
 * @budget/api — data access for any client (web now, Expo later).
 *
 * The caller creates the Supabase client (each platform stores the session
 * differently: localStorage on web, SecureStore/AsyncStorage on iOS) and passes
 * it in. Nothing here touches the DOM, React, or environment variables.
 *
 * All queries run as the signed-in user; Row Level Security scopes every row.
 * Plaid operations go through the `plaid` edge function — clients never see
 * provider secrets or access tokens.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { accountsApi, plaidApi } from './accounts.ts';
import { budgetsApi } from './budgets.ts';
import { categoriesApi } from './categories.ts';
import { goalsApi } from './goals.ts';
import { recurringApi } from './recurring.ts';
import { reportsApi } from './reports.ts';
import { rulesApi } from './rules.ts';
import { transactionsApi } from './transactions.ts';

export function createBudgetApi(sb: SupabaseClient) {
  return {
    supabase: sb,
    accounts: accountsApi(sb),
    plaid: plaidApi(sb),
    categories: categoriesApi(sb),
    transactions: transactionsApi(sb),
    budgets: budgetsApi(sb),
    rules: rulesApi(sb),
    recurring: recurringApi(sb),
    goals: goalsApi(sb),
    reports: reportsApi(sb),
  };
}

export type BudgetApi = ReturnType<typeof createBudgetApi>;

export { ApiError } from './errors.ts';
export type { SyncOutcome } from './accounts.ts';
export type { CategoryInput, CategoryPatch } from './categories.ts';
export type { GoalInput } from './goals.ts';
export type { RecurringInput } from './recurring.ts';
export type { RuleInput } from './rules.ts';
export type { ManualTransactionInput, SearchOptions, TransactionEdit } from './transactions.ts';
