# Budget

A personal finance app: import bank and credit-card transactions automatically, see where your money goes, budget by category, track upcoming bills and savings goals, and review trends.

**Stack:** React + Vite + TypeScript · Supabase (Postgres, Auth, Row Level Security, Edge Functions) · Plaid · TanStack Query · Tailwind CSS v4 · Recharts · Vitest

> Architecture details, the database design and the decision record are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), which also covers what the future Expo/iOS app can reuse.

## Features

| Area                    | What it does                                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Accounts**            | Connect banks and cards via Plaid. See balances grouped by institution, with sync status. Sync now, reconnect (update mode), disconnect (keep or delete history), rename, hide.                                                        |
| **Sync**                | Idempotent `/transactions/sync` with cursors. Pending→posted keeps your edits. No duplicates. Webhook-driven, plus a 6-hourly safety-net cron.                                                                                         |
| **Transactions**        | One feed across accounts. Search, combinable filters (category incl. splits, account, date, amount, pending/posted, type), sorting, manual add/edit/delete, notes.                                                                     |
| **Categories**          | Sensible two-level defaults. Create, rename, reorder, archive (delete only if unused).                                                                                                                                                 |
| **Auto-categorization** | Your rules first, then your past choices for the merchant, then Plaid's category. Rules: name contains/equals/starts with, account, direction, amount range. They can be applied retroactively and never override your manual choices. |
| **Splits**              | Divide a transaction across categories. Parts must sum exactly; reports use the parts, never the parent.                                                                                                                               |
| **Transfers**           | Detected automatically between your accounts and linked in pairs. Can be marked or unmarked manually. Never counted as income, spending or budget use. Card payments are transfers.                                                    |
| **Budget**              | Monthly amount per category: budget, spent, remaining, % used. Optional per-category rollover (unused and overspent amounts both carry). Warnings at 85% and when over, for categories and the whole month.                            |
| **Recurring**           | Automatic detection (weekly … yearly, with amount ranges), manual marking, edit, ignore. Upcoming bills, with due-soon and overdue flags.                                                                                              |
| **Goals**               | Target, current (manual or a linked savings account), optional date, progress, and the monthly amount needed.                                                                                                                          |
| **Reports**             | Spending by category and merchant, monthly spending and income, income by source, cash flow, budget vs actual, trends. Every chart has a table view.                                                                                   |
| **Dashboard**           | This month's spending, income, remaining budget and net cash flow; top categories; cash-flow chart; upcoming bills; goals; balances; recent transactions.                                                                              |

Deliberately out of scope: net worth, investments, YNAB-style credit-card budgeting, notifications, receipts, sharing, tax, business features.

## Repository layout

```
apps/web/              React + Vite frontend (UI only)
packages/core/         Business logic shared by web, the future iOS app and edge functions (no dependencies)
packages/api/          Typed Supabase data access (client is injected: web and React Native)
supabase/migrations/   Database schema, RLS policies, RPCs
supabase/functions/    Edge functions: plaid, plaid-webhook, scheduled-sync (+ _shared)
supabase/scheduler/    One-time SQL to schedule the periodic sync
tests/db/              Schema/RLS/RPC tests on real Postgres (PGlite, no Docker needed)
docs/ARCHITECTURE.md   Architecture, database design, decisions, React Native notes
```

## Local setup

