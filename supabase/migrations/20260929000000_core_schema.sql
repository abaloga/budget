-- =============================================================================
-- Core schema
--
-- Conventions
--   * Every user-owned table has user_id (references auth.users) even though the
--     app is single-user today; RLS policies key off it.
--   * Cross-table references use composite (id, user_id) foreign keys so a row
--     can never point at another user's data, even through a service-role bug.
--   * Money is stored as integer cents (bigint). Transaction amounts are signed
--     from the user's point of view: positive = money in, negative = money out.
--     (Plaid uses the opposite sign; the sync layer normalizes.)
--   * Calendar dates are `date`, never timestamps, so month boundaries don't
--     shift with time zones.
--   * Enumerations are text + CHECK (easier to evolve than Postgres enums).
-- =============================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- profiles: per-user preferences (1:1 with auth.users)
-- -----------------------------------------------------------------------------
create table public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  currency     text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- connections: one row per linked institution login (a Plaid "Item")
-- -----------------------------------------------------------------------------
create table public.connections (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users (id) on delete cascade,
  provider                 text not null default 'plaid' check (provider in ('plaid')),
  provider_item_id         text not null,
  institution_provider_id  text,
  institution_name         text not null default 'Unknown institution',
  status                   text not null default 'active'
                             check (status in ('active', 'login_required', 'pending_expiration', 'error', 'disconnected')),
  -- Provider error code only (e.g. ITEM_LOGIN_REQUIRED). Never tokens or payloads.
  status_detail            text,
  -- Plaid /transactions/sync cursor. Advanced atomically with the data it covers.
  transactions_cursor      text,
  last_synced_at           timestamptz,
  last_sync_attempt_at     timestamptz,
  -- Short lease so a webhook and a scheduled run can't sync one item concurrently.
  sync_lease_until         timestamptz,
  consent_expires_at       timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (provider, provider_item_id),
  unique (id, user_id)
);
create index connections_user_idx on public.connections (user_id);

-- Encrypted provider access tokens. Deliberately separate from `connections` so
-- the client-readable table never contains secret material. No RLS policies are
-- defined for this table: only the service role (edge functions) can touch it.
create table public.connection_secrets (
  connection_id            uuid primary key references public.connections (id) on delete cascade,
  user_id                  uuid not null references auth.users (id) on delete cascade,
  access_token_ciphertext  text not null,
  key_version              smallint not null default 1,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- accounts: checking, savings, credit cards... belonging to a connection
-- -----------------------------------------------------------------------------
create table public.accounts (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users (id) on delete cascade,
  connection_id            uuid not null,
  provider_account_id      text not null,
  name                     text not null,
  official_name            text,
  mask                     text,
  type                     text not null check (type in ('depository', 'credit', 'loan', 'investment', 'other')),
  subtype                  text,
  -- Balances as reported by the provider (credit: amount owed is positive).
  current_balance_cents    bigint,
  available_balance_cents  bigint,
  credit_limit_cents       bigint,
  iso_currency_code        text not null default 'USD',
  balance_updated_at       timestamptz,
  -- User preferences
  display_name             text,
  is_hidden                boolean not null default false,
  -- False once the provider stops returning the account or the item is removed.
  is_active                boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  foreign key (connection_id, user_id) references public.connections (id, user_id) on delete cascade,
  unique (connection_id, provider_account_id),
  unique (id, user_id)
);
create index accounts_user_idx on public.accounts (user_id);

-- -----------------------------------------------------------------------------
-- categories: two levels (group -> category). Archive instead of delete; the
-- ON DELETE RESTRICT FKs from transactions/splits make deleting a category that
-- history references impossible.
-- -----------------------------------------------------------------------------
create table public.categories (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users (id) on delete cascade,
  parent_id            uuid,
  name                 text not null check (length(btrim(name)) between 1 and 60),
  kind                 text not null default 'expense' check (kind in ('expense', 'income')),
  -- Stable identifier for seeded defaults so provider-category mapping survives renames.
  system_key           text,
  color                text,
  sort_order           integer not null default 0,
  rollover_enabled     boolean not null default false,
  -- First month (1st of month) from which unused budget/overspend carries forward.
  rollover_start_month date check (rollover_start_month = date_trunc('month', rollover_start_month)::date),
  is_archived          boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  foreign key (parent_id, user_id) references public.categories (id, user_id) on delete restrict,
  check (parent_id is null or parent_id <> id),
  unique (id, user_id),
  unique (user_id, system_key)
);
create unique index categories_unique_active_name
  on public.categories (user_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)))
  where not is_archived;
