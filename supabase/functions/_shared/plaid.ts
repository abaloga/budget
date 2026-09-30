/**
 * Minimal Plaid HTTP client (fetch-based; the official SDK is axios-based and
 * heavy under Deno). Only the endpoints this app uses.
 *
 * Secrets are sent in request bodies to Plaid only. Errors expose Plaid's
 * error code/type/request id — never the request payload.
 */
import type { PlaidAccount, PlaidRemovedTransaction, PlaidTransaction } from './core/index.ts';
import type { PlaidEnvironment } from './env.ts';

const BASE_URLS: Record<PlaidEnvironment, string> = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

export class PlaidApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly code: string,
    readonly requestId: string | null,
    readonly displayMessage: string | null,
  ) {
    super(`Plaid ${type}/${code}`);
  }
}

export interface PlaidClientConfig {
  clientId: string;
  secret: string;
  env: PlaidEnvironment;
  fetch?: typeof fetch;
}

export interface TransactionsSyncResponse {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: PlaidRemovedTransaction[];
  next_cursor: string;
  has_more: boolean;
  transactions_update_status?: string;
}

export interface LinkTokenOptions {
  clientUserId: string;
  countryCodes: string[];
  webhook?: string | null;
  redirectUri?: string | null;
  /** Update mode (re-authenticate an existing Item). */
  accessToken?: string | null;
}

export class PlaidClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: PlaidClientConfig) {
    this.baseUrl = BASE_URLS[config.env];
    this.fetchImpl = config.fetch ?? fetch;
  }

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Plaid-Version': '2020-09-14' },
      body: JSON.stringify({ client_id: this.config.clientId, secret: this.config.secret, ...body }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new PlaidApiError(
        res.status,
        String(data.error_type ?? 'API_ERROR'),
        String(data.error_code ?? 'UNKNOWN'),
        (data.request_id as string | undefined) ?? null,
        (data.display_message as string | null | undefined) ?? null,
      );
    }
    return data as T;
  }

  linkTokenCreate(opts: LinkTokenOptions) {
    const body: Record<string, unknown> = {
      client_name: 'Budget',
      language: 'en',
      country_codes: opts.countryCodes,
      user: { client_user_id: opts.clientUserId },
    };
    if (opts.accessToken) {
      body.access_token = opts.accessToken;
    } else {
      body.products = ['transactions'];
      body.transactions = { days_requested: 730 };
    }
    if (opts.webhook) body.webhook = opts.webhook;
    if (opts.redirectUri) body.redirect_uri = opts.redirectUri;
    return this.call<{ link_token: string; expiration: string }>('/link/token/create', body);
  }

  exchangePublicToken(publicToken: string) {
    return this.call<{ access_token: string; item_id: string }>('/item/public_token/exchange', {
      public_token: publicToken,
    });
  }

  accountsGet(accessToken: string) {
    return this.call<{
      accounts: PlaidAccount[];
      item: { item_id: string; institution_id: string | null; consent_expiration_time?: string | null };
    }>('/accounts/get', { access_token: accessToken });
  }

  institutionGetById(institutionId: string, countryCodes: string[]) {
    return this.call<{ institution: { institution_id: string; name: string } }>('/institutions/get_by_id', {
      institution_id: institutionId,
      country_codes: countryCodes,
    });
  }

  transactionsSync(accessToken: string, cursor: string | null, count = 500) {
    const body: Record<string, unknown> = {
      access_token: accessToken,
      count,
      options: { include_personal_finance_category: true },
    };
    if (cursor) body.cursor = cursor;
    return this.call<TransactionsSyncResponse>('/transactions/sync', body);
  }

  itemRemove(accessToken: string) {
    return this.call<{ request_id: string }>('/item/remove', { access_token: accessToken });
  }

  webhookVerificationKeyGet(keyId: string) {
    return this.call<{ key: Record<string, unknown> & { expired_at: number | null } }>(
      '/webhook_verification_key/get',
      { key_id: keyId },
    );
  }
}
