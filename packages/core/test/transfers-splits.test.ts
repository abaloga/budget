import { describe, expect, it } from 'vitest';

import {
  cashFlow,
  findTransferPairs,
  rebalanceSplits,
  toLines,
  validateSplits,
  type TransferCandidate,
} from '../src/index.ts';
import { transaction } from './fixtures.ts';

const cand = (overrides: Partial<TransferCandidate>): TransferCandidate => ({
  id: 'x',
  accountId: 'checking',
  accountType: 'depository',
  date: '2026-09-10',
  amountCents: -10000,
  name: 'Something',
  kind: 'expense',
  kindSource: 'auto',
  transferPairId: null,
  providerCategoryPrimary: null,
  providerCategoryDetailed: null,
  ...overrides,
});

describe('findTransferPairs', () => {
  it('pairs a checking payment with the credit card payment received', () => {
    const pairs = findTransferPairs([
      cand({ id: 'out', name: 'CHASE CREDIT CRD AUTOPAY' }),
      cand({
        id: 'in',
        accountId: 'card',
        accountType: 'credit',
        amountCents: 10000,
        name: 'Payment Thank You',
        date: '2026-09-11',
      }),
    ]);
    expect(pairs).toEqual([{ outflowId: 'out', inflowId: 'in' }]);
  });

  it('pairs savings transfers flagged by the provider', () => {
    const pairs = findTransferPairs([
      cand({
        id: 'out',
        name: 'Online Transfer',
        providerCategoryPrimary: 'TRANSFER_OUT',
        providerCategoryDetailed: 'TRANSFER_OUT_SAVINGS',
      }),
      cand({ id: 'in', accountId: 'savings', amountCents: 10000, name: 'Deposit' }),
    ]);
    expect(pairs).toHaveLength(1);
  });

  it('does not pair unrelated equal amounts without a transfer signal', () => {
    const pairs = findTransferPairs([
      cand({ id: 'out', name: 'Netflix', amountCents: -1599 }),
      cand({ id: 'in', accountId: 'savings', amountCents: 1599, name: 'Refund Amazon' }),
    ]);
    expect(pairs).toEqual([]);
  });

  it('requires different accounts, a time window and opposite amounts', () => {
    expect(
      findTransferPairs([cand({ id: 'a', name: 'transfer' }), cand({ id: 'b', amountCents: 10000, name: 'transfer' })]),
    ).toEqual([]);
    expect(
      findTransferPairs([
        cand({ id: 'a', name: 'transfer' }),
        cand({ id: 'b', accountId: 'savings', amountCents: 10000, date: '2026-09-20', name: 'transfer' }),
      ]),
    ).toEqual([]);
    expect(
      findTransferPairs([
        cand({ id: 'a', name: 'transfer' }),
        cand({ id: 'b', accountId: 'savings', amountCents: 9999, name: 'transfer' }),
      ]),
    ).toEqual([]);
  });

  it('uses each transaction at most once, preferring the closest date', () => {
    const pairs = findTransferPairs([
      cand({ id: 'out', name: 'transfer', date: '2026-09-10' }),
      cand({ id: 'in-far', accountId: 'savings', amountCents: 10000, date: '2026-09-13', name: 'transfer' }),
      cand({ id: 'in-near', accountId: 'savings2', amountCents: 10000, date: '2026-09-10', name: 'transfer' }),
    ]);
    expect(pairs).toEqual([{ outflowId: 'out', inflowId: 'in-near' }]);
  });

  it('respects a user decision that something is not a transfer', () => {
    const pairs = findTransferPairs([
      cand({ id: 'out', name: 'transfer', kindSource: 'user', kind: 'expense' }),
      cand({ id: 'in', accountId: 'savings', amountCents: 10000, name: 'transfer' }),
    ]);
    expect(pairs).toEqual([]);
  });

  it('keeps a credit-card payment out of spending (card purchase counted once)', () => {
    const purchase = transaction({ kind: 'expense', amountCents: -10000, accountId: 'card' });
    const payment = transaction({ kind: 'transfer', amountCents: -10000, accountId: 'checking' });
    const received = transaction({ kind: 'transfer', amountCents: 10000, accountId: 'card' });
    const cf = cashFlow([purchase, payment, received].flatMap((t) => toLines(t)));
    expect(cf).toEqual({ incomeCents: 0, expenseCents: 10000, netCents: -10000 });
  });
});

describe('splits', () => {
  it('validates totals, sign and minimum parts', () => {
    expect(
      validateSplits(-15000, [
        { categoryId: 'g', amountCents: -8000 },
        { categoryId: 'h', amountCents: -4000 },
        { categoryId: 'c', amountCents: -3000 },
      ]).ok,
    ).toBe(true);

    const short = validateSplits(-15000, [
      { categoryId: 'g', amountCents: -8000 },
      { categoryId: 'h', amountCents: -4000 },
    ]);
    expect(short.ok).toBe(false);
    expect(short.remainingCents).toBe(-3000);

    expect(validateSplits(-100, [{ categoryId: 'g', amountCents: -100 }]).ok).toBe(false);
    expect(
      validateSplits(-100, [
        { categoryId: 'g', amountCents: -150 },
        { categoryId: 'h', amountCents: 50 },
      ]).errors,
    ).toContain('Part 2 must go in the same direction as the transaction.');
  });

  it('expands split transactions into lines instead of counting the parent', () => {
    const tx = transaction({ amountCents: -15000, categoryId: 'shopping' });
    const lines = toLines(tx, [
      { id: 's1', categoryId: 'groceries', amountCents: -8000 },
      { id: 's2', categoryId: 'household', amountCents: -4000 },
      { id: 's3', categoryId: 'clothing', amountCents: -3000 },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines.reduce((a, l) => a + l.amountCents, 0)).toBe(-15000);
    expect(lines.map((l) => l.categoryId)).not.toContain('shopping');
    expect(toLines(tx)).toHaveLength(1);
  });

  it('rebalances into the largest part when the provider changes the amount', () => {
    const splits = [
      { id: 'a', amountCents: -8000 },
      { id: 'b', amountCents: -2000 },
    ];
    expect(rebalanceSplits(splits, -10000)).toEqual({ type: 'unchanged' });
    expect(rebalanceSplits(splits, -10500)).toEqual({
      type: 'update',
      updates: [{ splitId: 'a', amountCents: -8500 }],
    });
    expect(rebalanceSplits(splits, -1500)).toEqual({ type: 'clear' }); // would flip the largest part
    expect(rebalanceSplits(splits, 10000)).toEqual({ type: 'clear' }); // direction changed
  });
});
