#!/usr/bin/env node
/**
 * Generates a 32-byte AES-256-GCM key (base64) for PLAID_TOKEN_ENCRYPTION_KEY,
 * which encrypts Plaid access tokens at rest.
 *
 * Usage: npm run keygen
 *
 * Store it ONLY in Supabase function secrets (and supabase/functions/.env for
 * local development). Never commit it and never put it in a VITE_ variable.
 */
import { randomBytes } from 'node:crypto';

const key = randomBytes(32).toString('base64');
process.stdout.write(
  [
    '',
    'Add to supabase/functions/.env (local) and set as a function secret (remote):',
    '',
    `PLAID_TOKEN_ENCRYPTION_KEY=${key}`,
    '',
    '  supabase secrets set PLAID_TOKEN_ENCRYPTION_KEY=<value>',
    '',
    'Losing or rotating this key makes stored access tokens unreadable;',
    'affected institutions would need to be reconnected.',
    '',
  ].join('\n'),
);
