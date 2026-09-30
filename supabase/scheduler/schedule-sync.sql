-- =============================================================================
-- Scheduled Plaid sync (safety net for missed webhooks).
--
-- NOT a migration: it contains environment-specific values. Run it once per
-- Supabase project in the SQL editor after deploying the `scheduled-sync`
-- function and setting its CRON_SECRET function secret.
--
-- Secrets are stored in Supabase Vault, not in the cron job text.
-- =============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1. Store the project URL and the same CRON_SECRET you set on the function.
select vault.create_secret('https://YOUR-PROJECT-REF.supabase.co', 'budget_project_url');
select vault.create_secret('REPLACE-WITH-YOUR-CRON-SECRET', 'budget_cron_secret');

-- 2. Every 6 hours, ask the edge function to sync connections that are due.
select cron.schedule(
  'budget-scheduled-sync',
  '15 */6 * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'budget_project_url')
           || '/functions/v1/scheduled-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'budget_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- To change or remove later:
--   select cron.unschedule('budget-scheduled-sync');
--   select * from cron.job_run_details order by start_time desc limit 20;