create index categories_parent_idx on public.categories (parent_id);

-- Keep the hierarchy two levels deep and kinds consistent within a group.
create or replace function public.enforce_category_hierarchy()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent public.categories;
begin
  if new.parent_id is not null then
    select * into parent from public.categories where id = new.parent_id;
    if parent.parent_id is not null then
      raise exception 'Categories can only be nested one level deep' using errcode = 'check_violation';
    end if;
    if parent.kind <> new.kind then
      raise exception 'A category must have the same kind as its group' using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.categories c where c.parent_id = new.id) then
      raise exception 'A group with categories cannot itself be nested' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
create trigger categories_hierarchy
  before insert or update of parent_id, kind on public.categories
  for each row execute function public.enforce_category_hierarchy();

-- -----------------------------------------------------------------------------
-- recurring_series: bills, subscriptions, paychecks (detected or manual)
-- -----------------------------------------------------------------------------
create table public.recurring_series (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users (id) on delete cascade,
  name                   text not null check (length(btrim(name)) between 1 and 120),
  -- Normalized merchant (see packages/core merchant.ts). One series per merchant.
  merchant_key           text,
  account_id             uuid,
  category_id            uuid,
  kind                   text not null default 'expense' check (kind in ('expense', 'income')),
  frequency              text not null
                           check (frequency in ('weekly', 'biweekly', 'monthly', 'quarterly', 'semiannual', 'annual')),
  -- Magnitudes (always >= 0); `kind` gives the direction.
  expected_amount_cents  bigint not null check (expected_amount_cents >= 0),
  amount_min_cents       bigint check (amount_min_cents >= 0),
  amount_max_cents       bigint check (amount_max_cents >= 0),
  last_date              date,
  next_date              date,
  status                 text not null default 'active' check (status in ('active', 'ignored')),
  source                 text not null default 'manual' check (source in ('detected', 'manual')),
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  foreign key (account_id, user_id) references public.accounts (id, user_id) on delete set null (account_id),
  foreign key (category_id, user_id) references public.categories (id, user_id) on delete set null (category_id),
  check (amount_min_cents is null or amount_max_cents is null or amount_min_cents <= amount_max_cents),
  unique (id, user_id),
  unique (user_id, merchant_key)
);
create index recurring_series_next_idx on public.recurring_series (user_id, status, next_date);

