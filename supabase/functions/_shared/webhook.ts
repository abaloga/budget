/**
 * Plaid webhook verification (https://plaid.com/docs/api/webhooks/webhook-verification/).
 *
 * The `Plaid-Verification` header is an ES256 JWT whose payload includes the
 * SHA-256 of the raw request body. We fetch the signing key from Plaid by key
 * id, verify the signature and age (<= 5 minutes), then compare body hashes.
 */
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';

import type { PlaidClient } from './plaid.ts';

const keyCache = new Map<string, JWK>();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyPlaidWebhook(
  plaid: Pick<PlaidClient, 'webhookVerificationKeyGet'>,
  token: string | null,
  rawBody: string,
): Promise<boolean> {
  if (!token) return false;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== 'ES256' || !header.kid) return false;

    let jwk = keyCache.get(header.kid);
    if (!jwk) {
      const { key } = await plaid.webhookVerificationKeyGet(header.kid);
      if (key.expired_at) return false;
      jwk = key as JWK;
      keyCache.set(header.kid, jwk);
    }

    const publicKey = await importJWK(jwk, 'ES256');
    const { payload } = await jwtVerify(token, publicKey, { algorithms: ['ES256'], maxTokenAge: '5 min' });
    const expected = String((payload as { request_body_sha256?: string }).request_body_sha256 ?? '');
    const actual = await sha256Hex(rawBody);
    return expected.length === actual.length && expected === actual;
  } catch {
    return false;
  }
}
