import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts', 'supabase/functions/**/*.test.ts'],
    environment: 'node',
    // PGlite boots a full Postgres per suite; give it room on slower machines.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
