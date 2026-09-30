import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from './harness.ts';

const USER = '33333333-3333-3333-3333-333333333333';
let t: TestDb;
let checking: string;
let card: string;
let dining: string;
let groceries: string;

async function insertManual(fields: Record<string, unknown>) {
  const cols = Object.keys(fields);
  const [row] = await t.as<{ id: string }>(
    'authenticated',
    USER,
    `insert into public.transactions (user_id, source, ${cols.join(', ')})
     values ($1, 'manual', ${cols.map((_, i) => `$${i + 2}`).join(', ')}) returning id`,
    [USER, ...Object.values(fields)],
  );
  return row!.id;
}

async function search(filters: Record<string, unknown>, sort = 'date', desc = true) {
  const rows = await t.as<{ original_name: string }>(
    'authenticated',
    USER,
    'select original_name from public.search_transactions($1, $2, $3)',
    [JSON.stringify(filters), sort, desc],
  );
  return rows.map((r) => r.original_name);
}

beforeAll(async () => {
  t = await createTestDb();
  await t.createUser(USER);
  const [conn] = await t.as<{ id: string }>(
    'service_role',
    null,
    `insert into public.connections (user_id, provider_item_id) values ($1, 'item-x') returning id`,
    [USER],
  );
  const accts = await t.as<{ id: string; type: string }>(
    'service_role',
    null,
    `insert into public.accounts (user_id, connection_id, provider_account_id, name, type)
     values ($1, $2, 'a1', 'Checking', 'depository'), ($1, $2, 'a2', 'Card', 'credit') returning id, type`,
    [USER, conn!.id],
  );
  checking = accts.find((a) => a.type === 'depository')!.id;
  card = accts.find((a) => a.type === 'credit')!.id;
  const cats = await t.as<{ id: string; system_key: string }>(
    'authenticated',
    USER,
    `select id, system_key from public.categories where system_key in ('dining', 'groceries')`,
  );
  dining = cats.find((c) => c.system_key === 'dining')!.id;
  groceries = cats.find((c) => c.system_key === 'groceries')!.id;

  await insertManual({
    account_id: checking,
    original_name: 'Whole Foods',
    original_date: '2026-09-10',
    amount_cents: -8250,
    merchant_key: 'whole foods',
    category_id: groceries,
  });
  await insertManual({
    account_id: card,
    original_name: 'Chipotle',
    original_date: '2026-09-12',
    amount_cents: -1250,
    merchant_key: 'chipotle',
    category_id: dining,
    notes: 'burrito 100%',
  });
  await insertManual({
    account_id: checking,
    original_name: 'Payroll',
    original_date: '2026-09-15',
    amount_cents: 250000,
    merchant_key: 'payroll',
    kind: 'income',
  });
  await insertManual({
    account_id: checking,
    original_name: 'Mystery',
    original_date: '2026-08-01',
    amount_cents: -999,
    merchant_key: 'mystery',
  });
  const target = await insertManual({
    account_id: card,
    original_name: 'Target',
    original_date: '2026-09-20',
    amount_cents: -15000,
    merchant_key: 'target',
  });
  await t.as('authenticated', USER, 'select public.set_transaction_splits($1, $2)', [
    target,
    JSON.stringify([
      { category_id: groceries, amount_cents: -8000 },
      { category_id: dining, amount_cents: -7000 },
    ]),
  ]);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('search_transactions', () => {
  it('returns newest first by default', async () => {
    expect(await search({})).toEqual(['Target', 'Payroll', 'Chipotle', 'Whole Foods', 'Mystery']);
  });

  it('searches names and notes, treating wildcards literally', async () => {
    expect(await search({ search: 'whole' })).toEqual(['Whole Foods']);
    expect(await search({ search: 'burrito' })).toEqual(['Chipotle']);
    expect(await search({ search: '100%' })).toEqual(['Chipotle']);
    expect(await search({ search: '%' })).toEqual(['Chipotle']);
  });

  it('matches categories through splits', async () => {
    expect(await search({ category_ids: [dining] })).toEqual(['Target', 'Chipotle']);
  });

  it('finds uncategorized non-transfer transactions without splits', async () => {
    expect(await search({ uncategorized: true, kinds: ['expense'] })).toEqual(['Mystery']);
  });

  it('combines account, date, amount and kind filters', async () => {
    expect(await search({ account_ids: [checking], start_date: '2026-09-01', end_date: '2026-09-30' })).toEqual([
      'Payroll',
      'Whole Foods',
    ]);
    expect(await search({ min_amount_cents: 1000, max_amount_cents: 10000 })).toEqual(['Chipotle', 'Whole Foods']);
    expect(await search({ kinds: ['income'] })).toEqual(['Payroll']);
  });

  it('sorts by amount magnitude and name', async () => {
    expect(await search({}, 'amount', true)).toEqual(['Payroll', 'Target', 'Whole Foods', 'Chipotle', 'Mystery']);
    expect(await search({}, 'name', false)).toEqual(['Chipotle', 'Mystery', 'Payroll', 'Target', 'Whole Foods']);
  });
});

describe('apply_transfer_pairs', () => {
  it('links eligible pairs symmetrically and skips user-decided rows', async () => {
    const out = await insertManual({
      account_id: checking,
      original_name: 'Card payment',
      original_date: '2026-09-25',
      amount_cents: -5000,
      merchant_key: 'card payment',
    });
    const inn = await insertManual({
      account_id: card,
      original_name: 'Payment received',
      original_date: '2026-09-26',
      amount_cents: 5000,
      merchant_key: 'payment received',
    });
    const userSaid = await insertManual({
      account_id: checking,
      original_name: 'Not a transfer',
      original_date: '2026-09-25',
      amount_cents: -700,
      merchant_key: 'x',
      kind_source: 'user',
    });
    const other = await insertManual({
      account_id: card,
      original_name: 'Refund',
      original_date: '2026-09-25',
      amount_cents: 700,
      merchant_key: 'y',
    });

    const [res] = await t.as<{ n: number }>('service_role', null, 'select public.apply_transfer_pairs($1, $2) as n', [
      USER,
      JSON.stringify([
        { outflow_id: out, inflow_id: inn },
        { outflow_id: userSaid, inflow_id: other },
      ]),
    ]);
    expect(res!.n).toBe(1);

    const rows = await t.as<{ id: string; kind: string; transfer_pair_id: string | null }>(
      'authenticated',
      USER,
      'select id, kind, transfer_pair_id from public.transactions where id = any($1)',
      [[out, inn, userSaid, other]],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[out]).toMatchObject({ kind: 'transfer', transfer_pair_id: inn });
    expect(byId[inn]).toMatchObject({ kind: 'transfer', transfer_pair_id: out });
    expect(byId[userSaid]).toMatchObject({ kind: 'expense', transfer_pair_id: null });
    expect(byId[other]!.transfer_pair_id).toBeNull();
  });

  it('is not callable by clients', async () => {
    await expect(t.as('authenticated', USER, `select public.apply_transfer_pairs($1, '[]')`, [USER])).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('defaults', () => {
  it('fills user_id from the session so clients never send it', async () => {
    const [row] = await t.as<{ user_id: string }>(
      'authenticated',
      USER,
      `insert into public.categories (name) values ('Pets') returning user_id`,
    );
    expect(row!.user_id).toBe(USER);
  });
});
