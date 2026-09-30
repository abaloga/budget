import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from './harness.ts';

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';

let t: TestDb;
let aliceConnection: string;
let aliceChecking: string;
let aliceCard: string;
let dining: string;
let groceries: string;

async function categoryId(userId: string, systemKey: string): Promise<string> {
  const [row] = await t.as<{ id: string }>(
    'authenticated',
    userId,
    'select id from public.categories where system_key = $1',
    [systemKey],
  );
  if (!row) throw new Error(`missing category ${systemKey}`);
  return row.id;
}

function plaidRow(overrides: Record<string, unknown> = {}) {
  return {
    account_id: aliceChecking,
    provider_transaction_id: 'tx-1',
    provider_pending_transaction_id: null,
    provider_category_primary: 'FOOD_AND_DRINK',
    provider_category_detailed: 'FOOD_AND_DRINK_RESTAURANT',
    provider_payment_channel: 'in store',
    provider_raw: { name: 'CHIPOTLE 123' },
    original_name: 'CHIPOTLE 123',
    original_merchant_name: 'Chipotle',
    original_date: '2026-09-10',
    authorized_date: '2026-09-09',
    amount_cents: -1250,
    iso_currency_code: 'USD',
    pending: false,
    merchant_key: 'chipotle',
    category_id: null,
    category_source: 'none',
    kind: 'expense',
    kind_source: 'auto',
    ...overrides,
  };
}

async function applySync(args: {
  rekeys?: unknown[];
  upserts?: unknown[];
  splitUpdates?: unknown[];
  splitClears?: string[];
  removed?: string[];
  cursor?: string;
}) {
  const [row] = await t.as<{ result: Record<string, number> }>(
    'service_role',
    null,
    `select public.apply_transaction_sync($1, $2, $3, $4, $5, $6, $7, $8) as result`,
    [
      ALICE,
      aliceConnection,
      JSON.stringify(args.rekeys ?? []),
      JSON.stringify(args.upserts ?? []),
      JSON.stringify(args.splitUpdates ?? []),
      args.splitClears ?? [],
      args.removed ?? [],
      args.cursor ?? 'cursor-1',
    ],
  );
  return row!.result;
}

async function aliceTxn(providerId: string) {
  const [row] = await t.as<Record<string, unknown>>(
    'authenticated',
    ALICE,
    'select * from public.transactions where provider_transaction_id = $1',
    [providerId],
  );
  return row;
}

beforeAll(async () => {
  t = await createTestDb();
  await t.createUser(ALICE);
  await t.createUser(BOB);

  const [conn] = await t.as<{ id: string }>(
    'service_role',
    null,
    `insert into public.connections (user_id, provider_item_id, institution_name)
     values ($1, 'item-1', 'Test Bank') returning id`,
    [ALICE],
  );
  aliceConnection = conn!.id;

  const accounts = await t.as<{ id: string; provider_account_id: string }>(
    'service_role',
    null,
    `insert into public.accounts (user_id, connection_id, provider_account_id, name, type, subtype, current_balance_cents)
     values ($1, $2, 'acc-chk', 'Checking', 'depository', 'checking', 250000),
            ($1, $2, 'acc-cc', 'Sapphire', 'credit', 'credit card', 42000)
     returning id, provider_account_id`,
    [ALICE, aliceConnection],
  );
  aliceChecking = accounts.find((a) => a.provider_account_id === 'acc-chk')!.id;
  aliceCard = accounts.find((a) => a.provider_account_id === 'acc-cc')!.id;

  await t.as(
    'service_role',
    null,
    `insert into public.connection_secrets (connection_id, user_id, access_token_ciphertext) values ($1, $2, 'v1:secret')`,
    [aliceConnection, ALICE],
  );

  dining = await categoryId(ALICE, 'dining');
  groceries = await categoryId(ALICE, 'groceries');
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('user bootstrap', () => {
  it('creates a profile and the default two-level category tree', async () => {
    const profiles = await t.as('authenticated', ALICE, 'select * from public.profiles');
    expect(profiles).toHaveLength(1);

    const cats = await t.as<{ name: string; parent: string | null; kind: string }>(
      'authenticated',
      ALICE,
      `select c.name, p.name as parent, c.kind
         from public.categories c left join public.categories p on p.id = c.parent_id
        order by c.sort_order`,
    );
    const names = cats.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['Income', 'Housing', 'Rent/Mortgage', 'Groceries', 'Dining', 'Gas', 'Other']),
    );
    expect(cats.find((c) => c.name === 'Dining')?.parent).toBe('Food');
    expect(cats.find((c) => c.name === 'Income')?.kind).toBe('income');
  });

  it('rejects nesting categories more than one level deep', async () => {
    const food = await categoryId(ALICE, 'food');
    await expect(
      t.as(
        'authenticated',
        ALICE,
        `insert into public.categories (user_id, parent_id, name) values ($1, $2, 'Coffee') returning id`,
        [ALICE, dining],
      ),
    ).rejects.toThrow(/one level deep/);
    // One level is fine
    await t.as(
      'authenticated',
      ALICE,
      `insert into public.categories (user_id, parent_id, name) values ($1, $2, 'Coffee')`,
      [ALICE, food],
    );
  });
});

