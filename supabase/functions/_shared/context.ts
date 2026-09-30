import { createTokenCipher } from './crypto.ts';
import { loadConfig, type ServerConfig } from './env.ts';
import { PlaidClient } from './plaid.ts';
import { createServiceClient } from './supabase.ts';
import type { SyncDeps } from './sync.ts';

export interface AppContext extends SyncDeps {
  config: ServerConfig;
}

let cached: Promise<AppContext> | null = null;

/** Build (once per worker) the config, service client, Plaid client and cipher. */
export function getContext(): Promise<AppContext> {
  cached ??= (async () => {
    const config = loadConfig();
    return {
      config,
      db: createServiceClient(config),
      plaid: new PlaidClient({ clientId: config.plaidClientId, secret: config.plaidSecret, env: config.plaidEnv }),
      cipher: await createTokenCipher(config.tokenEncryptionKey),
      today: () => new Date().toISOString().slice(0, 10),
    };
  })().catch((err) => {
    cached = null;
    throw err;
  });
  return cached;
}
