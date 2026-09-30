-- =============================================================================
-- Apply transfer pairs found by packages/core findTransferPairs (service role).
-- A pair is linked only if BOTH sides are still eligible, so links are always
-- symmetric and never override an explicit user decision.
-- =============================================================================

create or replace function public.apply_transfer_pairs(p_user_id uuid, p_pairs jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with pairs as (
    select (e ->> 'outflow_id')::uuid as a, (e ->> 'inflow_id')::uuid as b
      from jsonb_array_elements(coalesce(p_pairs, '[]'::jsonb)) as e
  ),
  eligible as (
    select p.a, p.b
      from pairs p
      join public.transactions ta on ta.id = p.a and ta.user_id = p_user_id
      join public.transactions tb on tb.id = p.b and tb.user_id = p_user_id
     where ta.transfer_pair_id is null
       and tb.transfer_pair_id is null
       and not (ta.kind_source = 'user' and ta.kind <> 'transfer')
       and not (tb.kind_source = 'user' and tb.kind <> 'transfer')
       and ta.amount_cents = -tb.amount_cents
  ),
  sides as (
    select a as id, b as other from eligible
    union all
    select b as id, a as other from eligible
  )
  update public.transactions t
     set kind = 'transfer',
         transfer_pair_id = s.other
    from sides s
   where t.id = s.id;

  get diagnostics v_count = row_count;
  return v_count / 2;
end;
$$;

revoke all on function public.apply_transfer_pairs(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_transfer_pairs(uuid, jsonb) to service_role;