-- -----------------------------------------------------------------------------
-- transactions
--
-- Three groups of columns:
--   1. provider_* / original_* / amount / pending: written by sync (or by the
--      user for manual transactions). A guard trigger stops clients from editing
--      them on provider-sourced rows.
--   2. *_override, notes, classification: the user's edits. Sync never writes
--      these on existing rows, so a refresh can't undo them.
--   3. name / date: generated "effective" values used by every query.
-- -----------------------------------------------------------------------------
create table public.transactions (
  id                               uuid primary key default gen_random_uuid(),
  user_id                          uuid not null references auth.users (id) on delete cascade,
  account_id                       uuid,
  source                           text not null check (source in ('plaid', 'manual')),

  -- Raw provider data
  provider_transaction_id          text,
  provider_pending_transaction_id  text,
  provider_category_primary        text,
  provider_category_detailed       text,
  provider_payment_channel         text,
  provider_raw                     jsonb,

  -- Original values (provider-supplied, or as entered for manual transactions)
  original_name                    text not null check (length(btrim(original_name)) between 1 and 300),
  original_merchant_name           text,
  original_date                    date not null,
  authorized_date                  date,
  amount_cents                     bigint not null,
  iso_currency_code                text not null default 'USD',
  pending                          boolean not null default false,
  merchant_key                     text not null,

  -- User overrides
  name_override                    text check (name_override is null or length(btrim(name_override)) between 1 and 300),
  date_override                    date,
  notes                            text check (notes is null or length(notes) <= 2000),

  -- Classification
  category_id                      uuid,
  category_source                  text not null default 'none'
                                     check (category_source in ('none', 'user', 'rule', 'history', 'provider')),
  kind                             text not null default 'expense' check (kind in ('expense', 'income', 'transfer')),
  kind_source                      text not null default 'auto' check (kind_source in ('auto', 'user', 'rule')),
  transfer_pair_id                 uuid,
  recurring_id                     uuid,

  -- Effective values
  name                             text generated always as (coalesce(name_override, original_merchant_name, original_name)) stored,
  date                             date generated always as (coalesce(date_override, original_date)) stored,

  created_at                       timestamptz not null default now(),
  updated_at                       timestamptz not null default now(),

  foreign key (account_id, user_id) references public.accounts (id, user_id) on delete cascade,
  foreign key (category_id, user_id) references public.categories (id, user_id) on delete restrict,
  foreign key (transfer_pair_id, user_id) references public.transactions (id, user_id) on delete set null (transfer_pair_id),
  foreign key (recurring_id, user_id) references public.recurring_series (id, user_id) on delete set null (recurring_id),
  check ((source = 'plaid') = (provider_transaction_id is not null)),
  check (source <> 'plaid' or account_id is not null),
  check (transfer_pair_id is null or transfer_pair_id <> id),
  unique (user_id, provider_transaction_id),
  unique (id, user_id)
);
create index transactions_user_date_idx on public.transactions (user_id, date desc, id);
create index transactions_account_date_idx on public.transactions (account_id, date desc);
create index transactions_category_idx on public.transactions (category_id);
create index transactions_merchant_idx on public.transactions (user_id, merchant_key);
create index transactions_pending_id_idx on public.transactions (user_id, provider_pending_transaction_id)
  where provider_pending_transaction_id is not null;
create index transactions_recurring_idx on public.transactions (recurring_id) where recurring_id is not null;
create index transactions_transfer_pair_idx on public.transactions (transfer_pair_id) where transfer_pair_id is not null;

-- -----------------------------------------------------------------------------
-- transaction_splits: divide one transaction across categories. When a
-- transaction has splits, reporting uses the splits *instead of* the parent
-- (see view transaction_lines). A deferred constraint trigger guarantees the
-- splits always sum to the parent amount.
-- -----------------------------------------------------------------------------
create table public.transaction_splits (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  transaction_id  uuid not null,
  category_id     uuid not null,
  amount_cents    bigint not null check (amount_cents <> 0),
  notes           text check (notes is null or length(notes) <= 500),
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (transaction_id, user_id) references public.transactions (id, user_id) on delete cascade,
  foreign key (category_id, user_id) references public.categories (id, user_id) on delete restrict
);
create index transaction_splits_txn_idx on public.transaction_splits (transaction_id);
create index transaction_splits_category_idx on public.transaction_splits (category_id);

create or replace function public.check_split_total()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  txn_id      uuid;
  txn_amount  bigint;
  split_count integer;
  split_sum   bigint;
begin
  if tg_table_name = 'transaction_splits' then
    txn_id := coalesce(new.transaction_id, old.transaction_id);
  else
    txn_id := new.id;
  end if;

  select amount_cents into txn_amount from public.transactions where id = txn_id;
  if not found then
    return null; -- parent deleted; its splits cascade away
  end if;

  select count(*), coalesce(sum(amount_cents), 0)
    into split_count, split_sum
    from public.transaction_splits where transaction_id = txn_id;

  if split_count = 1 then
    raise exception 'A split transaction needs at least two parts' using errcode = 'check_violation';
  end if;
  if split_count > 1 and split_sum <> txn_amount then
    raise exception 'Split amounts (%) must equal the transaction amount (%)', split_sum, txn_amount
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create constraint trigger transaction_splits_total
  after insert or update or delete on public.transaction_splits
  deferrable initially deferred
  for each row execute function public.check_split_total();

