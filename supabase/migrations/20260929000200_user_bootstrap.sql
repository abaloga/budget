-- =============================================================================
-- New-user bootstrap: profile + default categories.
--
-- Done in the database (not a client) so the web and future iOS app get the
-- exact same starting state no matter which one the user signs up from.
-- system_key values are referenced by packages/core/src/providerCategories.ts.
-- =============================================================================

create or replace function public.seed_default_categories(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  grp uuid;
  pos integer := 0;
  g   record;
  c   record;
begin
  -- Idempotent: only seed users that have no categories yet.
  if exists (select 1 from public.categories where user_id = p_user_id) then
    return;
  end if;

  for g in
    select * from (values
      (1,  'income',         'Income',         'income',  '#16a34a'),
      (2,  'housing',        'Housing',        'expense', '#6366f1'),
      (3,  'food',           'Food',           'expense', '#f59e0b'),
      (4,  'transportation', 'Transportation', 'expense', '#0ea5e9'),
      (5,  'shopping',       'Shopping',       'expense', '#ec4899'),
      (6,  'entertainment',  'Entertainment',  'expense', '#a855f7'),
      (7,  'health',         'Health',         'expense', '#ef4444'),
      (8,  'subscriptions',  'Subscriptions',  'expense', '#14b8a6'),
      (9,  'travel',         'Travel',         'expense', '#3b82f6'),
      (10, 'personal',       'Personal',       'expense', '#f97316'),
      (11, 'savings',        'Savings',        'expense', '#22c55e'),
      (12, 'other',          'Other',          'expense', '#64748b')
    ) as v(ord, key, name, kind, color)
    order by ord
  loop
    pos := pos + 1;
    insert into public.categories (user_id, name, kind, system_key, color, sort_order)
    values (p_user_id, g.name, g.kind, g.key, g.color, pos * 100)
    returning id into grp;

    for c in
      select * from (values
        ('housing',        1, 'rent_mortgage',  'Rent/Mortgage'),
        ('housing',        2, 'utilities',      'Utilities'),
        ('housing',        3, 'internet',       'Internet'),
        ('housing',        4, 'phone',          'Phone'),
        ('food',           1, 'groceries',      'Groceries'),
        ('food',           2, 'dining',         'Dining'),
        ('transportation', 1, 'gas',            'Gas'),
        ('transportation', 2, 'auto',           'Auto'),
        ('transportation', 3, 'public_transit', 'Public Transit')
      ) as v(parent_key, ord, key, name)
      where v.parent_key = g.key
      order by ord
    loop
      insert into public.categories (user_id, parent_id, name, kind, system_key, color, sort_order)
      values (p_user_id, grp, c.name, g.kind, c.key, g.color, pos * 100 + c.ord);
    end loop;
  end loop;
end;
$$;

revoke all on function public.seed_default_categories(uuid) from public, anon, authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id) values (new.id) on conflict do nothing;
  perform public.seed_default_categories(new.id);
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
