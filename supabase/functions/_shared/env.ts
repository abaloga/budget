/**
 * Server-side configuration. These values exist only in Supabase function
 * secrets (or supabase/functions/.env locally) — never in the web bundle.
 */
export type PlaidEnvironment = 'sandbox' | 'production';

export interface ServerConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  plaidClientId: string;
  plaidSecret: string;
  plaidEnv: PlaidEnvironment;
  plaidWebhookUrl: string | null;
  plaidRedirectUri: string | null;
  plaidCountryCodes: string[];
  tokenEncryptionKey: string;
  cronSecret: string | null;
  allowedOrigins: string[];
}

export class ConfigError extends Error {}

function required(get: (k: string) => string | undefined, key: string): string {
  const v = get(key)?.trim();
  if (!v) throw new ConfigError(`Missing required environment variable ${key}`);
  return v;
}

export function loadConfig(get: (k: string) => string | undefined = (k) => Deno.env.get(k)): ServerConfig {
  const plaidEnv = (get('PLAID_ENV') ?? 'sandbox').trim();
  if (plaidEnv !== 'sandbox' && plaidEnv !== 'production') {
    throw new ConfigError('PLAID_ENV must be "sandbox" or "production"');
  }
  const list = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  return {
    supabaseUrl: required(get, 'SUPABASE_URL'),
    serviceRoleKey: required(get, 'SUPABASE_SERVICE_ROLE_KEY'),
    plaidClientId: required(get, 'PLAID_CLIENT_ID'),
    plaidSecret: required(get, 'PLAID_SECRET'),
    plaidEnv,
    plaidWebhookUrl: get('PLAID_WEBHOOK_URL')?.trim() || null,
    plaidRedirectUri: get('PLAID_REDIRECT_URI')?.trim() || null,
    plaidCountryCodes: list(get('PLAID_COUNTRY_CODES')).length ? list(get('PLAID_COUNTRY_CODES')) : ['US'],
    tokenEncryptionKey: required(get, 'PLAID_TOKEN_ENCRYPTION_KEY'),
    cronSecret: get('CRON_SECRET')?.trim() || null,
    allowedOrigins: list(get('ALLOWED_ORIGINS')),
  };
}
