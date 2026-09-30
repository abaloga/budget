# Project notes for Claude Code

Personal budgeting app. Read `docs/ARCHITECTURE.md` before structural changes.

## Rules

- **Business logic goes in `packages/core`** (pure TS, zero deps, `.ts` import extensions, no React/DOM/Node/Deno/Supabase). Components only render and call hooks.
- After editing `packages/core/src`, run `npm run core:sync` (edge functions use a committed copy; CI fails on drift).
- Money is integer cents; amounts are signed from the user's view (+ in, − out). Dates are `YYYY-MM-DD` strings.
- Reports/budgets aggregate `transaction_lines` (splits replace their parent). Transfers never count as income or spending.
- Never let automation overwrite `category_source = 'user'` / `kind_source = 'user'`.
- Sync never writes user-owned columns on existing rows; keep it idempotent (see `apply_transaction_sync`).
- Schema changes = new migration in `supabase/migrations` with RLS + explicit grants; add a test in `tests/db`.
- Secrets only in edge-function env. Never log tokens, secrets or transaction data.
- Charts: follow the conventions in `apps/web/src/components/charts/charts.tsx`.

## Commands

`npm run verify` (everything CI runs) · `npm test` · `npm run dev` · `npm run build`
