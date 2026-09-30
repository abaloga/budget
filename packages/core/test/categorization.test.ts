import { describe, expect, it } from 'vitest';

import {
  buildHistoryMap,
  createClassifier,
  findMatchingRule,
  kindAfterCategoryChange,
  normalizeMerchant,
  planRetroactiveRule,
  ruleMatches,
  type CategorizableTransaction,
  type RuleSubject,
} from '../src/index.ts';
import { category, rule } from './fixtures.ts';

const subject = (overrides: Partial<CategorizableTransaction> = {}): CategorizableTransaction => ({
  name: 'Chipotle',
  originalName: 'CHIPOTLE 1234 NEW YORK',
  originalMerchantName: 'Chipotle',
  merchantKey: 'chipotle',
  accountId: 'acc-1',
  amountCents: -1250,
  providerCategoryPrimary: null,
  providerCategoryDetailed: null,
  ...overrides,
});

describe('normalizeMerchant', () => {
  it.each([
    ['SQ *BLUE BOTTLE COFFEE', 'blue bottle coffee'],
    ['NETFLIX.COM', 'netflix'],
    ['Chipotle 1234', 'chipotle'],
    ['SHELL OIL 57444221400', 'shell oil'],
    ["TST* JOE'S PIZZA #12", 'joes pizza'],
    ['POS PURCHASE TRADER JOE S #552', 'trader joe s'],
    ['Purchase authorized on 09/12 Spotify USA', 'spotify usa'],
    ['1234567', '1234567'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeMerchant(raw)).toBe(expected);
  });

  it('is stable across months for the same merchant', () => {
    expect(normalizeMerchant('SPOTIFY P1A2B3C4D5')).toBe(normalizeMerchant('SPOTIFY P9Z8Y7X6W5'));
  });
});

describe('rules', () => {
  const tx: RuleSubject = subject();

  it('matches name contains / equals / starts_with case-insensitively', () => {
    expect(ruleMatches(rule({ nameOperator: 'contains', nameValue: 'chipot' }), tx)).toBe(true);
    expect(ruleMatches(rule({ nameOperator: 'equals', nameValue: 'CHIPOTLE' }), tx)).toBe(true);
    expect(ruleMatches(rule({ nameOperator: 'equals', nameValue: 'chipot' }), tx)).toBe(false);
    expect(ruleMatches(rule({ nameOperator: 'starts_with', nameValue: 'chipotle 12' }), tx)).toBe(true);
  });

  it('combines conditions with AND', () => {
    const r = rule({ nameOperator: 'contains', nameValue: 'chipotle', accountId: 'acc-2' });
    expect(ruleMatches(r, tx)).toBe(false);
    expect(ruleMatches(r, { ...tx, accountId: 'acc-2' })).toBe(true);
  });

  it('checks direction and amount range on magnitude', () => {
    expect(ruleMatches(rule({ direction: 'outflow' }), tx)).toBe(true);
    expect(ruleMatches(rule({ direction: 'inflow' }), tx)).toBe(false);
    expect(ruleMatches(rule({ amountMinCents: 1000, amountMaxCents: 1300 }), tx)).toBe(true);
    expect(ruleMatches(rule({ amountMinCents: 1300 }), tx)).toBe(false);
  });

  it('ignores disabled rules and honors priority order', () => {
    const low = rule({ nameOperator: 'contains', nameValue: 'chip', priority: 10, setKind: 'income' });
    const high = rule({ nameOperator: 'contains', nameValue: 'chip', priority: 1, setKind: 'transfer' });
    expect(findMatchingRule([low, high], tx)?.id).toBe(high.id);
    expect(findMatchingRule([low, { ...high, isEnabled: false }], tx)?.id).toBe(low.id);
  });

  it('applies retroactively without overriding explicit user choices', () => {
    const dining = category({ name: 'Dining' });
    const r = rule({ nameOperator: 'contains', nameValue: 'chipotle', setCategoryId: dining.id });
    const base = { ...subject(), kind: 'expense' as const, kindSource: 'auto' as const };
    const updates = planRetroactiveRule(r, [
      { ...base, id: 'a', categoryId: null, categorySource: 'none' },
      { ...base, id: 'b', categoryId: 'other', categorySource: 'user' },
      { ...base, id: 'c', categoryId: 'x', categorySource: 'provider' },
      { ...base, id: 'd', categoryId: dining.id, categorySource: 'rule' },
      {
        ...base,
        id: 'e',
        name: 'Target',
        originalName: 'TARGET',
        originalMerchantName: null,
        merchantKey: 'target',
        categoryId: null,
        categorySource: 'none',
      },
    ]);
    expect(updates.map((u) => u.id)).toEqual(['a', 'c']);
    expect(updates[0]).toMatchObject({ categoryId: dining.id, categorySource: 'rule' });
  });
});

