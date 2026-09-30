/**
 * Receives Plaid webhooks. Deployed with verify_jwt = false (Plaid can't send a
 * Supabase JWT); authenticity comes from Plaid's signed verification header.
 *
 * Handled:
 *   TRANSACTIONS / SYNC_UPDATES_AVAILABLE  -> sync the Item (in the background)
 *   ITEM / ERROR                           -> mark login_required / error
 *   ITEM / PENDING_EXPIRATION|PENDING_DISCONNECT -> warn the user to re-auth
 *   ITEM / LOGIN_REPAIRED                  -> back to active, sync
 *   ITEM / USER_PERMISSION_REVOKED|USER_ACCOUNT_REVOKED -> error
 */
import { getContext } from '../_shared/context.ts';
import { errorResponse, json, logInfo } from '../_shared/http.ts';
import { runInBackground } from '../_shared/runtime.ts';
import { connectionStatusForError, syncConnection } from '../_shared/sync.ts';
import { verifyPlaidWebhook } from '../_shared/webhook.ts';

interface WebhookBody {
  webhook_type?: string;
  webhook_code?: string;
  item_id?: string;
  error?: { error_code?: string } | null;
}

Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const ctx = await getContext();

    const raw = await req.text();
    const verified = await verifyPlaidWebhook(ctx.plaid, req.headers.get('plaid-verification'), raw);
    if (!verified) return json({ error: 'invalid_signature' }, 401);

    let body: WebhookBody;
    try {
      body = JSON.parse(raw) as WebhookBody;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const { webhook_type: type, webhook_code: code, item_id: itemId } = body;
    logInfo('plaid_webhook', { type, code });
    if (!itemId) return json({ ok: true });

    const { data: connection } = await ctx.db
      .from('connections')
      .select('id, status')
      .eq('provider', 'plaid')
      .eq('provider_item_id', itemId)
      .maybeSingle();
    if (!connection || connection.status === 'disconnected') return json({ ok: true });

    const setStatus = (status: string, detail: string | null) =>
      ctx.db.from('connections').update({ status, status_detail: detail }).eq('id', connection.id);

    if (
      type === 'TRANSACTIONS' &&
      (code === 'SYNC_UPDATES_AVAILABLE' ||
        code === 'DEFAULT_UPDATE' ||
        code === 'INITIAL_UPDATE' ||
        code === 'HISTORICAL_UPDATE')
    ) {
      // Respond immediately; Plaid retries slow webhooks.
      runInBackground(syncConnection(ctx, connection.id, 'webhook'));
    } else if (type === 'ITEM') {
      if (code === 'ERROR') {
        const errorCode = body.error?.error_code ?? 'ITEM_ERROR';
        await setStatus(connectionStatusForError(errorCode) ?? 'error', errorCode);
      } else if (code === 'PENDING_EXPIRATION' || code === 'PENDING_DISCONNECT') {
        await setStatus('pending_expiration', code);
      } else if (code === 'USER_PERMISSION_REVOKED' || code === 'USER_ACCOUNT_REVOKED') {
        await setStatus('error', code);
      } else if (code === 'LOGIN_REPAIRED') {
        await setStatus('active', null);
        runInBackground(syncConnection(ctx, connection.id, 'webhook'));
      }
    }

    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
});
