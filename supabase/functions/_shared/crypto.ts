/**
 * AES-256-GCM encryption for provider access tokens at rest (WebCrypto; works
 * in Deno and Node). The connection id is bound as additional authenticated
 * data, so a ciphertext copied onto another connection row fails to decrypt.
 *
 * Format: `v1.<base64 iv>.<base64 ciphertext+tag>`
 */
const VERSION = 'v1';

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const s = atob(value);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export interface TokenCipher {
  encrypt(plaintext: string, context: string): Promise<string>;
  decrypt(payload: string, context: string): Promise<string>;
}

export async function createTokenCipher(base64Key: string): Promise<TokenCipher> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64(base64Key);
  } catch {
    throw new Error('Encryption key must be base64');
  }
  if (raw.length !== 32) throw new Error('Encryption key must be 32 bytes (AES-256)');
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  return {
    async encrypt(plaintext, context) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: enc.encode(context) },
        key,
        enc.encode(plaintext),
      );
      return `${VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(ct))}`;
    },
    async decrypt(payload, context) {
      const [version, iv, ct] = payload.split('.');
      if (version !== VERSION || !iv || !ct) throw new Error('Unsupported token format');
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(iv), additionalData: enc.encode(context) },
        key,
        fromBase64(ct),
      );
      return dec.decode(pt);
    },
  };
}
