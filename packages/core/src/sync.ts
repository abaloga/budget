/**
 * Transaction sync planning (pure).
 *
 * Given one fully-paginated provider delta and what the database already
 * holds, decide exactly what to write. The edge function executes the plan via
 * the `apply_transaction_sync` RPC in a single database transaction.
 *
 * Guarantees
 *   * Idempotent: stable provider ids + upsert, so replays converge.
 *   * No duplicates: added+modified are de-duplicated by provider id.
 *   * Pending -> posted keeps the user's edits: the posted id is moved onto
 *     the existing pending row ("rekey") instead of delete + insert.
 *   * User edits are never in the plan for existing rows (the RPC only
 *     updates provider-owned columns on conflict).
 *   * Split transactions stay balanced when the provider changes an amount.
 */
import type { CategorizableTransaction, Classification, Classifier } from './categorize.ts';
import { normalizeMerchant } from './merchant.ts';
import type { ProviderTransaction } from './plaid.ts';
import { rebalanceSplits } from './splits.ts';
import type { Cents } from './types.ts';

/** What the database currently has for a provider transaction id. */
export interface ExistingSyncedTransaction {
  id: string;
  providerTransactionId: string;
  amountCents: Cents;
  splits: { id: string; amountCents: Cents }[];
}

export interface SyncPlanInput {
  added: readonly ProviderTransaction[];
  modified: readonly ProviderTransaction[];
  removedIds: readonly string[];
  /** Rows matching any provider id or pending id referenced by the delta. */
  existing: readonly ExistingSyncedTransaction[];
  /** provider account id -> accounts.id */
  accountIds: ReadonlyMap<string, string>;
  classifier: Classifier;
}

export interface SyncUpsert {
  accountId: string;
  providerTransactionId: string;
  providerPendingTransactionId: string | null;
  providerCategoryPrimary: string | null;
  providerCategoryDetailed: string | null;
  providerPaymentChannel: string | null;
  providerRaw: unknown;
  originalName: string;
  originalMerchantName: string | null;
  originalDate: string;
  authorizedDate: string | null;
  amountCents: Cents;
  isoCurrencyCode: string;
  pending: boolean;
  merchantKey: string;
  /** Only applied when the row is inserted. */
  classification: Classification;
  isNew: boolean;
}

export interface SyncPlan {
  rekeys: { fromId: string; toId: string }[];
  upserts: SyncUpsert[];
  splitUpdates: { splitId: string; amountCents: Cents }[];
  /** Transaction ids (uuid) whose splits must be dropped. */
  splitClears: string[];
  removed: string[];
  skipped: { providerTransactionId: string; reason: 'unknown_account' }[];
}

/** Merchant identity for a provider transaction (prefers the clean merchant name). */
export function merchantKeyFor(tx: Pick<ProviderTransaction, 'merchantName' | 'name'>): string {
  return normalizeMerchant(tx.merchantName ?? tx.name);
}

export function planTransactionSync(input: SyncPlanInput): SyncPlan {
  const plan: SyncPlan = { rekeys: [], upserts: [], splitUpdates: [], splitClears: [], removed: [], skipped: [] };

  // Later entries win: `modified` supersedes `added` for the same id.
  const incoming = new Map<string, ProviderTransaction>();
  for (const tx of [...input.added, ...input.modified]) incoming.set(tx.providerTransactionId, tx);

  const existing = new Map(input.existing.map((e) => [e.providerTransactionId, e]));
  const consumedPendingIds = new Set<string>();

  for (const tx of incoming.values()) {
    const accountId = input.accountIds.get(tx.providerAccountId);
    if (!accountId) {
      plan.skipped.push({ providerTransactionId: tx.providerTransactionId, reason: 'unknown_account' });
      continue;
    }

    let current = existing.get(tx.providerTransactionId);
    if (
      !current &&
      tx.pendingTransactionId &&
      !consumedPendingIds.has(tx.pendingTransactionId) &&
      !incoming.has(tx.pendingTransactionId)
    ) {
      const pendingRow = existing.get(tx.pendingTransactionId);
      if (pendingRow) {
        plan.rekeys.push({ fromId: tx.pendingTransactionId, toId: tx.providerTransactionId });
        consumedPendingIds.add(tx.pendingTransactionId);
        current = pendingRow;
      }
    }

    const merchantKey = merchantKeyFor(tx);
    const isNew = !current;
    const subject: CategorizableTransaction = {
      name: tx.merchantName ?? tx.name,
      originalName: tx.name,
      originalMerchantName: tx.merchantName,
      merchantKey,
      accountId,
      amountCents: tx.amountCents,
      providerCategoryPrimary: tx.categoryPrimary,
      providerCategoryDetailed: tx.categoryDetailed,
    };
    const classification: Classification = isNew
      ? input.classifier.classify(subject)
      : { categoryId: null, categorySource: 'none', kind: 'expense', kindSource: 'auto' };

    plan.upserts.push({
      accountId,
      providerTransactionId: tx.providerTransactionId,
      providerPendingTransactionId: tx.pendingTransactionId,
      providerCategoryPrimary: tx.categoryPrimary,
      providerCategoryDetailed: tx.categoryDetailed,
      providerPaymentChannel: tx.paymentChannel,
      providerRaw: tx.raw,
      originalName: tx.name,
      originalMerchantName: tx.merchantName,
      originalDate: tx.date,
      authorizedDate: tx.authorizedDate,
      amountCents: tx.amountCents,
      isoCurrencyCode: tx.isoCurrencyCode,
      pending: tx.pending,
      merchantKey,
      classification,
      isNew,
    });

    if (current && current.amountCents !== tx.amountCents && current.splits.length > 0) {
      const r = rebalanceSplits(current.splits, tx.amountCents);
      if (r.type === 'update') plan.splitUpdates.push(...r.updates);
      else if (r.type === 'clear') plan.splitClears.push(current.id);
    }
  }

  plan.removed = [...new Set(input.removedIds)].filter((id) => !consumedPendingIds.has(id) && !incoming.has(id));
  return plan;
}

/** Every provider id the planner needs to look up in the database. */
export function referencedProviderIds(
  added: readonly ProviderTransaction[],
  modified: readonly ProviderTransaction[],
): string[] {
  const ids = new Set<string>();
  for (const tx of [...added, ...modified]) {
    ids.add(tx.providerTransactionId);
    if (tx.pendingTransactionId) ids.add(tx.pendingTransactionId);
  }
  return [...ids];
}
