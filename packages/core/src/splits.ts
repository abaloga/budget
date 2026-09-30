/**
 * Split transactions: one purchase divided across categories. Invariant: the
 * parts always sum exactly to the parent amount (also enforced by a deferred
 * constraint trigger in the database).
 *
 * Reports and budgets consume *lines* (see toLines), never raw transactions, so
 * a split parent is never counted alongside its parts.
 */
import { sumCents } from './money.ts';
import type { Cents, Split, Transaction, TransactionLine } from './types.ts';

export interface SplitValidation {
  ok: boolean;
  errors: string[];
  /** Amount still to allocate (parent − sum of parts). */
  remainingCents: Cents;
}

export function validateSplits(totalCents: Cents, splits: readonly Split[]): SplitValidation {
  const errors: string[] = [];
  const allocated = sumCents(splits.map((s) => s.amountCents));
  const remainingCents = totalCents - allocated;

  if (splits.length < 2) errors.push('A split needs at least two parts.');
  splits.forEach((s, i) => {
    if (!s.categoryId) errors.push(`Part ${i + 1} needs a category.`);
    if (!Number.isInteger(s.amountCents)) errors.push(`Part ${i + 1} has an invalid amount.`);
    else if (s.amountCents === 0) errors.push(`Part ${i + 1} can't be zero.`);
    else if (Math.sign(s.amountCents) !== Math.sign(totalCents))
      errors.push(`Part ${i + 1} must go in the same direction as the transaction.`);
  });
  if (remainingCents !== 0) errors.push('Parts must add up to the transaction total.');

  return { ok: errors.length === 0, errors, remainingCents };
}

type LineSource = Pick<
  Transaction,
  'id' | 'date' | 'accountId' | 'categoryId' | 'kind' | 'amountCents' | 'merchantKey' | 'name' | 'pending'
>;

/** Expand a transaction into reporting lines (mirrors the `transaction_lines` view). */
export function toLines(tx: LineSource, splits: readonly Split[] = []): TransactionLine[] {
  const base = {
    transactionId: tx.id,
    date: tx.date,
    accountId: tx.accountId,
    kind: tx.kind,
    merchantKey: tx.merchantKey,
    name: tx.name,
    pending: tx.pending,
  };
  if (splits.length === 0) {
    return [{ ...base, splitId: null, categoryId: tx.categoryId, amountCents: tx.amountCents }];
  }
  return splits.map((s, i) => ({
    ...base,
    splitId: s.id ?? `${tx.id}:${i}`,
    categoryId: s.categoryId,
    amountCents: s.amountCents,
  }));
}

export type SplitRebalance =
  { type: 'unchanged' } | { type: 'update'; updates: { splitId: string; amountCents: Cents }[] } | { type: 'clear' };

/**
 * The provider changed a split transaction's amount (e.g. a tip posted).
 * Absorb the difference into the largest part; if that isn't possible without
 * zeroing or flipping a part, drop the split so the user can redo it.
 */
export function rebalanceSplits(
  splits: readonly { id: string; amountCents: Cents }[],
  newTotalCents: Cents,
): SplitRebalance {
  if (splits.length < 2) return { type: 'unchanged' };
  const current = sumCents(splits.map((s) => s.amountCents));
  const delta = newTotalCents - current;
  if (delta === 0) return { type: 'unchanged' };
  if (newTotalCents === 0 || Math.sign(newTotalCents) !== Math.sign(current)) return { type: 'clear' };

  const largest = [...splits].sort(
    (a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents) || a.id.localeCompare(b.id),
  )[0]!;
  const adjusted = largest.amountCents + delta;
  if (adjusted === 0 || Math.sign(adjusted) !== Math.sign(newTotalCents)) return { type: 'clear' };

  return { type: 'update', updates: [{ splitId: largest.id, amountCents: adjusted }] };
}
