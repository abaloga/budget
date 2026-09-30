import { describe, expect, it } from 'vitest';

import {
  amountsByCategory,
  amountsByMerchant,
  balanceTotals,
  categoryTrend,
  classifyInterval,
  detectRecurring,
  goalProgress,
  groupAccountsByInstitution,
  monthlyEquivalent,
  monthlyTotals,
  monthsUntil,
  nextOccurrence,
  percentChange,
  planRecurringUpdates,
  upcomingBills,
  type RecurringInput,
} from '../src/index.ts';
import { account, category, series, total } from './fixtures.ts';

describe('recurring schedule math', () => {
  it('computes next dates for each frequency, keeping the anchor day', () => {
    expect(nextOccurrence('2026-09-05', 'weekly')).toBe('2026-09-12');
    expect(nextOccurrence('2026-09-05', 'biweekly')).toBe('2026-09-19');
    expect(nextOccurrence('2026-01-31', 'monthly', 31)).toBe('2026-02-28');
    expect(nextOccurrence('2026-02-28', 'monthly', 31)).toBe('2026-03-31');
    expect(nextOccurrence('2026-11-30', 'quarterly', 30)).toBe('2027-02-28');
    expect(nextOccurrence('2026-03-15', 'annual')).toBe('2027-03-15');
  });

  it('classifies intervals', () => {
    expect(classifyInterval(7)).toBe('weekly');
    expect(classifyInterval(14)).toBe('biweekly');
    expect(classifyInterval(31)).toBe('monthly');
    expect(classifyInterval(365)).toBe('annual');
    expect(classifyInterval(45)).toBeNull();
  });

  it('estimates monthly cost', () => {
    expect(monthlyEquivalent(1000, 'monthly')).toBe(1000);
    expect(monthlyEquivalent(12000, 'annual')).toBe(1000);
  });
});

describe('detectRecurring', () => {
  const make = (
    merchantKey: string,
    dates: string[],
    amounts: number[] | number,
    extra: Partial<RecurringInput> = {},
  ) =>
    dates.map((date, i) => ({
      id: `${merchantKey}-${i}`,
      date,
      amountCents: Array.isArray(amounts) ? amounts[i]! : amounts,
      merchantKey,
      name: merchantKey,
      accountId: 'acc-1',
      categoryId: 'cat-subs',
      kind: 'expense' as const,
      pending: false,
      ...extra,
    }));

  it('finds a monthly subscription and predicts the next date', () => {
    const txns = make('netflix', ['2026-06-05', '2026-07-05', '2026-08-05', '2026-09-05'], -1599);
    const [found] = detectRecurring(txns, '2026-09-20');
    expect(found).toMatchObject({
      merchantKey: 'netflix',
      frequency: 'monthly',
      expectedAmountCents: 1599,
      nextDate: '2026-10-05',
      kind: 'expense',
      accountId: 'acc-1',
    });
    expect(found!.transactionIds).toHaveLength(4);
  });

  it('tolerates variable utility bills', () => {
    const txns = make(
      'con edison',
      ['2026-06-12', '2026-07-13', '2026-08-12', '2026-09-11'],
      [-8420, -9310, -10150, -8890],
    );
    const [found] = detectRecurring(txns, '2026-09-20');
    expect(found?.frequency).toBe('monthly');
    expect(found?.amountMinCents).toBe(8420);
    expect(found?.amountMaxCents).toBe(10150);
  });

  it('detects biweekly paychecks as income', () => {
    const txns = make('acme payroll', ['2026-08-07', '2026-08-21', '2026-09-04', '2026-09-18'], 250000, {
      kind: 'income',
    });
    const [found] = detectRecurring(txns, '2026-09-20');
    expect(found).toMatchObject({ frequency: 'biweekly', kind: 'income', nextDate: '2026-10-02' });
  });

  it('ignores irregular merchants, transfers, pending and stale series', () => {
    const irregular = make(
      'target',
      ['2026-06-02', '2026-06-20', '2026-08-15', '2026-09-01'],
      [-4000, -1200, -8800, -2500],
    );
    const transfer = make('savings xfer', ['2026-07-01', '2026-08-01', '2026-09-01'], -50000, { kind: 'transfer' });
    const stale = make('old gym', ['2026-01-10', '2026-02-10', '2026-03-10'], -4000);
    expect(detectRecurring([...irregular, ...transfer, ...stale], '2026-09-20')).toEqual([]);
  });

  it('accepts two occurrences for annual charges with matching amounts', () => {
    const txns = make('amazon prime', ['2025-03-14', '2026-03-14'], -13900);
    const [found] = detectRecurring(txns, '2026-09-20');
    expect(found).toMatchObject({ frequency: 'annual', nextDate: '2027-03-14' });
    // ...but not when the amounts disagree
    expect(detectRecurring(make('random', ['2025-03-14', '2026-03-14'], [-13900, -5000]), '2026-09-20')).toEqual([]);
  });

  it('reconciles with stored series: never resurrects ignored, keeps manual edits', () => {
    const detected = detectRecurring(
      make('netflix', ['2026-07-05', '2026-08-05', '2026-09-05'], -1599).concat(
        make('spotify', ['2026-07-10', '2026-08-10', '2026-09-10'], -1199),
        make('hulu', ['2026-07-12', '2026-08-12', '2026-09-12'], -999),
      ),
      '2026-09-20',
    );
    const plan = planRecurringUpdates(detected, [
      { id: 's1', merchantKey: 'netflix', status: 'ignored', source: 'detected', lastDate: '2026-08-05' },
      { id: 's2', merchantKey: 'spotify', status: 'active', source: 'manual', lastDate: '2026-08-10' },
    ]);
    expect(plan.inserts.map((d) => d.merchantKey)).toEqual(['hulu']);
    expect(plan.updates).toEqual([expect.objectContaining({ id: 's2', scheduleOnly: true })]);
    expect(plan.links.some((l) => l.merchantKey === 'netflix')).toBe(false);
  });
});

