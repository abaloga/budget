/**
 * Authenticated Plaid operations for the signed-in user.
 *
 * POST { action: 'create_link_token', connection_id?: uuid }   (connection_id => update/re-auth mode)
 * POST { action: 'exchange_public_token', public_token: string }
 * POST { action: 'sync', connection_id?: uuid }                (omit to sync all of the user's connections)
 * POST { action: 'disconnect', connection_id: uuid, delete_data?: boolean }
 * POST { action: 'rescan' }                                    (re-run transfer + recurring detection)
 *
 * Every action authenticates the caller and scopes all reads/writes to them.
 */
import { getContext, type AppContext } from '../_shared/context.ts';
import { unwrap } from '../_shared/db.ts';
import {
  HttpError,
  corsHeaders,
  errorResponse,
  json,
  logInfo,
  optionalUuid,
  readJson,
  requireString,
  requireUuid,
} from '../_shared/http.ts';
import { PlaidApiError } from '../_shared/plaid.ts';
import { requireOwnedConnection, requireUser } from '../_shared/supabase.ts';
import { getAccessToken, runPostSync, syncConnection, upsertAccounts, type SyncResult } from '../_shared/sync.ts';

type Body = Record<string, unknown>;

async function createLinkToken(ctx: AppContext, userId: string, body: Body) {
  const connectionId = optionalUuid(body.connection_id, 'connection_id');
  let accessToken: string | null = null;
  if (connectionId) {
    await requireOwnedConnection(ctx.db, userId, connectionId);
    accessToken = await getAccessToken(ctx, connectionId);
  }
  const res = await ctx.plaid.linkTokenCreate({
    clientUserId: userId,
    countryCodes: ctx.config.plaidCountryCodes,
    webhook: ctx.config.plaidWebhookUrl,
    redirectUri: ctx.config.plaidRedirectUri,
    accessToken,
  });
  return { link_token: res.link_token, expiration: res.expiration };
}

async function exchangePublicToken(ctx: AppContext, userId: string, body: Body) {
  const publicToken = requireString(body.public_token, 'public_token');
  const { access_token: accessToken, item_id: itemId } = await ctx.plaid.exchangePublicToken(publicToken);

  const { accounts, item } = await ctx.plaid.accountsGet(accessToken);

  // Prevent duplicate connections to the same institution/accounts.
  if (item.institution_id) {
    const existing = unwrap(
      await ctx.db
        .from('connections')
        .select('id, accounts(mask, name)')
        .eq('user_id', userId)
        .eq('institution_provider_id', item.institution_id)
        .neq('status', 'disconnected'),
      'check duplicate connection',
    ) as { id: string; accounts: { mask: string | null; name: string }[] }[];
    const known = new Set(existing.flatMap((c) => c.accounts.map((a) => `${a.mask}|${a.name}`)));
    if (accounts.some((a) => known.has(`${a.mask}|${a.name}`))) {
      await ctx.plaid.itemRemove(accessToken).catch(() => undefined);
      throw new HttpError(409, 'already_connected', 'These accounts are already connected.');
    }
  }

  let institutionName = 'Unknown institution';
  if (item.institution_id) {
    try {
      institutionName = (await ctx.plaid.institutionGetById(item.institution_id, ctx.config.plaidCountryCodes))
        .institution.name;
    } catch {
      // Non-fatal: keep the placeholder name.
    }
  }

  const connection = unwrap(
    await ctx.db
      .from('connections')
      .insert({
        user_id: userId,
        provider: 'plaid',
        provider_item_id: itemId,
        institution_provider_id: item.institution_id,
        institution_name: institutionName,
        consent_expires_at: item.consent_expiration_time ?? null,
      })
      .select('id')
      .single(),
    'create connection',
  ) as { id: string };

  try {
    const ciphertext = await ctx.cipher.encrypt(accessToken, connection.id);
    unwrap(
      await ctx.db
        .from('connection_secrets')
        .insert({ connection_id: connection.id, user_id: userId, access_token_ciphertext: ciphertext }),
      'store access token',
    );
    await upsertAccounts(ctx.db, userId, connection.id, accounts);
  } catch (err) {
    // Roll back so we never keep a connection we can't use.
    await ctx.db.from('connections').delete().eq('id', connection.id);
    await ctx.plaid.itemRemove(accessToken).catch(() => undefined);
    throw err;
  }

  logInfo('connection_created', { connectionId: connection.id, accounts: accounts.length });

  // Initial import. Plaid may still be preparing history; the
  // SYNC_UPDATES_AVAILABLE webhook (or the scheduled sync) picks up the rest.
  const sync = await syncConnection(ctx, connection.id, 'initial');
  return { connection_id: connection.id, institution_name: institutionName, sync };
}

