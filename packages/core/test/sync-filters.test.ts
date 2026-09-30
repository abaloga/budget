import { describe, expect, it } from 'vitest';

import {
  createClassifier,
  filtersFromParams,
  filtersToParams,
  fromPlaidAccount,
  fromPlaidTransaction,
  matchesFilters,
  planTransactionSync,
  referencedProviderIds,
  type PlaidTransaction,
  type ProviderTransaction,
  type SyncPlanInput,
} from '../src/index.ts';
import { category, transaction } from './fixtures.ts';

const dining = category({ name: 'Dining', systemKey: 'dining' });
const classifier = createClassifier({ rules: [], history: new Map(), categories: [dining] });

const plaidTx = (overrides: Partial<PlaidTransaction> = {}): PlaidTransaction => ({
  transaction_id: 'tx-1',
  account_id: 'plaid-acc-1',
  amount: 12.5,
  iso_currency_code: 'USD',
  date: '2026-09-10',
  authorized_date: '2026-09-09',
  name: 'CHIPOTLE 1234',
  merchant_name: 'Chipotle',
  pending: false,
  pending_transaction_id: null,
  payment_channel: 'in store',
  personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_RESTAURANT' },
  ...overrides,
});

const p = (overrides: Partial<PlaidTransaction> = {}): ProviderTransaction => fromPlaidTransaction(plaidTx(overrides));

const input = (overrides: Partial<SyncPlanInput> = {}): SyncPlanInput => ({
  added: [],
  modified: [],
  removedIds: [],
  existing: [],
  accountIds: new Map([['plaid-acc-1', 'acc-uuid-1']]),
  classifier,
  ...overrides,
});

describe('Plaid mapping', () => {
  it('flips the amount sign so money out is negative', () => {
    expect(p({ amount: 12.5 }).amountCents).toBe(-1250);
    expect(p({ amount: -2500 }).amountCents).toBe(250000);
  });

  it('maps accounts and balances to cents', () => {
    const a = fromPlaidAccount({
      account_id: 'x',
      name: 'Card',
      official_name: null,
      mask: '0001',
      type: 'credit',
      subtype: 'credit card',
      balances: { current: 410.12, available: 4589.88, limit: 5000, iso_currency_code: 'USD' },
    });
    expect(a).toMatchObject({ type: 'credit', currentBalanceCents: 41012, creditLimitCents: 500000 });
  });
});

