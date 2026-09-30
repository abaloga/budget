/**
 * Minimal ambient declarations so `tsc -p supabase/functions` can typecheck the
 * edge functions from Node tooling. At runtime these come from Deno and the
 * Supabase Edge Runtime.
 */
declare namespace Deno {
  interface Env {
    get(key: string): string | undefined;
  }
  const env: Env;
  function serve(handler: (req: Request) => Response | Promise<Response>): unknown;
}
