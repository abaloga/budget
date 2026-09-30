import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { createTokenCipher } from './crypto.ts';
import { loadConfig } from './env.ts';
import { safeEqual } from './http.ts';
import { PlaidApiError, type PlaidClient, type TransactionsSyncResponse } from './plaid.ts';
import { connectionStatusForError, fetchAllChanges } from './sync.ts';
import { verifyPlaidWebhook } from './webhook.ts';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i)));

describe('token encryption', () => {
  it('round-trips and never stores plaintext', async () => {
    const cipher = await createTokenCipher(KEY);
    const token = 'access-sandbox-1234-secret';
    const sealed = await cipher.encrypt(token, 'conn-1');
    expect(sealed).not.toContain(token);
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(await cipher.decrypt(sealed, 'conn-1')).toBe(token);
  });

  it('uses a fresh IV per encryption', async () => {
    const cipher = await createTokenCipher(KEY);
    expect(await cipher.encrypt('same', 'c')).not.toBe(await cipher.encrypt('same', 'c'));
  });

  it('binds ciphertext to its connection', async () => {
    const cipher = await createTokenCipher(KEY);
    const sealed = await cipher.encrypt('secret', 'conn-1');
    await expect(cipher.decrypt(sealed, 'conn-2')).rejects.toThrow();
  });

  it('rejects tampering and wrong keys', async () => {
    const cipher = await createTokenCipher(KEY);
    const sealed = await cipher.encrypt('secret', 'c');
    const [v, iv, ct] = sealed.split('.');
    const flipped = ct!.slice(0, -2) + (ct!.slice(-2) === 'AA' ? 'AB' : 'AA');
    await expect(cipher.decrypt(`${v}.${iv}.${flipped}`, 'c')).rejects.toThrow();

    const other = await createTokenCipher(btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
    await expect(other.decrypt(sealed, 'c')).rejects.toThrow();
  });

  it('requires a 32-byte key', async () => {
    await expect(createTokenCipher(btoa('short'))).rejects.toThrow(/32 bytes/);
  });
});

describe('config', () => {
  const base: Record<string, string> = {
    SUPABASE_URL: 'http://localhost',
    SUPABASE_SERVICE_ROLE_KEY: 'srk',
    PLAID_CLIENT_ID: 'id',
    PLAID_SECRET: 'secret',
    PLAID_TOKEN_ENCRYPTION_KEY: KEY,
  };

  it('defaults to sandbox and US', () => {
    const c = loadConfig((k) => base[k]);
    expect(c.plaidEnv).toBe('sandbox');
    expect(c.plaidCountryCodes).toEqual(['US']);
  });

  it('rejects unknown Plaid environments and missing secrets', () => {
    expect(() => loadConfig((k) => ({ ...base, PLAID_ENV: 'development' })[k])).toThrow(/PLAID_ENV/);
    expect(() => loadConfig((k) => ({ ...base, PLAID_SECRET: '' })[k])).toThrow(/PLAID_SECRET/);
  });
});

describe('webhook verification', () => {
  async function setup() {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'kid-1', alg: 'ES256', expired_at: null };
    const plaid = { webhookVerificationKeyGet: async () => ({ key: jwk }) } as unknown as PlaidClient;
    const sign = async (body: string, iat?: number) => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      return new SignJWT({ request_body_sha256: hash })
        .setProtectedHeader({ alg: 'ES256', kid: 'kid-1', typ: 'JWT' })
        .setIssuedAt(iat)
        .sign(privateKey);
    };
    return { plaid, sign };
  }

  it('accepts a correctly signed, fresh webhook', async () => {
    const { plaid, sign } = await setup();
    const body = JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'i' });
    expect(await verifyPlaidWebhook(plaid, await sign(body), body)).toBe(true);
  });

  it('rejects a modified body, stale token, or missing header', async () => {
    const { plaid, sign } = await setup();
    const body = '{"item_id":"a"}';
    expect(await verifyPlaidWebhook(plaid, await sign(body), '{"item_id":"b"}')).toBe(false);
    expect(await verifyPlaidWebhook(plaid, await sign(body, Math.floor(Date.now() / 1000) - 600), body)).toBe(false);
    expect(await verifyPlaidWebhook(plaid, null, body)).toBe(false);
    expect(await verifyPlaidWebhook(plaid, 'not-a-jwt', body)).toBe(false);
  });
});

describe('fetchAllChanges', () => {
  const page = (overrides: Partial<TransactionsSyncResponse>): TransactionsSyncResponse => ({
    added: [],
    modified: [],
    removed: [],
    next_cursor: 'c',
    has_more: false,
    ...overrides,
  });
  const tx = (id: string) =>
    ({ transaction_id: id, account_id: 'a', amount: 1, date: '2026-09-01', name: id, pending: false }) as never;

  it('accumulates every page before returning the final cursor', async () => {
    const pages = [
      page({ added: [tx('1')], next_cursor: 'c1', has_more: true }),
      page({ added: [tx('2')], removed: [{ transaction_id: 'old' }], next_cursor: 'c2' }),
    ];
    const cursors: (string | null)[] = [];
    const plaid = {
      transactionsSync: async (_t: string, cursor: string | null) => {
        cursors.push(cursor);
        return pages.shift()!;
      },
    } as unknown as PlaidClient;
    const res = await fetchAllChanges(plaid, 'token', null);
    expect(res.added.map((t) => t.transaction_id)).toEqual(['1', '2']);
    expect(res.removedIds).toEqual(['old']);
    expect(res.nextCursor).toBe('c2');
    expect(cursors).toEqual([null, 'c1']);
  });

  it('restarts from the original cursor when data changes mid-pagination', async () => {
    const cursors: (string | null)[] = [];
    let call = 0;
    const plaid = {
      transactionsSync: async (_t: string, cursor: string | null) => {
        cursors.push(cursor);
        call++;
        if (call === 1) return page({ added: [tx('dup')], next_cursor: 'p1', has_more: true });
        if (call === 2)
          throw new PlaidApiError(
            400,
            'TRANSACTIONS_ERROR',
            'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
            null,
            null,
          );
        return page({ added: [tx('dup')], next_cursor: 'final' });
      },
    } as unknown as PlaidClient;
    const res = await fetchAllChanges(plaid, 'token', 'start');
    expect(cursors).toEqual(['start', 'p1', 'start']);
    // The partial first attempt is discarded, so nothing is duplicated.
    expect(res.added).toHaveLength(1);
    expect(res.nextCursor).toBe('final');
  });
});

describe('misc', () => {
  it('maps Plaid item errors to connection statuses', () => {
    expect(connectionStatusForError('ITEM_LOGIN_REQUIRED')).toBe('login_required');
    expect(connectionStatusForError('PENDING_EXPIRATION')).toBe('pending_expiration');
    expect(connectionStatusForError('RATE_LIMIT_EXCEEDED')).toBeNull();
  });

  it('compares secrets safely', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
