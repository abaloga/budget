/**
 * Supabase clients for edge functions.
 *
 * The service-role client bypasses RLS, so every code path that acts on behalf
 * of a user must first authenticate the caller (requireUser) and then scope
 * every query by that user's id.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { ServerConfig } from './env.ts';
import { HttpError } from './http.ts';

export type ServiceClient = SupabaseClient;

export function createServiceClient(config: ServerConfig): ServiceClient {
  return createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Validate the caller's Supabase access token and return their user id. */
export async function requireUser(req: Request, db: ServiceClient): Promise<string> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'unauthorized', 'Sign in required.');
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'unauthorized', 'Sign in required.');
  return data.user.id;
}

/** Throw a 404 unless the connection exists and belongs to the user. */
export async function requireOwnedConnection(
  db: ServiceClient,
  userId: string,
  connectionId: string,
): Promise<{ id: string; status: string; provider_item_id: string }> {
  const { data, error } = await db
    .from('connections')
    .select('id, status, provider_item_id')
    .eq('id', connectionId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'not_found', 'Connection not found.');
  return data;
}

/** Throw when a PostgREST call failed. */
export function check<T>(result: { data: T; error: { message: string; code?: string } | null }): T {
  if (result.error) throw new Error(`Database error ${result.error.code ?? ''}: ${result.error.message}`);
  return result.data;
}
