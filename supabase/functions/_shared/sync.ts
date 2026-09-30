/**
 * Plaid transaction sync for one connection.
 *
 *   1. Take a lease (no concurrent syncs of the same Item).
 *   2. Refresh accounts + balances (/accounts/get).
 *   3. Page through /transactions/sync from the stored cursor, restarting if
 *      Plaid reports the data changed mid-pagination.
 *   4. Plan with @budget/core (categorize new rows, pending->posted rekeys,
 *      split rebalancing) and apply everything + the new cursor atomically.
 *   5. Link transfers and refresh recurring series.
 *
 * Replaying a sync is safe: every write is an idempotent upsert keyed by the
 * provider's stable transaction id.
 */
import {
  buildHistoryMap,
  categoryFromRow,
  createClassifier,
  fromPlaidAccount,
  fromPlaidTransaction,
  num,
  planTransactionSync,
  referencedProviderIds,
  ruleFromRow,
  type CategoryRow,
  type ExistingSyncedTransaction,
  type PlaidAccount,
  type PlaidTransaction,
  type RuleRow,
  type SyncPlan,
  type TransactionKind,
} from './core/index.ts';
import type { TokenCipher } from './crypto.ts';
import { chunk, unwrap, type ServiceClient } from './db.ts';
import { logError, logInfo } from './http.ts';
import { PlaidApiError, type PlaidClient } from './plaid.ts';
import { linkTransfers, refreshRecurring } from './postSync.ts';

export type SyncTrigger = 'initial' | 'manual' | 'webhook' | 'scheduled';

export interface SyncDeps {
  db: ServiceClient;
  plaid: PlaidClient;
  cipher: TokenCipher;
  /** Server "today" as YYYY-MM-DD. */
  today: () => string;
}

export interface SyncResult {
  connectionId: string;
  status: 'succeeded' | 'failed' | 'skipped';
  added: number;
  modified: number;
  removed: number;
  errorCode?: string;
}

/** Plaid Item error codes that change how the connection is presented to the user. */
export function connectionStatusForError(code: string): 'login_required' | 'pending_expiration' | 'error' | null {
  switch (code) {
    case 'ITEM_LOGIN_REQUIRED':
    case 'INVALID_CREDENTIALS':
    case 'INVALID_MFA':
    case 'USER_SETUP_REQUIRED':
      return 'login_required';
    case 'PENDING_EXPIRATION':
    case 'PENDING_DISCONNECT':
      return 'pending_expiration';
    case 'ITEM_NOT_FOUND':
    case 'ACCESS_NOT_GRANTED':
    case 'NO_ACCOUNTS':
    case 'INSTITUTION_DOWN':
    case 'INSTITUTION_NOT_RESPONDING':
    case 'INSTITUTION_NO_LONGER_SUPPORTED':
      return 'error';
    default:
      return null;
  }
}

export async function getAccessToken(deps: Pick<SyncDeps, 'db' | 'cipher'>, connectionId: string): Promise<string> {
  const row = unwrap(
    await deps.db
      .from('connection_secrets')
      .select('access_token_ciphertext')
      .eq('connection_id', connectionId)
      .single(),
    'load access token',
  ) as { access_token_ciphertext: string };
  return deps.cipher.decrypt(row.access_token_ciphertext, connectionId);
}

/** Upsert the Item's accounts (balances included); deactivate ones Plaid no longer returns. */
export async function upsertAccounts(
  db: ServiceClient,
  userId: string,
  connectionId: string,
  accounts: PlaidAccount[],
): Promise<Map<string, string>> {
  const now = new Date().toISOString();
  const rows = accounts.map(fromPlaidAccount).map((a) => ({
    user_id: userId,
    connection_id: connectionId,
    provider_account_id: a.providerAccountId,
    name: a.name,
    official_name: a.officialName,
    mask: a.mask,
    type: a.type,
    subtype: a.subtype,
    current_balance_cents: a.currentBalanceCents,
    available_balance_cents: a.availableBalanceCents,
    credit_limit_cents: a.creditLimitCents,
    iso_currency_code: a.isoCurrencyCode,
    balance_updated_at: now,
    is_active: true,
  }));
  if (rows.length) {
    unwrap(
      await db.from('accounts').upsert(rows, { onConflict: 'connection_id,provider_account_id' }),
      'upsert accounts',
    );
  }

  const stored = unwrap(
    await db.from('accounts').select('id, provider_account_id').eq('connection_id', connectionId),
    'load accounts',
  ) as { id: string; provider_account_id: string }[];
  const current = new Set(rows.map((r) => r.provider_account_id));
  const missing = stored.filter((a) => !current.has(a.provider_account_id)).map((a) => a.id);
  if (missing.length) {
    unwrap(await db.from('accounts').update({ is_active: false }).in('id', missing), 'deactivate accounts');
  }
  return new Map(stored.map((a) => [a.provider_account_id, a.id]));
}

