/**
 * Run work after the response is sent. Uses the Supabase Edge Runtime's
 * `EdgeRuntime.waitUntil` when available so the worker isn't shut down early.
 */
type EdgeRuntimeGlobal = { waitUntil(promise: Promise<unknown>): void };

export function runInBackground(promise: Promise<unknown>): void {
  const runtime = (globalThis as { EdgeRuntime?: EdgeRuntimeGlobal }).EdgeRuntime;
  const guarded = promise.catch(() => undefined);
  if (runtime) runtime.waitUntil(guarded);
}
