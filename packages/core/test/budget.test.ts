import { describe, expect, it } from 'vitest';

import {
  budgetHistoryStart,
  budgetStatus,
  cashFlow,
  computeBudgetMonth,
  monthlyCashFlow,
  planCopyBudgets,
  savingsRate,
  type Budget,
} from '../src/index.ts';
import { category, total } from './fixtures.ts';

const food = category({ name: 'Food', sortOrder: 1 });
const dining = category({ name: 'Dining', parentId: food.id, sortOrder: 2 });
const groceries = category({ name: 'Groceries', parentId: food.id, sortOrder: 3 });
const shopping = category({ name: 'Shopping', sortOrder: 4 });
const income = category({ name: 'Income', kind: 'income', sortOrder: 0 });
const categories = [income, food, dining, groceries, shopping];

const budget = (categoryId: string, month: string, amountCents: number): Budget => ({ categoryId, month, amountCents });

describe('computeBudgetMonth', () => {
  it('reports budget, spent, remaining and percent per category', () => {
    const view = computeBudgetMonth({
      month: '2026-09-01',
      categories,
      budgets: [budget(dining.id, '2026-09-01', 30000), budget(groceries.id, '2026-09-01', 50000)],
      totals: [total('2026-09-01', dining.id, -25000), total('2026-09-01', groceries.id, -10000)],
    });

    const foodSection = view.sections.find((s) => s.row.categoryId === food.id)!;
    const diningRow = foodSection.children.find((c) => c.categoryId === dining.id)!;
    expect(diningRow).toMatchObject({
      budgetedCents: 30000,
      spentCents: 25000,
      remainingCents: 5000,
      status: 'ok',
    });
    expect(diningRow.percentUsed).toBeCloseTo(0.8333, 3);

    expect(foodSection.row).toMatchObject({ isGroup: true, budgetedCents: 80000, spentCents: 35000 });
    expect(view.summary).toMatchObject({ budgetedCents: 80000, spentCents: 35000, remainingCents: 45000 });
  });

  it('keeps months independent', () => {
    const view = computeBudgetMonth({
      month: '2026-10-01',
      categories,
      budgets: [budget(dining.id, '2026-09-01', 30000)],
      totals: [total('2026-09-01', dining.id, -25000)],
    });
    expect(view.summary.budgetedCents).toBe(0);
    expect(view.summary.spentCents).toBe(0);
  });

  it('excludes transfers and income from spending, and nets refunds', () => {
    const view = computeBudgetMonth({
      month: '2026-09-01',
      categories,
      budgets: [budget(shopping.id, '2026-09-01', 20000)],
      totals: [
        total('2026-09-01', shopping.id, -15000),
        total('2026-09-01', shopping.id, 3000), // refund within the expense kind
        total('2026-09-01', null, -50000, 'transfer'), // credit-card payment
        total('2026-09-01', income.id, 400000, 'income'),
      ],
    });
    const shoppingRow = view.sections.find((s) => s.row.categoryId === shopping.id)!.row;
    expect(shoppingRow.spentCents).toBe(12000);
    expect(view.summary.spentCents).toBe(12000);
    expect(view.summary.incomeCents).toBe(400000);
  });

  it('uses split lines (via totals) so a split parent is not double counted', () => {
    // A $150 Target purchase split 80/40/30 arrives as three per-category totals.
    const household = category({ name: 'Household', parentId: shopping.id });
    const clothing = category({ name: 'Clothing', parentId: shopping.id });
    const view = computeBudgetMonth({
      month: '2026-09-01',
      categories: [...categories, household, clothing],
      budgets: [],
      totals: [
        total('2026-09-01', groceries.id, -8000),
        total('2026-09-01', household.id, -4000),
        total('2026-09-01', clothing.id, -3000),
      ],
    });
    expect(view.summary.spentCents).toBe(15000);
  });

  it('flags approaching, exceeded and unbudgeted categories and overall overspending', () => {
    const view = computeBudgetMonth({
      month: '2026-09-01',
      categories,
      budgets: [budget(dining.id, '2026-09-01', 10000), budget(groceries.id, '2026-09-01', 10000)],
      totals: [
        total('2026-09-01', dining.id, -9000),
        total('2026-09-01', groceries.id, -12000),
        total('2026-09-01', shopping.id, -5000),
        total('2026-09-01', null, -1000),
      ],
    });
    const rows = view.sections.flatMap((s) => [s.row, ...s.children]);
    expect(rows.find((r) => r.categoryId === dining.id)?.status).toBe('warning');
    expect(rows.find((r) => r.categoryId === groceries.id)?.status).toBe('over');
    expect(rows.find((r) => r.categoryId === shopping.id)?.status).toBe('unbudgeted');
    expect(view.summary).toMatchObject({
      status: 'over',
      spentCents: 27000,
      uncategorizedSpentCents: 1000,
      unbudgetedSpentCents: 6000,
      overBudgetCategoryCount: 1,
      warningCategoryCount: 1,
    });
  });

  it('hides archived categories unless they have activity', () => {
    const old = category({ name: 'Old', isArchived: true });
    const quiet = computeBudgetMonth({ month: '2026-09-01', categories: [old], budgets: [], totals: [] });
    expect(quiet.sections).toHaveLength(0);
    const active = computeBudgetMonth({
      month: '2026-09-01',
      categories: [old],
      budgets: [],
      totals: [total('2026-09-01', old.id, -100)],
    });
    expect(active.sections).toHaveLength(1);
  });
});

