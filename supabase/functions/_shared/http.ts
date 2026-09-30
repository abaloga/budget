/**
 * HTTP helpers: JSON responses, CORS, and error mapping that never leaks
 * secrets, tokens or raw provider payloads to the client or the logs.
 */
import { ConfigError } from './env.ts';
import { PlaidApiError } from './plaid.ts';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function corsHeaders(req: Request, allowedOrigins: string[]): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allow = allowedOrigins.length === 0 ? '*' : allowedOrigins.includes(origin) ? origin : allowedOrigins[0]!;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/** Map any thrown error to a safe response. Only codes and generic messages leave the server. */
export function errorResponse(err: unknown, headers: Record<string, string> = {}): Response {
  if (err instanceof HttpError) {
    return json({ error: { code: err.code, message: err.message } }, err.status, headers);
  }
  if (err instanceof PlaidApiError) {
    logError('plaid_error', { code: err.code, type: err.type, requestId: err.requestId });
    const status = err.code === 'ITEM_LOGIN_REQUIRED' ? 409 : 502;
    return json(
      { error: { code: err.code, message: err.displayMessage ?? 'The bank connection returned an error.' } },
      status,
      headers,
    );
  }
  if (err instanceof ConfigError) {
    logError('config_error', { message: err.message });
    return json({ error: { code: 'server_misconfigured', message: 'Server is not configured.' } }, 500, headers);
  }
  logError('unhandled_error', { message: err instanceof Error ? err.message : String(err) });
  return json({ error: { code: 'internal_error', message: 'Something went wrong.' } }, 500, headers);
}

/**
 * Structured logging. Callers pass only non-sensitive fields (ids, codes,
 * counts). Never pass tokens, secrets, request bodies or transaction data.
 */
export function logInfo(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: 'info', event, ...fields }));
}

export function logError(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level: 'error', event, ...fields }));
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    const body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body as T;
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be a JSON object.');
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function optionalUuid(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new HttpError(400, 'invalid_request', `${field} must be a UUID.`);
  }
  return value;
}

export function requireUuid(value: unknown, field: string): string {
  const v = optionalUuid(value, field);
  if (!v) throw new HttpError(400, 'invalid_request', `${field} is required.`);
  return v;
}

export function requireString(value: unknown, field: string, maxLength = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new HttpError(400, 'invalid_request', `${field} is required.`);
  }
  return value;
}

/** Constant-time string comparison for shared secrets. */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
