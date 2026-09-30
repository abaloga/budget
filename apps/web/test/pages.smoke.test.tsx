// @vitest-environment jsdom
// Renders every route with a mocked API to catch runtime errors in page code.
// Business logic is tested in packages/core; this only checks the UI wiring.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const month = new Date().toISOString().slice(0, 7);
const cat = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  parentId: null,
  name,
  kind: 'expense',
  systemKey: null,
  color: '#6366f1',
  sortOrder: 1,
  rolloverEnabled: false,
  rolloverStartMonth: null,
  isArchived: false,
  ...extra,
});
const categories = [
  cat('food', 'Food'),
  cat('dining', 'Dining', { parentId: 'food', rolloverEnabled: true, rolloverStartMonth: `${month}-01` }),
  cat('inc', 'Income', { kind: 'income' }),
];
const tx = {
  id: 't1',
  accountId: 'a1',
  source: 'plaid',
  name: 'Chipotle',
  date: `${month}-05`,
  amountCents: -1250,
  isoCurrencyCode: 'USD',
  pending: true,
  merchantKey: 'chipotle',
  originalName: 'CHIPOTLE 123',
  originalMerchantName: 'Chipotle',
  originalDate: `${month}-05`,
  nameOverride: null,
  dateOverride: null,
  notes: 'lunch',
  categoryId: 'dining',
  categorySource: 'rule',
  kind: 'expense',
  kindSource: 'auto',
  transferPairId: null,
  recurringId: null,
  providerCategoryPrimary: 'FOOD_AND_DRINK',
  providerCategoryDetailed: null,
  createdAt: '',
  updatedAt: '',
  splits: [],
};
const totals = [
  { month: `${month}-01`, categoryId: 'dining', kind: 'expense', totalCents: -1250, lineCount: 1 },
  { month: `${month}-01`, categoryId: 'inc', kind: 'income', totalCents: 400000, lineCount: 1 },
];
const account = {
  id: 'a1',
  connectionId: 'c1',
  name: 'Checking',
  displayName: null,
  officialName: null,
  mask: '1234',
  type: 'depository',
  subtype: 'checking',
  currentBalanceCents: 250000,
  availableBalanceCents: 240000,
  creditLimitCents: null,
  isoCurrencyCode: 'USD',
  balanceUpdatedAt: null,
  isHidden: false,
  isActive: true,
};
const series = {
  id: 'r1',
  name: 'Netflix',
  merchantKey: 'netflix',
  accountId: 'a1',
  categoryId: null,
  kind: 'expense',
  frequency: 'monthly',
  expectedAmountCents: 1599,
  amountMinCents: 1599,
  amountMaxCents: 1599,
  lastDate: `${month}-01`,
  nextDate: new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10),
  status: 'active',
  source: 'detected',
  notes: null,
};

vi.mock('@/lib/supabase', async () => {
  const core = await import('@budget/core');
  const session = { user: { id: 'u1', email: 'me@example.com' }, access_token: 'x' };
  return {
    isConfigured: true,
    supabase: {
      auth: {
        getSession: async () => ({ data: { session } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        signOut: async () => {},
      },
    },
    api: {
      categories: { list: async () => categories },
      accounts: {
        listAccounts: async () => [account],
        listConnections: async () => [
          {
            id: 'c1',
            institutionName: 'First Platypus Bank',
            status: 'active',
            statusDetail: null,
            lastSyncedAt: new Date().toISOString(),
            createdAt: '',
          },
        ],
      },
      transactions: {
        search: async () => ({ rows: [tx], total: 1 }),
        recent: async () => [tx],
        get: async () => tx,
        transferCandidates: async () => [],
      },
      budgets: {
        list: async () => [{ categoryId: 'dining', month: `${month}-01`, amountCents: 30000 }],
        loadMonth: async (m: string, cats: never[]) =>
          core.computeBudgetMonth({
            month: m,
            categories: cats,
            budgets: [{ categoryId: 'dining', month: `${month}-01`, amountCents: 1300 }],
            totals: totals as never,
          }),
      },
      reports: {
        categoryMonthTotals: async () => totals,
        merchantTotals: async () => [
          { merchantKey: 'chipotle', name: 'Chipotle', kind: 'expense', totalCents: -1250, lineCount: 1 },
        ],
      },
      rules: {
        list: async () => [
          {
            id: 'rule1',
            isEnabled: true,
            priority: 100,
            nameOperator: 'contains',
            nameValue: 'netflix',
            accountId: null,
            direction: null,
            amountMinCents: null,
            amountMaxCents: null,
            setCategoryId: 'dining',
            setKind: null,
            createdAt: '',
          },
        ],
      },
      recurring: { list: async () => [series] },
      goals: {
        list: async () => [
          {
            id: 'g1',
            name: 'Emergency fund',
            targetCents: 1000000,
            currentCents: 250000,
            accountId: null,
            targetDate: '2027-12-01',
            color: null,
            sortOrder: 1,
            isArchived: false,
          },
        ],
      },
      plaid: {},
    },
  };
});

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO;
  window.matchMedia ??= (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never;
});
afterEach(() => cleanup());

const routes: [string, string | RegExp][] = [
  ['/', 'Where your money went'],
  ['/transactions', 'Chipotle'],
  ['/transactions?tx=t1', 'From your bank'],
  ['/budget', 'Dining'],
  ['/recurring', 'Netflix'],
  ['/goals', 'Emergency fund'],
  ['/reports', 'Monthly spending'],
  ['/reports?tab=trends', 'Spending trends'],
  ['/reports?tab=budget', 'By category group'],
  ['/accounts', 'First Platypus Bank'],
  ['/settings', 'Categories'],
];

describe('pages render with data', () => {
  for (const [path, text] of routes) {
    it(path, async () => {
      window.history.pushState({}, '', path);
      vi.resetModules();
      const errors: unknown[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((...a) => {
        errors.push(a.join(' '));
      });
      const { App } = await import('@/app/App');
      render(<App />);
      expect((await screen.findAllByText(text, {}, { timeout: 5000 })).length).toBeGreaterThan(0);
      spy.mockRestore();
      const real = errors.filter(
        (e) => !String(e).includes('width(0) and height(0)') && !String(e).includes('The width('),
      );
      expect(real).toEqual([]);
    });
  }
});