create constraint trigger transactions_split_total
  after update of amount_cents on public.transactions
  deferrable initially deferred
  for each row execute function public.check_split_total();

-- -----------------------------------------------------------------------------
-- budgets: one amount per category per month
-- -----------------------------------------------------------------------------
create table public.budgets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  category_id   uuid not null,
  month         date not null check (month = date_trunc('month', month)::date),
  amount_cents  bigint not null check (amount_cents >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (category_id, user_id) references public.categories (id, user_id) on delete cascade,
  unique (user_id, category_id, month)
);
create index budgets_user_month_idx on public.budgets (user_id, month);

-- -----------------------------------------------------------------------------
-- categorization_rules: all present conditions must match (AND). Lower
-- priority numbers run first; the first matching rule wins.
-- -----------------------------------------------------------------------------
create table public.categorization_rules (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  is_enabled        boolean not null default true,
  priority          integer not null default 100,
  -- Conditions
  name_operator     text check (name_operator in ('contains', 'equals', 'starts_with')),
  name_value        text check (name_value is null or length(btrim(name_value)) between 1 and 200),
  account_id        uuid,
  direction         text check (direction in ('inflow', 'outflow')),
  amount_min_cents  bigint check (amount_min_cents >= 0),
  amount_max_cents  bigint check (amount_max_cents >= 0),
  -- Actions
  set_category_id   uuid,
  set_kind          text check (set_kind in ('expense', 'income', 'transfer')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (account_id, user_id) references public.accounts (id, user_id) on delete cascade,
  foreign key (set_category_id, user_id) references public.categories (id, user_id) on delete cascade,
  check ((name_operator is null) = (name_value is null)),
  check (name_value is not null or account_id is not null or direction is not null
         or amount_min_cents is not null or amount_max_cents is not null),
  check (set_category_id is not null or set_kind is not null),
  check (amount_min_cents is null or amount_max_cents is null or amount_min_cents <= amount_max_cents)
);
create index categorization_rules_user_idx on public.categorization_rules (user_id, priority);

-- -----------------------------------------------------------------------------
-- savings_goals
-- -----------------------------------------------------------------------------
create table public.savings_goals (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  name           text not null check (length(btrim(name)) between 1 and 80),
  target_cents   bigint not null check (target_cents > 0),
  -- Manually tracked amount. Ignored when account_id is set (balance is used).
  current_cents  bigint not null default 0 check (current_cents >= 0),
  account_id     uuid,
  target_date    date,
  color          text,
  sort_order     integer not null default 0,
  is_archived    boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (account_id, user_id) references public.accounts (id, user_id) on delete set null (account_id)
);
create index savings_goals_user_idx on public.savings_goals (user_id, sort_order);

-- -----------------------------------------------------------------------------
-- sync_runs: audit trail of provider syncs (counts and error codes only)
-- -----------------------------------------------------------------------------
create table public.sync_runs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  connection_id   uuid not null,
  trigger         text not null check (trigger in ('initial', 'manual', 'webhook', 'scheduled')),
  status          text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  added_count     integer not null default 0,
  modified_count  integer not null default 0,
  removed_count   integer not null default 0,
  error_code      text,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  foreign key (connection_id, user_id) references public.connections (id, user_id) on delete cascade
);
create index sync_runs_connection_idx on public.sync_runs (connection_id, started_at desc);

-- -----------------------------------------------------------------------------
-- updated_at triggers
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'connections', 'connection_secrets', 'accounts', 'categories', 'recurring_series',
    'transactions', 'transaction_splits', 'budgets', 'categorization_rules', 'savings_goals'
  ] loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
      t || '_updated_at', t
    );
  end loop;
end;
$$;