describe('upcomingBills', () => {
  it('lists occurrences in the horizon and highlights soon/overdue', () => {
    const bills = upcomingBills(
      [
        series({
          id: 'rent',
          name: 'Rent',
          expectedAmountCents: 200000,
          lastDate: '2026-09-01',
          nextDate: '2026-10-01',
        }),
        series({ id: 'gym', name: 'Gym', lastDate: '2026-08-27', nextDate: '2026-09-27' }),
        series({ id: 'pay', name: 'Paycheck', kind: 'income', frequency: 'biweekly', nextDate: '2026-10-02' }),
        series({ id: 'off', name: 'Ignored', status: 'ignored', nextDate: '2026-10-03' }),
      ],
      '2026-09-29',
      { horizonDays: 30, soonDays: 3 },
    );
    expect(bills.map((b) => [b.seriesId, b.date, b.urgency])).toEqual([
      ['gym', '2026-09-27', 'overdue'],
      ['rent', '2026-10-01', 'soon'],
      ['gym', '2026-10-27', 'upcoming'],
    ]);
  });

  it('rolls long-missed occurrences forward instead of showing stale dates', () => {
    const bills = upcomingBills([series({ lastDate: '2026-05-05', nextDate: '2026-06-05' })], '2026-09-29');
    expect(bills[0]?.date).toBe('2026-10-05');
  });
});

describe('goals', () => {
  it('computes progress and monthly contribution to hit the target date', () => {
    const p = goalProgress(
      { targetCents: 1_000_000, currentCents: 400_000, targetDate: '2027-03-29', accountId: null },
      '2026-09-29',
    );
    expect(p).toMatchObject({ remainingCents: 600_000, percent: 0.4, monthsRemaining: 6, monthlyNeededCents: 100_000 });
  });

  it('uses the linked account balance and caps progress at 100%', () => {
    const p = goalProgress(
      { targetCents: 50_000, currentCents: 0, targetDate: null, accountId: 'sav' },
      '2026-09-29',
      80_000,
    );
    expect(p).toMatchObject({ currentCents: 80_000, percent: 1, isComplete: true, monthlyNeededCents: null });
  });

  it('needs the full remainder when the date has passed', () => {
    const p = goalProgress(
      { targetCents: 1000, currentCents: 200, targetDate: '2026-08-01', accountId: null },
      '2026-09-29',
    );
    expect(p).toMatchObject({ isPastDue: true, monthlyNeededCents: 800 });
  });

  it('counts only whole months remaining', () => {
    expect(monthsUntil('2026-09-29', '2026-10-15')).toBe(0);
    expect(monthsUntil('2026-09-15', '2026-10-15')).toBe(1);
  });
});

