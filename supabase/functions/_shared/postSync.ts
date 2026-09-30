/**
 * Work that runs after new data lands: transfer linking and recurring
 * detection. Both use the shared core algorithms; this file only moves data.
 */
import {
  addDays,
  detectRecurring,
  findTransferPairs,
  num,
  planRecurringUpdates,
  type AccountType,
  type ISODate,
  type KindSource,
  type TransactionKind,
} from './core/index.ts';
import { chunk, selectAll, unwrap, type ServiceClient } from './db.ts';

interface CandidateRow {
  id: string;
  account_id: string | null;
  date: string;
  amount_cents: number | string;
  name: string;
  kind: string;
  kind_source: string;
  transfer_pair_id: string | null;
  provider_category_primary: string | null;
  provider_category_detailed: string | null;
  accounts: { type: string } | null;
}

/** Link transfer pairs among transactions dated on/after `since`. Returns pairs linked. */
export async function linkTransfers(db: ServiceClient, userId: string, since: ISODate): Promise<number> {
  const rows = await selectAll<CandidateRow>(
    (from, to) =>
      db
        .from('transactions')
        .select(
          'id, account_id, date, amount_cents, name, kind, kind_source, transfer_pair_id, provider_category_primary, provider_category_detailed, accounts(type)',
        )
        .eq('user_id', userId)
        .gte('date', addDays(since, -7))
        .is('transfer_pair_id', null)
        .order('id')
        .range(from, to) as unknown as PromiseLike<{ data: CandidateRow[] | null; error: null }>,
    'load transfer candidates',
  );

  const pairs = findTransferPairs(
    rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      accountType: (r.accounts?.type ?? null) as AccountType | null,
      date: r.date,
      amountCents: num(r.amount_cents),
      name: r.name,
      kind: r.kind as TransactionKind,
      kindSource: r.kind_source as KindSource,
      transferPairId: r.transfer_pair_id,
      providerCategoryPrimary: r.provider_category_primary,
      providerCategoryDetailed: r.provider_category_detailed,
    })),
  );
  if (pairs.length === 0) return 0;

  const linked = unwrap(
    await db.rpc('apply_transfer_pairs', {
      p_user_id: userId,
      p_pairs: pairs.map((p) => ({ outflow_id: p.outflowId, inflow_id: p.inflowId })),
    }),
    'apply transfer pairs',
  );
  return Number(linked ?? 0);
}

interface RecurringTxnRow {
  id: string;
  date: string;
  amount_cents: number | string;
  merchant_key: string;
  name: string;
  account_id: string | null;
  category_id: string | null;
  kind: string;
  pending: boolean;
}

/** Detect recurring series over the last ~13 months and reconcile with stored ones. */
export async function refreshRecurring(
  db: ServiceClient,
  userId: string,
  today: ISODate,
): Promise<{ inserted: number; updated: number }> {
  const rows = await selectAll<RecurringTxnRow>(
    (from, to) =>
      db
        .from('transactions')
        .select('id, date, amount_cents, merchant_key, name, account_id, category_id, kind, pending')
        .eq('user_id', userId)
        .gte('date', addDays(today, -400))
        .neq('kind', 'transfer')
        .eq('pending', false)
        .order('id')
        .range(from, to) as unknown as PromiseLike<{ data: RecurringTxnRow[] | null; error: null }>,
    'load recurring candidates',
  );

  const detected = detectRecurring(
    rows.map((r) => ({
      id: r.id,
      date: r.date,
      amountCents: num(r.amount_cents),
      merchantKey: r.merchant_key,
      name: r.name,
      accountId: r.account_id,
      categoryId: r.category_id,
      kind: r.kind as TransactionKind,
      pending: r.pending,
    })),
    today,
  );

  const existing = unwrap(
    await db.from('recurring_series').select('id, merchant_key, status, source, last_date').eq('user_id', userId),
    'load recurring series',
  ) as {
    id: string;
    merchant_key: string | null;
    status: 'active' | 'ignored';
    source: 'detected' | 'manual';
    last_date: string | null;
  }[];

  const plan = planRecurringUpdates(
    detected,
    existing.map((s) => ({
      id: s.id,
      merchantKey: s.merchant_key,
      status: s.status,
      source: s.source,
      lastDate: s.last_date,
    })),
  );

  const idByKey = new Map(existing.filter((s) => s.merchant_key).map((s) => [s.merchant_key!, s.id]));

  if (plan.inserts.length) {
    const inserted = unwrap(
      await db
        .from('recurring_series')
        .upsert(
          plan.inserts.map((d) => ({
            user_id: userId,
            name: d.name,
            merchant_key: d.merchantKey,
            account_id: d.accountId,
            category_id: d.categoryId,
            kind: d.kind,
            frequency: d.frequency,
            expected_amount_cents: d.expectedAmountCents,
            amount_min_cents: d.amountMinCents,
            amount_max_cents: d.amountMaxCents,
            last_date: d.lastDate,
            next_date: d.nextDate,
            status: 'active',
            source: 'detected',
          })),
          { onConflict: 'user_id,merchant_key', ignoreDuplicates: true },
        )
        .select('id, merchant_key'),
      'insert recurring series',
    ) as { id: string; merchant_key: string }[];
    for (const s of inserted) idByKey.set(s.merchant_key, s.id);
  }

  for (const u of plan.updates) {
    const d = u.detected;
    const patch = u.scheduleOnly
      ? { last_date: d.lastDate, next_date: d.nextDate }
      : {
          frequency: d.frequency,
          expected_amount_cents: d.expectedAmountCents,
          amount_min_cents: d.amountMinCents,
          amount_max_cents: d.amountMaxCents,
          last_date: d.lastDate,
          next_date: d.nextDate,
          account_id: d.accountId,
        };
    unwrap(
      await db.from('recurring_series').update(patch).eq('id', u.id).eq('user_id', userId),
      'update recurring series',
    );
  }

  // Link member transactions to their series.
  const byKey = new Map<string, string[]>();
  for (const l of plan.links) {
    const list = byKey.get(l.merchantKey) ?? [];
    list.push(l.transactionId);
    byKey.set(l.merchantKey, list);
  }
  for (const [key, ids] of byKey) {
    const seriesId = idByKey.get(key);
    if (!seriesId) continue;
    for (const part of chunk(ids, 200)) {
      unwrap(
        await db.from('transactions').update({ recurring_id: seriesId }).eq('user_id', userId).in('id', part),
        'link recurring transactions',
      );
    }
  }

  return { inserted: plan.inserts.length, updated: plan.updates.length };
}