describe('row level security', () => {
  it('isolates users from each other', async () => {
    await applySync({ upserts: [plaidRow({ provider_transaction_id: 'rls-1' })], cursor: 'c-rls' });
    const bobSees = await t.as('authenticated', BOB, 'select * from public.transactions');
    expect(bobSees).toHaveLength(0);
    const bobAccounts = await t.as('authenticated', BOB, 'select * from public.accounts');
    expect(bobAccounts).toHaveLength(0);
    const aliceSees = await t.as('authenticated', ALICE, 'select * from public.transactions');
    expect(aliceSees.length).toBeGreaterThan(0);
  });

  it('gives anon no access at all', async () => {
    await expect(t.as('anon', null, 'select * from public.transactions')).rejects.toThrow(/permission denied/);
  });

  it('never exposes encrypted access tokens to clients', async () => {
    await expect(t.as('authenticated', ALICE, 'select * from public.connection_secrets')).rejects.toThrow(
      /permission denied/,
    );
  });

  it("prevents referencing another user's category (composite FK)", async () => {
    await expect(
      t.as(
        'authenticated',
        BOB,
        `insert into public.transactions (user_id, source, original_name, original_date, amount_cents, merchant_key, category_id)
         values ($1, 'manual', 'Sneaky', '2026-09-01', -100, 'sneaky', $2)`,
        [BOB, dining],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('prevents clients from inserting provider-sourced rows or writing to connections', async () => {
    await expect(
      t.as(
        'authenticated',
        ALICE,
        `insert into public.transactions (user_id, source, account_id, provider_transaction_id, original_name, original_date, amount_cents, merchant_key)
         values ($1, 'plaid', $2, 'fake', 'Fake', '2026-09-01', -100, 'fake')`,
        [ALICE, aliceChecking],
      ),
    ).rejects.toThrow(/row-level security|cannot carry provider data/);
    await expect(
      t.as('authenticated', ALICE, `update public.connections set transactions_cursor = 'x'`),
    ).rejects.toThrow(/permission denied/);
  });

  it('lets clients edit only preference columns on accounts', async () => {
    await t.as('authenticated', ALICE, `update public.accounts set display_name = 'Main' where id = $1`, [
      aliceChecking,
    ]);
    await expect(
      t.as('authenticated', ALICE, `update public.accounts set current_balance_cents = 1 where id = $1`, [
        aliceChecking,
      ]),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('transaction edit guards', () => {
  it('blocks edits to raw provider data but allows overrides', async () => {
    await applySync({ upserts: [plaidRow({ provider_transaction_id: 'guard-1' })] });
    const txn = await aliceTxn('guard-1');

    await expect(
      t.as('authenticated', ALICE, 'update public.transactions set amount_cents = -1 where id = $1', [txn!.id]),
    ).rejects.toThrow(/read-only/);

    await t.as(
      'authenticated',
      ALICE,
      `update public.transactions set name_override = 'Burrito', notes = 'lunch', date_override = '2026-09-11' where id = $1`,
      [txn!.id],
    );
    const edited = await aliceTxn('guard-1');
    expect(edited!.name).toBe('Burrito');
    expect((edited!.date as Date).toISOString().slice(0, 10)).toBe('2026-09-11');
    expect(edited!.original_name).toBe('CHIPOTLE 123');
  });

  it('only allows deleting manual transactions', async () => {
    const txn = await aliceTxn('guard-1');
    await t.as('authenticated', ALICE, 'delete from public.transactions where id = $1', [txn!.id]);
    expect(await aliceTxn('guard-1')).toBeDefined();

    const [manual] = await t.as<{ id: string }>(
      'authenticated',
      ALICE,
      `insert into public.transactions (user_id, source, original_name, original_date, amount_cents, merchant_key)
       values ($1, 'manual', 'Cash tip', '2026-09-02', -500, 'cash tip') returning id`,
      [ALICE],
    );
    const deleted = await t.as('authenticated', ALICE, 'delete from public.transactions where id = $1 returning id', [
      manual!.id,
    ]);
    expect(deleted).toHaveLength(1);
  });

  it('refuses to delete categories referenced by history', async () => {
    const txn = await aliceTxn('guard-1');
    await t.as(
      'authenticated',
      ALICE,
      `update public.transactions set category_id = $1, category_source = 'user' where id = $2`,
      [dining, txn!.id],
    );
    await expect(t.as('authenticated', ALICE, 'delete from public.categories where id = $1', [dining])).rejects.toThrow(
      /foreign key/,
    );
    // Archiving is the supported path
    await t.as('authenticated', ALICE, 'update public.categories set is_archived = true where id = $1', [dining]);
    await t.as('authenticated', ALICE, 'update public.categories set is_archived = false where id = $1', [dining]);
  });
});

describe('split transactions', () => {
  it('requires splits to sum to the transaction amount', async () => {
    await applySync({ upserts: [plaidRow({ provider_transaction_id: 'split-1', amount_cents: -15000 })] });
    const txn = await aliceTxn('split-1');

    await expect(
      t.as('authenticated', ALICE, 'select public.set_transaction_splits($1, $2)', [
        txn!.id,
        JSON.stringify([
          { category_id: groceries, amount_cents: -8000 },
          { category_id: dining, amount_cents: -4000 },
        ]),
      ]),
    ).rejects.toThrow(/must equal/);

    await t.as('authenticated', ALICE, 'select public.set_transaction_splits($1, $2)', [
      txn!.id,
      JSON.stringify([
        { category_id: groceries, amount_cents: -8000 },
        { category_id: dining, amount_cents: -7000 },
      ]),
    ]);

    const lines = await t.as<{ category_id: string; amount_cents: string }>(
      'authenticated',
      ALICE,
      'select category_id, amount_cents from public.transaction_lines where transaction_id = $1 order by amount_cents',
      [txn!.id],
    );
    // Two lines, not three: the parent is replaced by its splits
    expect(lines.map((l) => Number(l.amount_cents))).toEqual([-8000, -7000]);
  });

  it('rejects a single split', async () => {
    const txn = await aliceTxn('split-1');
    await expect(
      t.as('authenticated', ALICE, 'select public.set_transaction_splits($1, $2)', [
        txn!.id,
        JSON.stringify([{ category_id: groceries, amount_cents: -15000 }]),
      ]),
    ).rejects.toThrow(/at least two/);
  });

  it('lets the sync rebalance splits atomically when the amount changes', async () => {
    const txn = await aliceTxn('split-1');
    const splits = await t.as<{ id: string; amount_cents: string }>(
      'authenticated',
      ALICE,
      'select id, amount_cents from public.transaction_splits where transaction_id = $1 order by sort_order',
      [txn!.id],
    );
    await applySync({
      upserts: [plaidRow({ provider_transaction_id: 'split-1', amount_cents: -15500 })],
      splitUpdates: [{ split_id: splits[0]!.id, amount_cents: -8500 }],
    });
    const after = await t.as<{ amount_cents: string }>(
      'authenticated',
      ALICE,
      'select amount_cents from public.transaction_splits where transaction_id = $1 order by sort_order',
      [txn!.id],
    );
    expect(after.map((s) => Number(s.amount_cents))).toEqual([-8500, -7000]);
  });

  it('rejects an amount change that leaves splits unbalanced', async () => {
    await expect(
      applySync({ upserts: [plaidRow({ provider_transaction_id: 'split-1', amount_cents: -99999 })] }),
    ).rejects.toThrow(/must equal/);
  });
});

describe('apply_transaction_sync', () => {
  it('is idempotent when the same payload is replayed', async () => {
    const payload = { upserts: [plaidRow({ provider_transaction_id: 'idem-1' })], cursor: 'c-idem' };
    const first = await applySync(payload);
    const second = await applySync(payload);
    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);
    const rows = await t.as(
      'authenticated',
      ALICE,
      `select id from public.transactions where provider_transaction_id = 'idem-1'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('preserves user edits when the provider modifies a transaction', async () => {
    const txn = await aliceTxn('idem-1');
    await t.as(
      'authenticated',
      ALICE,
      `update public.transactions set category_id = $1, category_source = 'user', notes = 'keep me', name_override = 'Mine' where id = $2`,
      [groceries, txn!.id],
    );
    await applySync({
      upserts: [
        plaidRow({
          provider_transaction_id: 'idem-1',
          original_name: 'CHIPOTLE 123 UPDATED',
          category_id: dining,
          category_source: 'provider',
        }),
      ],
    });
    const after = await aliceTxn('idem-1');
    expect(after!.original_name).toBe('CHIPOTLE 123 UPDATED');
    expect(after!.category_id).toBe(groceries);
    expect(after!.category_source).toBe('user');
    expect(after!.notes).toBe('keep me');
    expect(after!.name).toBe('Mine');
  });

  it('carries user edits from a pending transaction to its posted version', async () => {
    await applySync({
      upserts: [plaidRow({ provider_transaction_id: 'pend-1', pending: true, amount_cents: -2000 })],
    });
    const pending = await aliceTxn('pend-1');
    await t.as(
      'authenticated',
      ALICE,
      `update public.transactions set category_id = $1, category_source = 'user', notes = 'dinner w/ Sam' where id = $2`,
      [dining, pending!.id],
    );

    // Plaid: posted version added (pointing at the pending id), pending removed.
    const result = await applySync({
      rekeys: [{ from_id: 'pend-1', to_id: 'post-1' }],
      upserts: [
        plaidRow({
          provider_transaction_id: 'post-1',
          provider_pending_transaction_id: 'pend-1',
          pending: false,
          amount_cents: -2400, // tip added
        }),
      ],
      removed: ['pend-1'],
      cursor: 'c-post',
    });
    expect(result.rekeyed).toBe(1);
    expect(result.removed).toBe(0);

    const posted = await aliceTxn('post-1');
    expect(posted!.id).toBe(pending!.id);
    expect(posted!.pending).toBe(false);
    expect(Number(posted!.amount_cents)).toBe(-2400);
    expect(posted!.category_id).toBe(dining);
    expect(posted!.notes).toBe('dinner w/ Sam');
    expect(await aliceTxn('pend-1')).toBeUndefined();

    const [conn] = await t.as<{ transactions_cursor: string }>(
      'authenticated',
      ALICE,
      'select transactions_cursor from public.connections where id = $1',
      [aliceConnection],
    );
    expect(conn!.transactions_cursor).toBe('c-post');
  });

  it('removes transactions the provider deleted', async () => {
    await applySync({ upserts: [plaidRow({ provider_transaction_id: 'gone-1' })] });
    const result = await applySync({ removed: ['gone-1'] });
    expect(result.removed).toBe(1);
    expect(await aliceTxn('gone-1')).toBeUndefined();
  });

  it('cannot be called by clients', async () => {
    await expect(
      t.as('authenticated', ALICE, `select public.apply_transaction_sync($1, $2, '[]', '[]', '[]', '{}', '{}', 'x')`, [
        ALICE,
        aliceConnection,
      ]),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('transfers', () => {
  it('links both sides symmetrically and unlinks when one side is re-marked', async () => {
    await applySync({
      upserts: [
        plaidRow({
          provider_transaction_id: 'xfer-out',
          original_name: 'CHASE AUTOPAY',
          merchant_key: 'chase autopay',
          amount_cents: -10000,
        }),
        plaidRow({
          provider_transaction_id: 'xfer-in',
          account_id: aliceCard,
          original_name: 'PAYMENT THANK YOU',
          merchant_key: 'payment thank you',
          amount_cents: 10000,
        }),
      ],
    });
    const out = await aliceTxn('xfer-out');
    const inn = await aliceTxn('xfer-in');
    await t.as('authenticated', ALICE, 'select public.link_transfer($1, $2)', [out!.id, inn!.id]);

    const linkedOut = await aliceTxn('xfer-out');
    const linkedIn = await aliceTxn('xfer-in');
    expect(linkedOut!.transfer_pair_id).toBe(inn!.id);
    expect(linkedIn!.transfer_pair_id).toBe(out!.id);
    expect(linkedOut!.kind).toBe('transfer');

    await t.as('authenticated', ALICE, `select public.set_transaction_kind($1, 'expense')`, [out!.id]);
    expect((await aliceTxn('xfer-out'))!.transfer_pair_id).toBeNull();
    expect((await aliceTxn('xfer-in'))!.transfer_pair_id).toBeNull();
    expect((await aliceTxn('xfer-out'))!.kind_source).toBe('user');
  });

  it('rejects linking two outflows', async () => {
    await applySync({
      upserts: [
        plaidRow({ provider_transaction_id: 'same-1', amount_cents: -100 }),
        plaidRow({ provider_transaction_id: 'same-2', amount_cents: -100 }),
      ],
    });
    const a = await aliceTxn('same-1');
    const b = await aliceTxn('same-2');
    await expect(t.as('authenticated', ALICE, 'select public.link_transfer($1, $2)', [a!.id, b!.id])).rejects.toThrow(
      /opposite directions/,
    );
  });
});

describe('aggregates', () => {
  it('groups monthly totals by category and kind for the signed-in user only', async () => {
    const rows = await t.as<{ category_id: string | null; kind: string; total_cents: string }>(
      'authenticated',
      ALICE,
      `select * from public.category_month_totals('2026-09-01', '2026-09-30')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const bobRows = await t.as(
      'authenticated',
      BOB,
      `select * from public.category_month_totals('2026-09-01', '2026-09-30')`,
    );
    expect(bobRows).toHaveLength(0);
  });

  it('returns the latest explicit user choices per merchant', async () => {
    const rows = await t.as<{ merchant_key: string; category_id: string | null }>(
      'authenticated',
      ALICE,
      'select * from public.merchant_history($1)',
      [ALICE],
    );
    expect(rows.find((r) => r.merchant_key === 'chipotle')).toBeDefined();
  });
});