describe('reports', () => {
  const food = category({ name: 'Food', color: '#f00' });
  const dining = category({ name: 'Dining', parentId: food.id });
  const groceries = category({ name: 'Groceries', parentId: food.id });
  const travel = category({ name: 'Travel' });
  const cats = [food, dining, groceries, travel];
  const totals = [
    total('2026-08-01', dining.id, -20000),
    total('2026-09-01', dining.id, -30000),
    total('2026-09-01', groceries.id, -50000),
    total('2026-09-01', travel.id, -40000),
    total('2026-09-01', null, -10000),
    total('2026-09-01', null, -99999, 'transfer'),
    total('2026-09-01', null, 300000, 'income'),
  ];

  it('ranks spending by category and rolls up to groups', () => {
    const sept = totals.filter((t) => t.month === '2026-09-01');
    const byCat = amountsByCategory(sept, cats);
    expect(byCat.map((r) => [r.name, r.amountCents])).toEqual([
      ['Groceries', 50000],
      ['Travel', 40000],
      ['Dining', 30000],
      ['Uncategorized', 10000],
    ]);
    const byGroup = amountsByCategory(sept, cats, { level: 'group' });
    expect(byGroup[0]).toMatchObject({ name: 'Food', amountCents: 80000 });
    expect(byGroup[0]!.share).toBeCloseTo(80000 / 130000);
  });

  it('builds zero-filled monthly series and trends', () => {
    expect(monthlyTotals(totals, ['2026-07-01', '2026-08-01', '2026-09-01'], 'expense')).toEqual([
      { month: '2026-07-01', amountCents: 0 },
      { month: '2026-08-01', amountCents: 20000 },
      { month: '2026-09-01', amountCents: 130000 },
    ]);
    const trend = categoryTrend(totals, cats, ['2026-08-01', '2026-09-01'], [food.id]);
    expect(trend.map((r) => r.values[food.id])).toEqual([20000, 80000]);
    expect(percentChange(20000, 80000)).toBe(3);
  });

  it('ranks merchants', () => {
    const rows = amountsByMerchant(
      [
        { merchantKey: 'a', name: 'A', kind: 'expense', totalCents: -500, lineCount: 1 },
        { merchantKey: 'b', name: 'B', kind: 'expense', totalCents: -1500, lineCount: 3 },
        { merchantKey: 'p', name: 'Payroll', kind: 'income', totalCents: 9000, lineCount: 2 },
      ],
      'expense',
    );
    expect(rows.map((r) => r.name)).toEqual(['B', 'A']);
    expect(rows[0]!.share).toBe(0.75);
  });
});

describe('accounts', () => {
  it('groups by institution and totals cash vs credit owed without mixing them', () => {
    const chk = account({ connectionId: 'c1', type: 'depository', currentBalanceCents: 250000 });
    const card = account({ connectionId: 'c1', type: 'credit', currentBalanceCents: 42000, name: 'Sapphire' });
    const hidden = account({ connectionId: 'c2', currentBalanceCents: 999, isHidden: true });
    const groups = groupAccountsByInstitution(
      [
        {
          id: 'c2',
          institutionName: 'Zeta Bank',
          status: 'active',
          statusDetail: null,
          lastSyncedAt: null,
          createdAt: '',
        },
        { id: 'c1', institutionName: 'Chase', status: 'active', statusDetail: null, lastSyncedAt: null, createdAt: '' },
      ],
      [chk, card, hidden],
    );
    expect(groups.map((g) => [g.connection.institutionName, g.accounts.length])).toEqual([
      ['Chase', 2],
      ['Zeta Bank', 0],
    ]);
    expect(balanceTotals([chk, card, hidden])).toEqual({ cashCents: 250000, creditOwedCents: 42000 });
  });
});