async function sync(ctx: AppContext, userId: string, body: Body) {
  const connectionId = optionalUuid(body.connection_id, 'connection_id');
  let ids: string[];
  if (connectionId) {
    await requireOwnedConnection(ctx.db, userId, connectionId);
    ids = [connectionId];
  } else {
    const rows = unwrap(
      await ctx.db.from('connections').select('id').eq('user_id', userId).neq('status', 'disconnected'),
      'list connections',
    ) as { id: string }[];
    ids = rows.map((r) => r.id);
  }
  const results: SyncResult[] = [];
  for (const id of ids) results.push(await syncConnection(ctx, id, 'manual'));
  return { results };
}

async function disconnect(ctx: AppContext, userId: string, body: Body) {
  const connectionId = requireUuid(body.connection_id, 'connection_id');
  const deleteData = body.delete_data === true;
  await requireOwnedConnection(ctx.db, userId, connectionId);

  try {
    const accessToken = await getAccessToken(ctx, connectionId);
    await ctx.plaid.itemRemove(accessToken);
  } catch (err) {
    // Already gone at Plaid (or token missing) — still disconnect locally.
    if (!(err instanceof PlaidApiError) && !(err instanceof Error && /load access token/.test(err.message))) throw err;
  }

  unwrap(await ctx.db.from('connection_secrets').delete().eq('connection_id', connectionId), 'delete access token');

  if (deleteData) {
    // Cascades to accounts, their transactions, splits and sync history.
    unwrap(await ctx.db.from('connections').delete().eq('id', connectionId).eq('user_id', userId), 'delete connection');
  } else {
    // Keep history for reports; stop syncing.
    unwrap(
      await ctx.db
        .from('connections')
        .update({ status: 'disconnected', status_detail: null, transactions_cursor: null, sync_lease_until: null })
        .eq('id', connectionId)
        .eq('user_id', userId),
      'mark disconnected',
    );
    unwrap(
      await ctx.db
        .from('accounts')
        .update({ is_active: false })
        .eq('connection_id', connectionId)
        .eq('user_id', userId),
      'deactivate accounts',
    );
  }
  logInfo('connection_disconnected', { connectionId, deleteData });
  return { ok: true };
}

async function rescan(ctx: AppContext, userId: string) {
  await runPostSync(ctx, userId, '1970-01-01');
  return { ok: true };
}

Deno.serve(async (req) => {
  let cors: Record<string, string> = { 'Access-Control-Allow-Origin': '*' };
  try {
    const ctx = await getContext();
    cors = corsHeaders(req, ctx.config.allowedOrigins);
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST.');

    const userId = await requireUser(req, ctx.db);
    const body = await readJson<Body>(req);

    switch (body.action) {
      case 'create_link_token':
        return json(await createLinkToken(ctx, userId, body), 200, cors);
      case 'exchange_public_token':
        return json(await exchangePublicToken(ctx, userId, body), 200, cors);
      case 'sync':
        return json(await sync(ctx, userId, body), 200, cors);
      case 'disconnect':
        return json(await disconnect(ctx, userId, body), 200, cors);
      case 'rescan':
        return json(await rescan(ctx, userId), 200, cors);
      default:
        throw new HttpError(400, 'unknown_action', 'Unknown action.');
    }
  } catch (err) {
    return errorResponse(err, cors);
  }
});
