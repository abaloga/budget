-- =============================================================================
-- Security: Row Level Security, explicit grants, and write guards.
--
--   * anon gets nothing.
--   * authenticated users can only see/modify rows where user_id = auth.uid().
--   * Provider-managed tables (connections, accounts, sync_runs) are read-only
--     to clients except for a few preference columns. All provider writes go
--     through edge functions using the service role.
--   * connection_secrets has RLS enabled and NO policies -> service role only.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Grants (explicit, rather than relying on Supabase's default privileges)
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

grant select, update on public.profiles to authenticated;
grant select on public.connections to authenticated;
grant select on public.sync_runs to authenticated;
grant select on public.accounts to authenticated;
grant update (display_name, is_hidden) on public.accounts to authenticated;
grant select, insert, update, delete on
  public.categories,
  public.recurring_series,
  public.transactions,
  public.transaction_splits,
  public.budgets,
  public.categorization_rules,
  public.savings_goals
to authenticated;

grant all on all tables in schema public to service_role;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
alter table public.profiles             enable row level security;
alter table public.connections          enable row level security;
alter table public.connection_secrets   enable row level security;
alter table public.accounts             enable row level security;
alter table public.categories           enable row level security;
alter table public.recurring_series     enable row level security;
alter table public.transactions         enable row level security;
alter table public.transaction_splits   enable row level security;
alter table public.budgets              enable row level security;
alter table public.categorization_rules enable row level security;
alter table public.savings_goals        enable row level security;
alter table public.sync_runs            enable row level security;

-- Read-only (for clients) tables
create policy profiles_select on public.profiles
  for select to authenticated using (user_id = (select auth.uid()));
create policy profiles_update on public.profiles
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy connections_select on public.connections
  for select to authenticated using (user_id = (select auth.uid()));

create policy sync_runs_select on public.sync_runs
  for select to authenticated using (user_id = (select auth.uid()));

create policy accounts_select on public.accounts
  for select to authenticated using (user_id = (select auth.uid()));
create policy accounts_update on public.accounts
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Fully user-managed tables
do $$
declare
  t text;
begin
  foreach t in array array[
    'categories', 'recurring_series', 'transaction_splits', 'budgets', 'categorization_rules', 'savings_goals'
  ] loop
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (user_id = (select auth.uid()))
         with check (user_id = (select auth.uid()))',
      t || '_owner', t
    );
  end loop;
end;
$$;

-- Clients never need to send user_id for rows they create; RLS still checks it.
do $$
declare
  t text;
begin
  foreach t in array array[
    'categories', 'recurring_series', 'transactions', 'transaction_splits', 'budgets',
    'categorization_rules', 'savings_goals'
  ] loop
    execute format('alter table public.%I alter column user_id set default auth.uid()', t);
  end loop;
end;
$$;

-- Transactions: clients may create/delete only manual transactions.
create policy transactions_select on public.transactions
  for select to authenticated using (user_id = (select auth.uid()));
create policy transactions_insert on public.transactions
  for insert to authenticated with check (user_id = (select auth.uid()) and source = 'manual');
create policy transactions_update on public.transactions
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy transactions_delete on public.transactions
  for delete to authenticated using (user_id = (select auth.uid()) and source = 'manual');

-- -----------------------------------------------------------------------------
-- Guard: clients must not rewrite raw provider data. Edits go into the
-- *_override / classification columns instead, which sync never touches.
-- The service role (edge functions) is exempt.
-- -----------------------------------------------------------------------------
create or replace function public.guard_transaction_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.user_id <> old.user_id or new.source <> old.source then
    raise exception 'user_id and source are immutable' using errcode = 'insufficient_privilege';
  end if;

  if current_user in ('authenticated', 'anon') and old.source = 'plaid' and (
       new.provider_transaction_id         is distinct from old.provider_transaction_id
    or new.provider_pending_transaction_id is distinct from old.provider_pending_transaction_id
    or new.provider_category_primary       is distinct from old.provider_category_primary
    or new.provider_category_detailed      is distinct from old.provider_category_detailed
    or new.provider_payment_channel        is distinct from old.provider_payment_channel
    or new.provider_raw                    is distinct from old.provider_raw
    or new.original_name                   is distinct from old.original_name
    or new.original_merchant_name          is distinct from old.original_merchant_name
    or new.original_date                   is distinct from old.original_date
    or new.authorized_date                 is distinct from old.authorized_date
    or new.amount_cents                    is distinct from old.amount_cents
    or new.iso_currency_code               is distinct from old.iso_currency_code
    or new.pending                         is distinct from old.pending
    or new.merchant_key                    is distinct from old.merchant_key
    or new.account_id                      is distinct from old.account_id
  ) then
    raise exception 'Imported transaction data is read-only; edit the override fields instead'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger transactions_guard
  before update on public.transactions
  for each row execute function public.guard_transaction_update();

create or replace function public.guard_transaction_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') and (
       new.provider_transaction_id is not null
    or new.provider_pending_transaction_id is not null
    or new.provider_raw is not null
  ) then
    raise exception 'Manual transactions cannot carry provider data' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger transactions_guard_insert
  before insert on public.transactions
  for each row execute function public.guard_transaction_insert();
