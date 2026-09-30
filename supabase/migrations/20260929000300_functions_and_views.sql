-- =============================================================================
-- Views and RPCs
--
-- SQL here does storage-level work only (atomic writes, grouping/summing).
-- Business rules — what counts as spending, rollover math, categorization,
-- transfer and recurring detection — live in packages/core so they are shared
-- by the web app, the future iOS app, and the edge functions.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- transaction_lines: the single source for reporting. A split transaction
-- contributes one line per split; an unsplit one contributes itself. This is
-- what prevents a split parent from being counted twice.
-- Mirrors `toLines()` in packages/core/src/splits.ts.
-- -----------------------------------------------------------------------------
create view public.transaction_lines
with (security_invoker = true)
as
select
  t.id                                    as transaction_id,
  s.id                                    as split_id,
  t.user_id,
  t.account_id,
  t.date,
  t.name,
  t.merchant_key,
  t.kind,
  t.pending,
  coalesce(s.category_id, t.category_id)  as category_id,
  coalesce(s.amount_cents, t.amount_cents) as amount_cents
from public.transactions t
left join public.transaction_splits s on s.transaction_id = t.id;

grant select on public.transaction_lines to authenticated, service_role;

-- Monthly totals grouped by category and kind. Callers (core/reports.ts,
-- core/budget.ts) decide which kinds count toward spending/income.
create or replace function public.category_month_totals(p_start date, p_end date)
returns table (month date, category_id uuid, kind text, total_cents bigint, line_count integer)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    date_trunc('month', l.date)::date,
    l.category_id,
    l.kind,
    sum(l.amount_cents)::bigint,
    count(*)::integer
  from public.transaction_lines l
  where l.user_id = (select auth.uid())
    and l.date >= p_start
    and l.date <= p_end
  group by 1, 2, 3
$$;

create or replace function public.merchant_totals(p_start date, p_end date)
returns table (merchant_key text, name text, kind text, total_cents bigint, line_count integer)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    l.merchant_key,
    max(l.name),
    l.kind,
    sum(l.amount_cents)::bigint,
    count(*)::integer
  from public.transaction_lines l
  where l.user_id = (select auth.uid())
    and l.date >= p_start
    and l.date <= p_end
  group by l.merchant_key, l.kind
$$;

-- Latest explicit user choice per merchant; feeds history-based categorization.
create or replace function public.merchant_history(p_user_id uuid)
returns table (merchant_key text, category_id uuid, kind text)
language sql
stable
security invoker
set search_path = ''
as $$
  select distinct on (t.merchant_key)
    t.merchant_key,
    case when t.category_source = 'user' then t.category_id end,
    case when t.kind_source = 'user' then t.kind end
  from public.transactions t
  where t.user_id = p_user_id
    and (t.category_source = 'user' or t.kind_source = 'user')
  order by t.merchant_key, t.updated_at desc
$$;

