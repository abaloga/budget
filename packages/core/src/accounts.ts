/**
 * Account balance presentation logic.
 *
 * Providers report credit/loan balances as the positive amount owed. The app
 * shows them as liabilities (owed), never mixed into cash totals. There is
 * intentionally no net-worth calculation (out of scope).
 */
import type { Account, AccountType, Cents, Connection } from './types.ts';

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  depository: 'Cash',
  credit: 'Credit card',
  loan: 'Loan',
  investment: 'Investment',
  other: 'Other',
};

export function isLiability(type: AccountType): boolean {
  return type === 'credit' || type === 'loan';
}

export function accountDisplayName(a: Pick<Account, 'displayName' | 'name' | 'mask'>): string {
  const base = a.displayName?.trim() || a.name;
  return a.mask ? `${base} ··${a.mask}` : base;
}

export function accountSubtypeLabel(a: Pick<Account, 'type' | 'subtype'>): string {
  if (a.subtype) return a.subtype.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return ACCOUNT_TYPE_LABELS[a.type];
}

/** Credit utilization (owed / limit), when a limit is known. */
export function creditUtilization(
  a: Pick<Account, 'type' | 'currentBalanceCents' | 'creditLimitCents'>,
): number | null {
  if (a.type !== 'credit' || !a.creditLimitCents || a.currentBalanceCents == null) return null;
  return a.currentBalanceCents / a.creditLimitCents;
}

export interface InstitutionGroup {
  connection: Connection;
  accounts: Account[];
}

export function groupAccountsByInstitution(
  connections: readonly Connection[],
  accounts: readonly Account[],
  options: { includeHidden?: boolean } = {},
): InstitutionGroup[] {
  const order: Record<AccountType, number> = { depository: 0, credit: 1, loan: 2, investment: 3, other: 4 };
  return connections
    .map((connection) => ({
      connection,
      accounts: accounts
        .filter((a) => a.connectionId === connection.id && (options.includeHidden || !a.isHidden))
        .sort((a, b) => order[a.type] - order[b.type] || accountDisplayName(a).localeCompare(accountDisplayName(b))),
    }))
    .sort((a, b) => a.connection.institutionName.localeCompare(b.connection.institutionName));
}

export interface BalanceTotals {
  /** Sum of checking/savings current balances. */
  cashCents: Cents;
  /** Sum of amounts owed on credit cards. */
  creditOwedCents: Cents;
}

export function balanceTotals(accounts: readonly Account[]): BalanceTotals {
  let cashCents = 0;
  let creditOwedCents = 0;
  for (const a of accounts) {
    if (a.isHidden || !a.isActive || a.currentBalanceCents == null) continue;
    if (a.type === 'depository') cashCents += a.currentBalanceCents;
    else if (a.type === 'credit') creditOwedCents += a.currentBalanceCents;
  }
  return { cashCents, creditOwedCents };
}
