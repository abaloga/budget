/**
 * Transfer detection: find pairs of transactions that move the same amount
 * between two of the user's connected accounts (e.g. a checking-account
 * payment and the matching credit-card "payment received").
 *
 * Transfers count as neither income nor spending and never touch budgets.
 * A $100 card payment is therefore not a second $100 expense — the purchases
 * on the card were already counted when they happened.
 */
import { daysBetween } from './dates.ts';
import { providerSaysTransfer } from './providerCategories.ts';
import type { AccountType, Cents, ISODate, KindSource, TransactionKind } from './types.ts';

export interface TransferCandidate {
  id: string;
  accountId: string | null;
  accountType?: AccountType | null;
  date: ISODate;
  amountCents: Cents;
  name: string;
  kind: TransactionKind;
  kindSource: KindSource;
  transferPairId: string | null;
  providerCategoryPrimary: string | null;
  providerCategoryDetailed: string | null;
}

export interface TransferPair {
  outflowId: string;
  inflowId: string;
}

export interface TransferDetectionOptions {
  /** Max days between the two sides (ACH can take a few business days). */
  maxDaysApart?: number;
}

const TRANSFER_WORDS =
  /\b(transfer|xfer|payment|autopay|auto pay|pymt|pmt|epay|thank you|online banking|to (checking|savings|chk|sav)|from (checking|savings|chk|sav)|credit card|card services|crd)\b/i;

/** Is there any signal (beyond matching amounts) that this moved money between accounts? */
export function hasTransferSignal(c: TransferCandidate): boolean {
  if (providerSaysTransfer(c.providerCategoryPrimary, c.providerCategoryDetailed)) return true;
  if (c.providerCategoryDetailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') return true;
  if (TRANSFER_WORDS.test(c.name)) return true;
  // Money arriving on a credit card is almost always a payment.
  if (c.accountType === 'credit' && c.amountCents > 0) return true;
  return false;
}

function eligible(c: TransferCandidate): boolean {
  return (
    c.accountId !== null &&
    c.transferPairId === null &&
    c.amountCents !== 0 &&
    // Respect explicit user decisions ("this is not a transfer").
    !(c.kindSource === 'user' && c.kind !== 'transfer')
  );
}

/**
 * Pair outflows with inflows of the exact opposite amount in a different
 * account within `maxDaysApart`. At least one side must carry a transfer
 * signal so two unrelated $12.99 charges/refunds are never linked. Matching is
 * greedy by closeness in time and deterministic for identical inputs.
 */
export function findTransferPairs(
  candidates: readonly TransferCandidate[],
  options: TransferDetectionOptions = {},
): TransferPair[] {
  const maxDays = options.maxDaysApart ?? 5;
  const pool = candidates.filter(eligible);
  const outflows = pool.filter((c) => c.amountCents < 0);
  const inflowsByAmount = new Map<number, TransferCandidate[]>();
  for (const c of pool) {
    if (c.amountCents <= 0) continue;
    const list = inflowsByAmount.get(c.amountCents) ?? [];
    list.push(c);
    inflowsByAmount.set(c.amountCents, list);
  }

  type Option = { out: TransferCandidate; inn: TransferCandidate; score: number };
  const matches: Option[] = [];
  for (const out of outflows) {
    for (const inn of inflowsByAmount.get(-out.amountCents) ?? []) {
      if (inn.accountId === out.accountId) continue;
      const gap = Math.abs(daysBetween(out.date, inn.date));
      if (gap > maxDays) continue;
      const outSignal = hasTransferSignal(out);
      const inSignal = hasTransferSignal(inn);
      if (!outSignal && !inSignal) continue;
      // Lower is better: time gap first, then prefer both sides signalling.
      const score = gap * 10 + (outSignal && inSignal ? 0 : 5);
      matches.push({ out, inn, score });
    }
  }

  matches.sort((a, b) => a.score - b.score || a.out.id.localeCompare(b.out.id) || a.inn.id.localeCompare(b.inn.id));

  const used = new Set<string>();
  const pairs: TransferPair[] = [];
  for (const o of matches) {
    if (used.has(o.out.id) || used.has(o.inn.id)) continue;
    used.add(o.out.id);
    used.add(o.inn.id);
    pairs.push({ outflowId: o.out.id, inflowId: o.inn.id });
  }
  return pairs;
}

/** Is this transaction excluded from income/spending because it's a transfer? */
export function isTransfer(tx: { kind: TransactionKind }): boolean {
  return tx.kind === 'transfer';
}