describe('planTransactionSync', () => {
  it('classifies new transactions and normalizes merchants', () => {
    const plan = planTransactionSync(input({ added: [p()] }));
    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0]).toMatchObject({
      accountId: 'acc-uuid-1',
      amountCents: -1250,
      merchantKey: 'chipotle',
      isNew: true,
      classification: { categoryId: dining.id, categorySource: 'provider', kind: 'expense' },
    });
  });

  it('does not reclassify existing rows (user edits stay put)', () => {
    const plan = planTransactionSync(
      input({
        modified: [p({ name: 'CHIPOTLE UPDATED' })],
        existing: [{ id: 'row-1', providerTransactionId: 'tx-1', amountCents: -1250, splits: [] }],
      }),
    );
    expect(plan.upserts[0]).toMatchObject({ isNew: false, classification: { categorySource: 'none' } });
  });

  it('de-duplicates the same id appearing in added and modified', () => {
    const plan = planTransactionSync(input({ added: [p({ amount: 10 })], modified: [p({ amount: 11 })] }));
    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0]!.amountCents).toBe(-1100);
  });

  it('rekeys pending -> posted onto the existing row and does not remove it', () => {
    const plan = planTransactionSync(
      input({
        added: [p({ transaction_id: 'posted-1', pending_transaction_id: 'pending-1', amount: 24 })],
        removedIds: ['pending-1'],
        existing: [{ id: 'row-1', providerTransactionId: 'pending-1', amountCents: -2000, splits: [] }],
      }),
    );
    expect(plan.rekeys).toEqual([{ fromId: 'pending-1', toId: 'posted-1' }]);
    expect(plan.removed).toEqual([]);
    expect(plan.upserts[0]!.isNew).toBe(false);
  });

  it('removes the pending row normally when the posted row already exists (replay)', () => {
    const plan = planTransactionSync(
      input({
        added: [p({ transaction_id: 'posted-1', pending_transaction_id: 'pending-1' })],
        removedIds: ['pending-1'],
        existing: [
          { id: 'row-1', providerTransactionId: 'posted-1', amountCents: -1250, splits: [] },
          { id: 'row-2', providerTransactionId: 'pending-1', amountCents: -1250, splits: [] },
        ],
      }),
    );
    expect(plan.rekeys).toEqual([]);
    expect(plan.removed).toEqual(['pending-1']);
  });

  it('inserts posted transactions whose pending version was never seen', () => {
    const plan = planTransactionSync(
      input({ added: [p({ transaction_id: 'posted-1', pending_transaction_id: 'never-seen' })] }),
    );
    expect(plan.rekeys).toEqual([]);
    expect(plan.upserts[0]!.isNew).toBe(true);
  });

  it('rebalances or clears splits when the posted amount changes', () => {
    const plan = planTransactionSync(
      input({
        added: [p({ transaction_id: 'posted-1', pending_transaction_id: 'pending-1', amount: 105 })],
        existing: [
          {
            id: 'row-1',
            providerTransactionId: 'pending-1',
            amountCents: -10000,
            splits: [
              { id: 's1', amountCents: -8000 },
              { id: 's2', amountCents: -2000 },
            ],
          },
        ],
      }),
    );
    expect(plan.splitUpdates).toEqual([{ splitId: 's1', amountCents: -8500 }]);

    const flipped = planTransactionSync(
      input({
        modified: [p({ amount: -100 })],
        existing: [
          {
            id: 'row-1',
            providerTransactionId: 'tx-1',
            amountCents: -10000,
            splits: [
              { id: 's1', amountCents: -5000 },
              { id: 's2', amountCents: -5000 },
            ],
          },
        ],
      }),
    );
    expect(flipped.splitClears).toEqual(['row-1']);
  });

  it('skips transactions for accounts it does not know', () => {
    const plan = planTransactionSync(input({ added: [p({ account_id: 'mystery' })] }));
    expect(plan.upserts).toEqual([]);
    expect(plan.skipped).toEqual([{ providerTransactionId: 'tx-1', reason: 'unknown_account' }]);
  });

  it('lists every id that must be looked up', () => {
    expect(
      referencedProviderIds(
        [p({ transaction_id: 'a', pending_transaction_id: 'b' })],
        [p({ transaction_id: 'c' })],
      ).sort(),
    ).toEqual(['a', 'b', 'c']);
  });
});

describe('filters', () => {
  const tx = transaction({
    name: 'Whole Foods',
    originalName: 'WHOLEFDS MKT 123',
    amountCents: -8250,
    categoryId: 'groceries',
    accountId: 'acc-1',
    date: '2026-09-12',
  });

  it('combines filters with AND', () => {
    expect(matchesFilters(tx, { search: 'whole', categoryIds: ['groceries'], accountIds: ['acc-1'] })).toBe(true);
    expect(matchesFilters(tx, { search: 'whole', categoryIds: ['dining'] })).toBe(false);
    expect(matchesFilters(tx, { minAmountCents: 5000, maxAmountCents: 9000 })).toBe(true);
    expect(matchesFilters(tx, { minAmountCents: 9000 })).toBe(false);
    expect(matchesFilters(tx, { startDate: '2026-09-13' })).toBe(false);
    expect(matchesFilters(tx, { kinds: ['income', 'transfer'] })).toBe(false);
    expect(matchesFilters(tx, { status: 'posted' })).toBe(true);
    expect(matchesFilters(tx, { search: 'wholefds' })).toBe(true);
  });

  it('matches categories through splits', () => {
    const split = { ...tx, categoryId: null, splits: [{ categoryId: 'household', amountCents: -8250 }] };
    expect(matchesFilters(split, { categoryIds: ['household'] })).toBe(true);
    expect(matchesFilters(split, { uncategorized: true })).toBe(false);
  });

  it('round-trips through URL params', () => {
    const f = {
      search: 'coffee',
      categoryIds: ['a', 'b'],
      minAmountCents: 500,
      status: 'pending' as const,
      kinds: ['expense' as const],
    };
    const params = filtersToParams(f, { field: 'amount', descending: false });
    const back = filtersFromParams((k) => params[k] ?? null);
    expect(back.filters).toEqual(f);
    expect(back.sort).toEqual({ field: 'amount', descending: false });
  });
});