interface Changes {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removedIds: string[];
  nextCursor: string;
}

export async function fetchAllChanges(
  plaid: PlaidClient,
  accessToken: string,
  cursor: string | null,
): Promise<Changes> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const added: PlaidTransaction[] = [];
      const modified: PlaidTransaction[] = [];
      const removedIds: string[] = [];
      let next = cursor;
      for (let page = 0; page < 200; page++) {
        const res = await plaid.transactionsSync(accessToken, next);
        added.push(...res.added);
        modified.push(...res.modified);
        removedIds.push(...res.removed.map((r) => r.transaction_id));
        next = res.next_cursor;
        if (!res.has_more) break;
      }
      return { added, modified, removedIds, nextCursor: next ?? '' };
    } catch (err) {
      // Plaid: restart pagination from the original cursor.
      if (err instanceof PlaidApiError && err.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') continue;
      throw err;
    }
  }
  throw new PlaidApiError(409, 'TRANSACTIONS_ERROR', 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', null, null);
}

async function loadExisting(
  db: ServiceClient,
  userId: string,
  providerIds: string[],
): Promise<ExistingSyncedTransaction[]> {
  const out: ExistingSyncedTransaction[] = [];
  for (const ids of chunk(providerIds, 150)) {
    const rows = unwrap(
      await db
        .from('transactions')
        .select('id, provider_transaction_id, amount_cents, transaction_splits(id, amount_cents)')
        .eq('user_id', userId)
        .in('provider_transaction_id', ids),
      'load existing transactions',
    ) as {
      id: string;
      provider_transaction_id: string;
      amount_cents: number | string;
      transaction_splits: { id: string; amount_cents: number | string }[];
    }[];
    for (const r of rows) {
      out.push({
        id: r.id,
        providerTransactionId: r.provider_transaction_id,
        amountCents: num(r.amount_cents),
        splits: r.transaction_splits.map((s) => ({ id: s.id, amountCents: num(s.amount_cents) })),
      });
    }
  }
  return out;
}

export async function loadClassifier(db: ServiceClient, userId: string) {
  const [cats, rules, history] = await Promise.all([
    db
      .from('categories')
      .select(
        'id, parent_id, name, kind, system_key, color, sort_order, rollover_enabled, rollover_start_month, is_archived',
      )
      .eq('user_id', userId),
    db.from('categorization_rules').select('*').eq('user_id', userId).eq('is_enabled', true),
    db.rpc('merchant_history', { p_user_id: userId }),
  ]);
  return createClassifier({
    categories: (unwrap(cats, 'load categories') as CategoryRow[]).map(categoryFromRow),
    rules: (unwrap(rules, 'load rules') as RuleRow[]).map(ruleFromRow),
    history: buildHistoryMap(
      (
        unwrap(history, 'load merchant history') as {
          merchant_key: string;
          category_id: string | null;
          kind: string | null;
        }[]
      ).map((h) => ({
        merchantKey: h.merchant_key,
        categoryId: h.category_id,
        kind: h.kind as TransactionKind | null,
      })),
    ),
  });
}

function toRpcPayload(plan: SyncPlan) {
  return {
    p_rekeys: plan.rekeys.map((r) => ({ from_id: r.fromId, to_id: r.toId })),
    p_upserts: plan.upserts.map((u) => ({
      account_id: u.accountId,
      provider_transaction_id: u.providerTransactionId,
      provider_pending_transaction_id: u.providerPendingTransactionId,
      provider_category_primary: u.providerCategoryPrimary,
      provider_category_detailed: u.providerCategoryDetailed,
      provider_payment_channel: u.providerPaymentChannel,
      provider_raw: u.providerRaw,
      original_name: u.originalName,
      original_merchant_name: u.originalMerchantName,
      original_date: u.originalDate,
      authorized_date: u.authorizedDate,
      amount_cents: u.amountCents,
      iso_currency_code: u.isoCurrencyCode,
      pending: u.pending,
      merchant_key: u.merchantKey,
      category_id: u.classification.categoryId,
      category_source: u.classification.categorySource,
      kind: u.classification.kind,
      kind_source: u.classification.kindSource,
    })),
    p_split_updates: plan.splitUpdates.map((s) => ({ split_id: s.splitId, amount_cents: s.amountCents })),
    p_split_clears: plan.splitClears,
    p_removed: plan.removed,
  };
}