-- -----------------------------------------------------------------------------
-- Splits: replace all splits for a transaction atomically. The deferred
-- constraint trigger validates the total at commit. Pass [] to un-split.
-- -----------------------------------------------------------------------------
create or replace function public.set_transaction_splits(p_transaction_id uuid, p_splits jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid;
begin
  select user_id into v_user from public.transactions where id = p_transaction_id;
  if not found then
    raise exception 'Transaction not found' using errcode = 'no_data_found';
  end if;

  delete from public.transaction_splits where transaction_id = p_transaction_id;

  insert into public.transaction_splits (user_id, transaction_id, category_id, amount_cents, notes, sort_order)
  select
    v_user,
    p_transaction_id,
    (e.value ->> 'category_id')::uuid,
    (e.value ->> 'amount_cents')::bigint,
    nullif(e.value ->> 'notes', ''),
    (e.ord - 1)::integer
  from jsonb_array_elements(coalesce(p_splits, '[]'::jsonb)) with ordinality as e(value, ord);
end;
$$;

-- -----------------------------------------------------------------------------
-- Transfers: keep both sides of a link symmetric.
-- -----------------------------------------------------------------------------
create or replace function public.link_transfer(p_a uuid, p_b uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  a public.transactions;
  b public.transactions;
begin
  if p_a = p_b then
    raise exception 'Cannot link a transaction to itself' using errcode = 'check_violation';
  end if;
  select * into a from public.transactions where id = p_a;
  select * into b from public.transactions where id = p_b;
  if a.id is null or b.id is null then
    raise exception 'Transaction not found' using errcode = 'no_data_found';
  end if;
  if sign(a.amount_cents) = sign(b.amount_cents) then
    raise exception 'Transfer sides must move money in opposite directions' using errcode = 'check_violation';
  end if;

  -- Break any existing links on either side first.
  update public.transactions set transfer_pair_id = null
   where id in (a.transfer_pair_id, b.transfer_pair_id) and id not in (p_a, p_b);

  update public.transactions
     set kind = 'transfer',
         kind_source = 'user',
         transfer_pair_id = case when id = p_a then p_b else p_a end
   where id in (p_a, p_b);
end;
$$;

-- Set a transaction's kind as an explicit user choice. Leaving 'transfer'
-- unlinks the pair (the other side keeps its own kind).
create or replace function public.set_transaction_kind(p_id uuid, p_kind text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_pair uuid;
begin
  if p_kind not in ('expense', 'income', 'transfer') then
    raise exception 'Invalid kind %', p_kind using errcode = 'check_violation';
  end if;

  select transfer_pair_id into v_pair from public.transactions where id = p_id;
  if not found then
    raise exception 'Transaction not found' using errcode = 'no_data_found';
  end if;

  if p_kind <> 'transfer' and v_pair is not null then
    update public.transactions set transfer_pair_id = null where id in (p_id, v_pair);
  end if;

  update public.transactions set kind = p_kind, kind_source = 'user' where id = p_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Sync (service role only)
-- -----------------------------------------------------------------------------

-- Take a short lease on a connection. Returns false if another sync holds it.
create or replace function public.acquire_sync_lease(p_connection_id uuid, p_seconds integer default 300)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.connections
     set sync_lease_until = now() + make_interval(secs => p_seconds),
         last_sync_attempt_at = now()
   where id = p_connection_id
     and status <> 'disconnected'
     and (sync_lease_until is null or sync_lease_until < now());
  return found;
end;
$$;

-- Apply one fully-paginated provider sync atomically, then advance the cursor.
-- Idempotent: replaying the same payload converges on the same state.
--
--   p_rekeys        [{from_id, to_id}]  pending id -> posted id (keeps user edits)
--   p_upserts       [transaction rows]  provider columns (+ classification, used
--                                       only when the row is new)
--   p_split_updates [{split_id, amount_cents}] rebalance after amount changes
--   p_split_clears  transaction ids whose splits can't be rebalanced
--   p_removed       provider transaction ids to delete
create or replace function public.apply_transaction_sync(
  p_user_id        uuid,
  p_connection_id  uuid,
  p_rekeys         jsonb,
  p_upserts        jsonb,
  p_split_updates  jsonb,
  p_split_clears   uuid[],
  p_removed        text[],
  p_cursor         text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rekeyed  integer := 0;
  v_inserted integer := 0;
  v_updated  integer := 0;
  v_removed  integer := 0;
begin
  if not exists (select 1 from public.connections where id = p_connection_id and user_id = p_user_id) then
    raise exception 'Connection not found for user' using errcode = 'no_data_found';
  end if;

  -- 1. pending -> posted: move the posted id onto the existing pending row so
  --    categories, notes, splits, and transfer links survive.
  update public.transactions t
     set provider_transaction_id = r.to_id
    from jsonb_to_recordset(coalesce(p_rekeys, '[]'::jsonb)) as r(from_id text, to_id text)
   where t.user_id = p_user_id
     and t.provider_transaction_id = r.from_id
     and not exists (
       select 1 from public.transactions x
        where x.user_id = p_user_id and x.provider_transaction_id = r.to_id
     );
  get diagnostics v_rekeyed = row_count;

  -- 2. Upsert provider data. ON CONFLICT only touches provider-owned columns,
  --    never overrides or classification.
  with incoming as (
    select * from jsonb_to_recordset(coalesce(p_upserts, '[]'::jsonb)) as r(
      account_id                      uuid,
      provider_transaction_id         text,
      provider_pending_transaction_id text,
      provider_category_primary       text,
      provider_category_detailed      text,
      provider_payment_channel        text,
      provider_raw                    jsonb,
      original_name                   text,
      original_merchant_name          text,
      original_date                   date,
      authorized_date                 date,
      amount_cents                    bigint,
      iso_currency_code               text,
      pending                         boolean,
      merchant_key                    text,
      category_id                     uuid,
      category_source                 text,
      kind                            text,
      kind_source                     text
    )
  ),
  written as (
    insert into public.transactions (
      user_id, source, account_id,
      provider_transaction_id, provider_pending_transaction_id,
      provider_category_primary, provider_category_detailed, provider_payment_channel, provider_raw,
      original_name, original_merchant_name, original_date, authorized_date,
      amount_cents, iso_currency_code, pending, merchant_key,
      category_id, category_source, kind, kind_source
    )
    select
      p_user_id, 'plaid', i.account_id,
      i.provider_transaction_id, i.provider_pending_transaction_id,
      i.provider_category_primary, i.provider_category_detailed, i.provider_payment_channel, i.provider_raw,
      i.original_name, i.original_merchant_name, i.original_date, i.authorized_date,
      i.amount_cents, coalesce(i.iso_currency_code, 'USD'), coalesce(i.pending, false), i.merchant_key,
      i.category_id, coalesce(i.category_source, 'none'), coalesce(i.kind, 'expense'), coalesce(i.kind_source, 'auto')
    from incoming i
    on conflict (user_id, provider_transaction_id) do update set
      account_id                      = excluded.account_id,
      provider_pending_transaction_id = excluded.provider_pending_transaction_id,
      provider_category_primary       = excluded.provider_category_primary,
      provider_category_detailed      = excluded.provider_category_detailed,
      provider_payment_channel        = excluded.provider_payment_channel,
      provider_raw                    = excluded.provider_raw,
      original_name                   = excluded.original_name,
      original_merchant_name          = excluded.original_merchant_name,
      original_date                   = excluded.original_date,
      authorized_date                 = excluded.authorized_date,
      amount_cents                    = excluded.amount_cents,
      iso_currency_code               = excluded.iso_currency_code,
      pending                         = excluded.pending,
      merchant_key                    = excluded.merchant_key
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
    into v_inserted, v_updated
    from written;

  -- 3. Keep splits consistent with any changed amounts.
  update public.transaction_splits s
     set amount_cents = u.amount_cents
    from jsonb_to_recordset(coalesce(p_split_updates, '[]'::jsonb)) as u(split_id uuid, amount_cents bigint)
   where s.id = u.split_id and s.user_id = p_user_id;

  delete from public.transaction_splits
   where user_id = p_user_id and transaction_id = any(coalesce(p_split_clears, '{}'));

  -- 4. Removals (e.g. a pending charge that never posted).
  delete from public.transactions
   where user_id = p_user_id and provider_transaction_id = any(coalesce(p_removed, '{}'));
  get diagnostics v_removed = row_count;

  -- 5. Advance the cursor in the same transaction as the data it covers.
  update public.connections
     set transactions_cursor = p_cursor,
         last_synced_at = now()
   where id = p_connection_id;

  return jsonb_build_object(
    'rekeyed', v_rekeyed,
    'inserted', v_inserted,
    'updated', v_updated,
    'removed', v_removed
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Function privileges (functions default to EXECUTE for PUBLIC)
-- -----------------------------------------------------------------------------
revoke all on function public.category_month_totals(date, date) from public, anon;
revoke all on function public.merchant_totals(date, date) from public, anon;
revoke all on function public.merchant_history(uuid) from public, anon;
revoke all on function public.set_transaction_splits(uuid, jsonb) from public, anon;
revoke all on function public.link_transfer(uuid, uuid) from public, anon;
revoke all on function public.set_transaction_kind(uuid, text) from public, anon;
revoke all on function public.acquire_sync_lease(uuid, integer) from public, anon, authenticated;
revoke all on function public.apply_transaction_sync(uuid, uuid, jsonb, jsonb, jsonb, uuid[], text[], text)
  from public, anon, authenticated;

grant execute on function public.category_month_totals(date, date) to authenticated, service_role;
grant execute on function public.merchant_totals(date, date) to authenticated, service_role;
grant execute on function public.merchant_history(uuid) to authenticated, service_role;
grant execute on function public.set_transaction_splits(uuid, jsonb) to authenticated, service_role;
grant execute on function public.link_transfer(uuid, uuid) to authenticated, service_role;
grant execute on function public.set_transaction_kind(uuid, text) to authenticated, service_role;
grant execute on function public.acquire_sync_lease(uuid, integer) to service_role;
grant execute on function public.apply_transaction_sync(uuid, uuid, jsonb, jsonb, jsonb, uuid[], text[], text)
  to service_role;
