-- =============================================================================
-- Transaction search. One RPC so every filter combines (AND) and category
-- filters are split-aware — neither is expressible as plain PostgREST filters.
-- Returns setof transactions, so clients can still embed relations and request
-- an exact count through PostgREST.
--
-- p_filters mirrors `TransactionFilters` in packages/core/src/filters.ts:
--   search          text     name / original name / notes (case-insensitive)
--   category_ids    uuid[]   matches the transaction's category OR any split's
--   uncategorized   boolean  no category and no splits (non-transfers)
--   account_ids     uuid[]
--   start_date      date     inclusive, effective date
--   end_date        date     inclusive
--   min_amount_cents bigint  magnitude (absolute value), inclusive
--   max_amount_cents bigint  magnitude, inclusive
--   status          'pending' | 'posted'
--   kinds           text[]   expense | income | transfer
-- p_sort: 'date' | 'amount' | 'name'
-- =============================================================================

create or replace function public.search_transactions(
  p_filters jsonb default '{}'::jsonb,
  p_sort    text default 'date',
  p_desc    boolean default true
)
returns setof public.transactions
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  f_search        text    := nullif(btrim(p_filters ->> 'search'), '');
  f_category_ids  uuid[]  := (select array_agg(value::uuid) from jsonb_array_elements_text(p_filters -> 'category_ids'));
  f_uncategorized boolean := coalesce((p_filters ->> 'uncategorized')::boolean, false);
  f_account_ids   uuid[]  := (select array_agg(value::uuid) from jsonb_array_elements_text(p_filters -> 'account_ids'));
  f_start         date    := (p_filters ->> 'start_date')::date;
  f_end           date    := (p_filters ->> 'end_date')::date;
  f_min           bigint  := (p_filters ->> 'min_amount_cents')::bigint;
  f_max           bigint  := (p_filters ->> 'max_amount_cents')::bigint;
  f_status        text    := p_filters ->> 'status';
  f_kinds         text[]  := (select array_agg(value) from jsonb_array_elements_text(p_filters -> 'kinds'));
  f_pattern       text;
begin
  if f_search is not null then
    -- Escape LIKE wildcards so user input is matched literally.
    f_pattern := '%' || replace(replace(replace(f_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  select t.*
    from public.transactions t
   where t.user_id = (select auth.uid())
     and (f_pattern is null
          or t.name ilike f_pattern
          or t.original_name ilike f_pattern
          or coalesce(t.notes, '') ilike f_pattern)
     and (f_category_ids is null
          or t.category_id = any(f_category_ids)
          or exists (select 1 from public.transaction_splits s
                      where s.transaction_id = t.id and s.category_id = any(f_category_ids)))
     and (not f_uncategorized
          or (t.category_id is null
              and t.kind <> 'transfer'
              and not exists (select 1 from public.transaction_splits s where s.transaction_id = t.id)))
     and (f_account_ids is null or t.account_id = any(f_account_ids))
     and (f_start is null or t.date >= f_start)
     and (f_end is null or t.date <= f_end)
     and (f_min is null or abs(t.amount_cents) >= f_min)
     and (f_max is null or abs(t.amount_cents) <= f_max)
     and (f_status is null
          or (f_status = 'pending' and t.pending)
          or (f_status = 'posted' and not t.pending))
     and (f_kinds is null or t.kind = any(f_kinds))
   order by
     case when p_sort = 'amount' and not p_desc then abs(t.amount_cents) end asc nulls last,
     case when p_sort = 'amount' and p_desc then abs(t.amount_cents) end desc nulls last,
     case when p_sort = 'name' and not p_desc then lower(t.name) end asc nulls last,
     case when p_sort = 'name' and p_desc then lower(t.name) end desc nulls last,
     case when p_sort = 'date' and not p_desc then t.date end asc nulls last,
     t.date desc,
     t.created_at desc,
     t.id;
end;
$$;

revoke all on function public.search_transactions(jsonb, text, boolean) from public, anon;
grant execute on function public.search_transactions(jsonb, text, boolean) to authenticated;