**Prerequisites:** Node 20.19+ (22 recommended), Docker (for the local Supabase stack), and a [Plaid](https://dashboard.plaid.com/signup) account (Sandbox keys are free).

```bash
npm install

# 1. Start local Supabase (Postgres, Auth, Studio). Applies all migrations.
npx supabase start          # prints the API URL and anon key

# 2. Frontend env (public values only)
cp apps/web/.env.example apps/web/.env.local
#    set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from the output above

# 3. Edge function secrets (server-only)
cp supabase/functions/.env.example supabase/functions/.env
npm run keygen              # paste the key into PLAID_TOKEN_ENCRYPTION_KEY
#    add PLAID_CLIENT_ID and PLAID_SECRET (Sandbox), and any CRON_SECRET

# 4. Run the edge functions (separate terminal)
npm run functions:serve

# 5. Run the app
npm run dev                 # http://localhost:5173
```

Create an account on the sign-in screen (local email confirmation is off). Then go to **Accounts → Connect account** and use Plaid's Sandbox credentials:

- `user_good` / `pass_good`: basic accounts and transactions
- `user_transactions_dynamic` / any password: realistic, changing transactions (good for testing pending→posted)

Webhooks can't reach `localhost`, so press **Sync now** after connecting. Studio is at http://127.0.0.1:54323.

## Environment variables

**Frontend** (`apps/web/.env.local`). These ship in the JS bundle, so they must be public:

| Variable                 | Description                                       |
| ------------------------ | ------------------------------------------------- |
| `VITE_SUPABASE_URL`      | Supabase project URL                              |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon/publishable key (RLS protects data) |

**Edge functions** (`supabase/functions/.env` locally; `npx supabase secrets set …` remotely). These are server-only:

| Variable                     | Description                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `PLAID_CLIENT_ID`            | Plaid client id                                                                        |
| `PLAID_SECRET`               | Plaid secret for the chosen environment                                                |
| `PLAID_ENV`                  | `sandbox` (default) or `production`                                                    |
| `PLAID_COUNTRY_CODES`        | Comma-separated, default `US`                                                          |
| `PLAID_WEBHOOK_URL`          | `https://<ref>.supabase.co/functions/v1/plaid-webhook` (empty locally)                 |
| `PLAID_REDIRECT_URI`         | For OAuth institutions: `https://<your-app>/plaid/oauth` (must be registered in Plaid) |
| `PLAID_TOKEN_ENCRYPTION_KEY` | 32-byte base64 key from `npm run keygen`. Losing it means reconnecting institutions.   |
| `CRON_SECRET`                | Shared secret the scheduler sends to `scheduled-sync`                                  |
| `ALLOWED_ORIGINS`            | Comma-separated browser origins allowed to call functions (empty = any)                |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically into edge functions. **Never** put the service-role key, the Plaid secret or the encryption key in a `VITE_` variable.

## Supabase setup (hosted)

1. Create a project, then link and push the schema:
   ```bash
   npx supabase login
   npx supabase link --project-ref <ref>
   npx supabase db push
   ```
2. **Auth** (Dashboard → Authentication → URL Configuration): set the Site URL to your deployed app and add it to the redirect URLs.
3. Create your account in the app. **Then turn off sign-ups** (Authentication → Sign In / Providers → _Allow new users to sign up_). This is a single-user app; RLS isolates data regardless, but there's no reason to allow strangers to register.
4. Set the function secrets and deploy the functions:
   ```bash
   npx supabase secrets set PLAID_CLIENT_ID=… PLAID_SECRET=… PLAID_ENV=sandbox \
     PLAID_TOKEN_ENCRYPTION_KEY=… CRON_SECRET=… ALLOWED_ORIGINS=https://your-app.example.com \
     PLAID_WEBHOOK_URL=https://<ref>.supabase.co/functions/v1/plaid-webhook
   npm run functions:deploy
   ```
5. Schedule the safety-net sync: edit the two placeholders in [`supabase/scheduler/schedule-sync.sql`](supabase/scheduler/schedule-sync.sql) and run it once in the SQL editor. It stores the secrets in Vault, not in the job text.

## Plaid setup

1. In the Plaid dashboard, copy the **Sandbox** client id and secret.
2. Under **Link → Customization**, set an app name if you like. Under **API → Allowed redirect URIs**, add `https://<your-app>/plaid/oauth`, which OAuth banks need in production.
3. Everything works in Sandbox, including webhooks once deployed (`PLAID_WEBHOOK_URL`).
4. **Moving to production** (only after everything works in Sandbox): get production access, set `PLAID_ENV=production` and the production `PLAID_SECRET`, and set `PLAID_REDIRECT_URI`. Sandbox access tokens don't work in production, so disconnect Sandbox institutions (choose _Delete accounts and transactions_) and reconnect real ones.

## Development commands

| Command                    | What it does                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `npm run dev`              | Web app at http://localhost:5173                                                          |
| `npm run build`            | Typecheck + production build → `apps/web/dist`                                            |
| `npm test`                 | All tests: business logic, edge-function helpers, and SQL (migrations/RLS/RPCs on PGlite) |
| `npm run typecheck`        | TypeScript for core, api, web and edge functions                                          |
| `npm run lint`             | ESLint (includes platform-purity rules for `packages/core`)                               |
| `npm run format`           | Prettier, then re-sync the core copy                                                      |
| `npm run verify`           | Everything CI runs                                                                        |
| `npm run core:sync`        | Copy `packages/core/src` → `supabase/functions/_shared/core` (**run after editing core**) |
| `npm run functions:serve`  | Local edge functions with `supabase/functions/.env`                                       |
| `npm run functions:deploy` | Deploy edge functions (checks the core copy first)                                        |
| `npm run db:reset`         | Recreate the local database from migrations                                               |
| `npm run db:push`          | Apply migrations to the linked hosted project                                             |
| `npm run keygen`           | Generate `PLAID_TOKEN_ENCRYPTION_KEY`                                                     |

### Testing

Financial logic is tested directly, without the UI:

- `packages/core/test`: budgets, rollovers (unused and overspent), warnings, splits and rebalancing, transfer detection and card payments, income and cash flow, categorization precedence and rules, retroactive rules, recurring detection and dates, goals, reports, filters, Plaid mapping, and the sync planner (dedupe, pending→posted, replays).
- `tests/db`: the real migrations run in PGlite (Postgres compiled to WASM) with Supabase's `auth` schema and roles stubbed. These tests cover RLS isolation, ownership foreign keys, provider-data write guards, split-total enforcement, idempotent sync apply, pending→posted rekeys, transfer linking, and the search RPC.
- `supabase/functions/_shared/server.test.ts`: token encryption (including tamper and AAD binding), webhook signature verification, pagination restarts, config validation.
- `apps/web/test`: renders every route with a mocked API in jsdom to catch runtime errors in page code.

## Deployment

The workflow is **VS Code + Claude Code → GitHub → deployment**.

- **CI** (`.github/workflows/ci.yml`) runs `npm run verify` and a build on every push and PR.
- **Backend** (`.github/workflows/deploy-backend.yml`, manual trigger): pushes migrations and deploys edge functions. It needs the repo secrets `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` and `SUPABASE_DB_PASSWORD`, plus a `production` environment. Add a `push` trigger when you want deploy-on-merge.
- **Frontend**: any static host with GitHub integration (Vercel, Netlify, Cloudflare Pages…).
  - Build command: `npm run build`
  - Output directory: `apps/web/dist`
  - Environment: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
  - Configure an **SPA fallback** (all paths → `/index.html`) so deep links like `/transactions?tx=…` work.

## Security notes

- Bank credentials go directly to Plaid Link and are never seen or stored here.
- Plaid access tokens are AES-256-GCM encrypted in a table clients cannot read (RLS with no policies). The ciphertext is bound to its connection id.
- Every table has RLS keyed to `auth.uid()`. Composite foreign keys prevent cross-user references. `anon` has no privileges.
- Edge functions validate the caller's JWT and scope every service-role query to that user. Webhooks are verified with Plaid's signed JWT (ES256, body hash, 5-minute age limit). The cron endpoint requires a constant-time-compared secret.
- Logs contain only ids, codes and counts: never tokens, secrets, request bodies or transaction data.
