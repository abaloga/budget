import {
  accountFromRow,
  connectionFromRow,
  type Account,
  type AccountRow,
  type Connection,
  type ConnectionRow,
} from '@budget/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import { ApiError, unwrap } from './errors.ts';

const ACCOUNT_COLUMNS =
  'id, connection_id, name, display_name, official_name, mask, type, subtype, current_balance_cents, ' +
  'available_balance_cents, credit_limit_cents, iso_currency_code, balance_updated_at, is_hidden, is_active';

export interface SyncOutcome {
  connectionId: string;
  status: 'succeeded' | 'failed' | 'skipped';
  added: number;
  modified: number;
  removed: number;
  errorCode?: string;
}

export function accountsApi(sb: SupabaseClient) {
  return {
    async listConnections(): Promise<Connection[]> {
      const rows = unwrap(
        await sb
          .from('connections')
          .select('id, institution_name, status, status_detail, last_synced_at, created_at')
          .order('institution_name'),
      ) as ConnectionRow[];
      return rows.map(connectionFromRow);
    },

    async listAccounts(): Promise<Account[]> {
      const rows = unwrap(await sb.from('accounts').select(ACCOUNT_COLUMNS).order('name')) as unknown as AccountRow[];
      return rows.map(accountFromRow);
    },

    async updateAccount(id: string, patch: { displayName?: string | null; isHidden?: boolean }): Promise<void> {
      const row: Record<string, unknown> = {};
      if (patch.displayName !== undefined) row.display_name = patch.displayName?.trim() || null;
      if (patch.isHidden !== undefined) row.is_hidden = patch.isHidden;
      unwrap(await sb.from('accounts').update(row).eq('id', id));
    },
  };
}

/**
 * Bank connection operations. These run in the `plaid` edge function — the
 * only place Plaid secrets and access tokens exist.
 */
export function plaidApi(sb: SupabaseClient) {
  async function call<T>(body: Record<string, unknown>): Promise<T> {
    const { data, error } = await sb.functions.invoke('plaid', { body });
    if (error) {
      let message = 'The bank connection service is unavailable.';
      let code = 'function_error';
      const ctx = (error as { context?: unknown }).context;
      if (ctx instanceof Response) {
        try {
          const payload = (await ctx.json()) as { error?: { code?: string; message?: string } };
          message = payload.error?.message ?? message;
          code = payload.error?.code ?? code;
        } catch {
          // keep defaults
        }
      }
      throw new ApiError(message, code, error);
    }
    return data as T;
  }

  return {
    createLinkToken: (connectionId?: string) =>
      call<{ link_token: string; expiration: string }>({ action: 'create_link_token', connection_id: connectionId }),
    exchangePublicToken: (publicToken: string) =>
      call<{ connection_id: string; institution_name: string; sync: SyncOutcome }>({
        action: 'exchange_public_token',
        public_token: publicToken,
      }),
    sync: (connectionId?: string) => call<{ results: SyncOutcome[] }>({ action: 'sync', connection_id: connectionId }),
    disconnect: (connectionId: string, deleteData: boolean) =>
      call<{ ok: true }>({ action: 'disconnect', connection_id: connectionId, delete_data: deleteData }),
    rescan: () => call<{ ok: true }>({ action: 'rescan' }),
  };
}