describe('rollovers', () => {
  const rolling = category({ name: 'Dining', rolloverEnabled: true, rolloverStartMonth: '2026-09-01' });

  it('carries unused budget into the next month', () => {
    // September: $300 budget, $250 spent -> $50 unused. October: $300 + $50.
    const view = computeBudgetMonth({
      month: '2026-10-01',
      categories: [rolling],
      budgets: [budget(rolling.id, '2026-09-01', 30000), budget(rolling.id, '2026-10-01', 30000)],
      totals: [total('2026-09-01', rolling.id, -25000)],
    });
    expect(view.sections[0]!.row).toMatchObject({
      budgetedCents: 30000,
      rolloverCents: 5000,
      availableCents: 35000,
      remainingCents: 35000,
    });
  });

  it('carries overspending forward as a reduction', () => {
    const view = computeBudgetMonth({
      month: '2026-10-01',
      categories: [rolling],
      budgets: [budget(rolling.id, '2026-09-01', 30000), budget(rolling.id, '2026-10-01', 30000)],
      totals: [total('2026-09-01', rolling.id, -34000), total('2026-10-01', rolling.id, -27000)],
    });
    expect(view.sections[0]!.row).toMatchObject({
      rolloverCents: -4000,
      availableCents: 26000,
      spentCents: 27000,
      remainingCents: -1000,
      status: 'over',
    });
  });

  it('accumulates across several months, including months without a budget row', () => {
    const view = computeBudgetMonth({
      month: '2026-12-01',
      categories: [rolling],
      budgets: [budget(rolling.id, '2026-09-01', 10000), budget(rolling.id, '2026-11-01', 10000)],
      totals: [
        total('2026-09-01', rolling.id, -5000), // +5000
        total('2026-10-01', rolling.id, -2000), // 0 budget: carry 3000
        total('2026-11-01', rolling.id, -1000), // +9000 -> 12000
      ],
    });
    expect(view.sections[0]!.row.rolloverCents).toBe(12000);
  });

  it('does nothing for categories without rollover or before the start month', () => {
    const plain = { ...rolling, rolloverEnabled: false };
    const view = computeBudgetMonth({
      month: '2026-10-01',
      categories: [plain],
      budgets: [budget(plain.id, '2026-09-01', 30000), budget(plain.id, '2026-10-01', 30000)],
      totals: [total('2026-09-01', plain.id, -25000)],
    });
    expect(view.sections[0]!.row.rolloverCents).toBe(0);

    const late = { ...rolling, rolloverStartMonth: '2026-10-01' };
    const view2 = computeBudgetMonth({
      month: '2026-10-01',
      categories: [late],
      budgets: [budget(late.id, '2026-09-01', 30000), budget(late.id, '2026-10-01', 30000)],
      totals: [total('2026-09-01', late.id, -25000)],
    });
    expect(view2.sections[0]!.row.rolloverCents).toBe(0);
  });

  it('defaults the start to the first budgeted month and reports how much history is needed', () => {
    const noStart = { ...rolling, rolloverStartMonth: null };
    const budgets = [budget(noStart.id, '2026-07-01', 10000), budget(noStart.id, '2026-10-01', 10000)];
    expect(budgetHistoryStart([noStart], '2026-10-01', budgets)).toBe('2026-07-01');
    const view = computeBudgetMonth({ month: '2026-10-01', categories: [noStart], budgets, totals: [] });
    expect(view.sections[0]!.row.rolloverCents).toBe(10000);
  });
});

describe('budgetStatus', () => {
  it('uses the warning threshold', () => {
    expect(budgetStatus(10000, 0, 8499)).toBe('ok');
    expect(budgetStatus(10000, 0, 8500)).toBe('warning');
    expect(budgetStatus(10000, 0, 10000)).toBe('warning');
    expect(budgetStatus(10000, 0, 10001)).toBe('over');
    expect(budgetStatus(0, 0, 0)).toBe('none');
    expect(budgetStatus(0, 0, 1)).toBe('unbudgeted');
    expect(budgetStatus(0, -500, 0)).toBe('over'); // behind from last month
  });
});

describe('planCopyBudgets', () => {
  it('copies non-zero amounts without overwriting existing budgets', () => {
    const plan = planCopyBudgets(
      [budget('a', '2026-09-01', 100), budget('b', '2026-09-01', 200), budget('c', '2026-09-01', 0)],
      [budget('b', '2026-10-01', 999)],
      '2026-10-01',
    );
    expect(plan).toEqual([budget('a', '2026-10-01', 100)]);
  });
});

describe('cash flow', () => {
  it('computes income - expenses = net and ignores transfers', () => {
    const cf = cashFlow([
      { kind: 'income', totalCents: 500000 },
      { kind: 'expense', totalCents: -320000 },
      { kind: 'expense', totalCents: 20000 }, // refunds
      { kind: 'transfer', totalCents: -100000 },
      { kind: 'transfer', totalCents: 100000 },
    ]);
    expect(cf).toEqual({ incomeCents: 500000, expenseCents: 300000, netCents: 200000 });
    expect(savingsRate(cf)).toBeCloseTo(0.4);
  });

  it('zero-fills months', () => {
    const series = monthlyCashFlow(
      [total('2026-08-01', null, 1000, 'income'), total('2026-08-01', null, -400)],
      ['2026-07-01', '2026-08-01'],
    );
    expect(series).toEqual([
      { month: '2026-07-01', incomeCents: 0, expenseCents: 0, netCents: 0 },
      { month: '2026-08-01', incomeCents: 1000, expenseCents: 400, netCents: 600 },
    ]);
  });
});
