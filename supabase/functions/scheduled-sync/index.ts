/**
 * Periodic safety-net sync for every active connection (webhooks can be missed,
 * and they never reach a local dev machine). Invoked by pg_cron + pg_net — see
 * supabase/scheduler/schedule-sync.sql. Deployed with verify_jwt = false and
 * authenticated by the CRON_SECRET header instead.
 */
import { getContext } from '../_shared/context.ts';
import { unwrap } from '../_shared/db.ts';
import { errorResponse, json, logInfo, safeEqual } from '../_shared/http.ts';
import { syncConnection, type SyncResult } from '../_shared/sync.ts';

/** Skip connections synced more recently than this. */
const MIN_AGE_MS = 4 * 60 * 60 * 1000;
/** Stay well inside the edge function wall-clock limit. */
const TIME_BUDGET_MS = 100_000;

Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const ctx = await getContext();
    const provided = req.headers.get('x-cron-secret') ?? '';
    if (!ctx.config.cronSecret || !safeEqual(provided, ctx.config.cronSecret)) {
      return json({ error: 'unauthorized' }, 401);
    }

    const cutoff = new Date(Date.now() - MIN_AGE_MS).toISOString();
    const due = unwrap(
      await ctx.db
        .from('connections')
        .select('id')
        .in('status', ['active', 'pending_expiration', 'error'])
        .or(`last_synced_at.is.null,last_synced_at.lt.${cutoff}`)
        .order('last_synced_at', { ascending: true, nullsFirst: true })
        .limit(50),
      'list due connections',
    ) as { id: string }[];

    const started = Date.now();
    const results: SyncResult[] = [];
    for (const { id } of due) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      results.push(await syncConnection(ctx, id, 'scheduled'));
    }

    const summary = {
      due: due.length,
      attempted: results.length,
      succeeded: results.filter((r) => r.status === 'succeeded').length,
      failed: results.filter((r) => r.status === 'failed').length,
    };
    logInfo('scheduled_sync', summary);
    return json(summary);
  } catch (err) {
    return errorResponse(err);
  }
});
