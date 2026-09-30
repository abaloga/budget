import type {
  Account,
  CategorizationRule,
  Category,
  CategoryMonthTotal,
  RecurringSeries,
  Transaction,
} from '../src/index.ts';

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

export function category(overrides: Partial<Category> = {}): Category {
  return {
    id: nextId('cat'),
    parentId: null,
    name: 'Category',
    kind: 'expense',
    systemKey: null,
    color: null,
    sortOrder: 0,
    rolloverEnabled: false,
    rolloverStartMonth: null,
    isArchived: false,
    ...overrides,
  };
}

export function rule(overrides: Partial<CategorizationRule> = {}): CategorizationRule {
  return {
    id: nextId('rule'),
    isEnabled: true,
    priority: 100,
    nameOperator: null,
    nameValue: null,
    accountId: null,
    direction: null,
    amountMinCents: null,
    amountMaxCents: null,
    setCategoryId: null,
    setKind: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

export function transaction(overrides: Partial<Transaction> = {}): Transaction {
  const name = overrides.name ?? 'Merchant';
  return {
    id: nextId('tx'),
    accountId: 'acc-1',
    source: 'plaid',
    name,
    date: '2026-09-15',
    amountCents: -1000,
    isoCurrencyCode: 'USD',
    pending: false,
    merchantKey: name.toLowerCase(),
    originalName: name,
    originalMerchantName: null,
    originalDate: overrides.date ?? '2026-09-15',
    nameOverride: null,
    dateOverride: null,
    notes: null,
    categoryId: null,
    categorySource: 'none',
    kind: 'expense',
    kindSource: 'auto',
    transferPairId: null,
    recurringId: null,
    providerCategoryPrimary: null,
    providerCategoryDetailed: null,
    createdAt: '2026-09-15T00:00:00Z',
    updatedAt: '2026-09-15T00:00:00Z',
    ...overrides,
  };
}

export function total(
  month: string,
  categoryId: string | null,
  totalCents: number,
  kind: CategoryMonthTotal['kind'] = 'expense',
): CategoryMonthTotal {
  return { month, categoryId, kind, totalCents, lineCount: 1 };
}

export function account(overrides: Partial<Account> = {}): Account {
  return {
    id: nextId('acc'),
    connectionId: 'conn-1',
    name: 'Checking',
    displayName: null,
    officialName: null,
    mask: '1234',
    type: 'depository',
    subtype: 'checking',
    currentBalanceCents: 100_000,
    availableBalanceCents: 100_000,
    creditLimitCents: null,
    isoCurrencyCode: 'USD',
    balanceUpdatedAt: null,
    isHidden: false,
    isActive: true,
    ...overrides,
  };
}

export function series(overrides: Partial<RecurringSeries> = {}): RecurringSeries {
  return {
    id: nextId('rec'),
    name: 'Netflix',
    merchantKey: 'netflix',
    accountId: 'acc-1',
    categoryId: null,
    kind: 'expense',
    frequency: 'monthly',
    expectedAmountCents: 1599,
    amountMinCents: 1599,
    amountMaxCents: 1599,
    lastDate: '2026-09-05',
    nextDate: '2026-10-05',
    status: 'active',
    source: 'detected',
    notes: null,
    ...overrides,
  };
}