/** Post-sync detection. Failures here never fail the sync itself. */
export async function runPostSync(deps: SyncDeps, userId: string, since: string): Promise<void> {
  try {
    const linked = await linkTransfers(deps.db, userId, since);
    const recurring = await refreshRecurring(deps.db, userId, deps.today());
    logInfo('post_sync', { userId, transfersLinked: linked, ...recurring });
  } catch (err) {
    logError('post_sync_failed', { userId, message: err instanceof Error ? err.message : String(err) });
  }
}

export async function syncConnection(deps: SyncDeps, connectionId: string, trigger: SyncTrigger): Promise<SyncResult> {
  const { db } = deps;
  const empty = { connectionId, added: 0, modified: 0, removed: 0 };

  const leased = unwrap(
    await db.rpc('acquire_sync_lease', { p_connection_id: connectionId, p_seconds: 300 }),
    'acquire sync lease',
  );
  if (!leased) return { ...empty, status: 'skipped' };

  const conn = unwrap(
    await db.from('connections').select('id, user_id, transactions_cursor').eq('id', connectionId).single(),
    'load connection',
  ) as { id: string; user_id: string; transactions_cursor: string | null };
  const userId = conn.user_id;

  const run = unwrap(
    await db.from('sync_runs').insert({ user_id: userId, connection_id: connectionId, trigger }).select('id').single(),
    'start sync run',
  ) as { id: string };

  try {
    const accessToken = await getAccessToken(deps, connectionId);

    const { accounts, item } = await deps.plaid.accountsGet(accessToken);
    const accountIds = await upsertAccounts(db, userId, connectionId, accounts);

    const changes = await fetchAllChanges(deps.plaid, accessToken, conn.transactions_cursor);
    const added = changes.added.map(fromPlaidTransaction);
    const modified = changes.modified.map(fromPlaidTransaction);

    const [existing, classifier] = await Promise.all([
      loadExisting(db, userId, referencedProviderIds(added, modified)),
      loadClassifier(db, userId),
    ]);

    const plan = planTransactionSync({
      added,
      modified,
      removedIds: changes.removedIds,
      existing,
      accountIds,
      classifier,
    });
    if (plan.skipped.length) logInfo('sync_skipped_transactions', { connectionId, count: plan.skipped.length });

    const counts = unwrap(
      await db.rpc('apply_transaction_sync', {
        p_user_id: userId,
        p_connection_id: connectionId,
        ...toRpcPayload(plan),
        p_cursor: changes.nextCursor,
      }),
      'apply transaction sync',
    ) as { inserted: number; updated: number; removed: number; rekeyed: number };

    if (plan.upserts.length || plan.removed.length) {
      const earliest = plan.upserts.reduce<string>(
        (min, u) => (u.originalDate < min ? u.originalDate : min),
        deps.today(),
      );
      await runPostSync(deps, userId, earliest);
    }

    unwrap(
      await db
        .from('connections')
        .update({
          status: 'active',
          status_detail: null,
          sync_lease_until: null,
          consent_expires_at: item.consent_expiration_time ?? null,
        })
        .eq('id', connectionId),
      'finish connection',
    );
    const result: SyncResult = {
      connectionId,
      status: 'succeeded',
      added: counts.inserted,
      modified: counts.updated + counts.rekeyed,
      removed: counts.removed,
    };
    await db
      .from('sync_runs')
      .update({
        status: 'succeeded',
        added_count: result.added,
        modified_count: result.modified,
        removed_count: result.removed,
        finished_at: new Date().toISOString(),
      })
      .eq('id', run.id);
    logInfo('sync_succeeded', {
      connectionId,
      trigger,
      added: result.added,
      modified: result.modified,
      removed: result.removed,
    });
    return result;
  } catch (err) {
    const code = err instanceof PlaidApiError ? err.code : 'internal_error';
    const status = err instanceof PlaidApiError ? connectionStatusForError(err.code) : null;
    logError('sync_failed', {
      connectionId,
      trigger,
      code,
      requestId: err instanceof PlaidApiError ? err.requestId : undefined,
      message: err instanceof PlaidApiError ? undefined : err instanceof Error ? err.message : String(err),
    });
    await db
      .from('connections')
      .update({ sync_lease_until: null, ...(status ? { status, status_detail: code } : {}) })
      .eq('id', connectionId);
    await db
      .from('sync_runs')
      .update({ status: 'failed', error_code: code, finished_at: new Date().toISOString() })
      .eq('id', run.id);
    return { ...empty, status: 'failed', errorCode: code };
  }
}
