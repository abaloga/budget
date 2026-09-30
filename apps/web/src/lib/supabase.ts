import { createBudgetApi } from '@budget/api';
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isConfigured = Boolean(url && anonKey);

/**
 * Browser Supabase client. Only the public URL + anon key live here; RLS
 * restricts what the signed-in user can reach. Secrets stay in edge functions.
 */
export const supabase = createClient(url ?? 'http://localhost:54321', anonKey ?? 'missing-anon-key', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

export const api = createBudgetApi(supabase);