describe('classifier', () => {
  const income = category({ name: 'Income', kind: 'income', systemKey: 'income' });
  const dining = category({ name: 'Dining', systemKey: 'dining' });
  const groceries = category({ name: 'Groceries', systemKey: 'groceries' });
  const subscriptions = category({ name: 'Subscriptions', systemKey: 'subscriptions' });
  const categories = [income, dining, groceries, subscriptions];

  it('uses rules first, then history, then provider categories', () => {
    const c = createClassifier({
      rules: [rule({ nameOperator: 'contains', nameValue: 'chipotle', setCategoryId: groceries.id })],
      history: buildHistoryMap([{ merchantKey: 'chipotle', categoryId: subscriptions.id, kind: null }]),
      categories,
    });
    const tx = subject({ providerCategoryPrimary: 'FOOD_AND_DRINK' });
    expect(c.classify(tx)).toMatchObject({ categoryId: groceries.id, categorySource: 'rule', kind: 'expense' });

    const noRule = createClassifier({
      rules: [],
      history: buildHistoryMap([{ merchantKey: 'chipotle', categoryId: subscriptions.id, kind: null }]),
      categories,
    });
    expect(noRule.classify(tx)).toMatchObject({ categoryId: subscriptions.id, categorySource: 'history' });

    const providerOnly = createClassifier({ rules: [], history: new Map(), categories });
    expect(providerOnly.classify(tx)).toMatchObject({ categoryId: dining.id, categorySource: 'provider' });
  });

  it('prefers detailed provider categories', () => {
    const c = createClassifier({ rules: [], history: new Map(), categories });
    const tx = subject({
      providerCategoryPrimary: 'FOOD_AND_DRINK',
      providerCategoryDetailed: 'FOOD_AND_DRINK_GROCERIES',
    });
    expect(c.classify(tx).categoryId).toBe(groceries.id);
  });

  it('skips archived categories', () => {
    const c = createClassifier({
      rules: [],
      history: new Map(),
      categories: [{ ...dining, isArchived: true }, groceries],
    });
    expect(c.classify(subject({ providerCategoryPrimary: 'FOOD_AND_DRINK' })).categoryId).toBeNull();
  });

  it('classifies income and credit-card payments', () => {
    const c = createClassifier({ rules: [], history: new Map(), categories });
    const paycheck = c.classify(
      subject({
        name: 'ACME PAYROLL',
        amountCents: 250000,
        providerCategoryPrimary: 'INCOME',
        providerCategoryDetailed: 'INCOME_WAGES',
      }),
    );
    expect(paycheck).toMatchObject({ kind: 'income', categoryId: income.id });

    const cardPayment = c.classify(
      subject({
        name: 'CHASE CREDIT CRD AUTOPAY',
        amountCents: -10000,
        providerCategoryPrimary: 'LOAN_PAYMENTS',
        providerCategoryDetailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
      }),
    );
    expect(cardPayment).toMatchObject({ kind: 'transfer', categoryId: null });
  });

  it('never auto-assigns an income category to money going out', () => {
    const c = createClassifier({ rules: [], history: new Map(), categories });
    const out = c.classify(subject({ amountCents: -500, providerCategoryPrimary: 'INCOME' }));
    expect(out.categoryId).toBeNull();
    expect(out.kind).toBe('expense');
  });

  it('learns the kind from history (e.g. user marked a merchant as transfer)', () => {
    const c = createClassifier({
      rules: [],
      history: buildHistoryMap([{ merchantKey: 'venmo', categoryId: null, kind: 'transfer' }]),
      categories,
    });
    expect(c.classify(subject({ merchantKey: 'venmo' })).kind).toBe('transfer');
  });

  it('lets a rule set only the kind while history still picks the category', () => {
    const c = createClassifier({
      rules: [rule({ nameOperator: 'contains', nameValue: 'chipotle', setKind: 'income' })],
      history: buildHistoryMap([{ merchantKey: 'chipotle', categoryId: dining.id, kind: null }]),
      categories,
    });
    expect(c.classify(subject())).toMatchObject({ kind: 'income', kindSource: 'rule', categoryId: dining.id });
  });
});

describe('kindAfterCategoryChange', () => {
  it('follows the category unless the user chose the kind', () => {
    const income = category({ kind: 'income' });
    expect(kindAfterCategoryChange({ kind: 'expense', kindSource: 'auto' }, income).kind).toBe('income');
    expect(kindAfterCategoryChange({ kind: 'expense', kindSource: 'user' }, income).kind).toBe('expense');
    expect(kindAfterCategoryChange({ kind: 'transfer', kindSource: 'auto' }, income).kind).toBe('transfer');
  });
});
