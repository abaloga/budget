# Architecture

This app is a personal budgeting tool: automatic bank sync, category budgets, recurring bills, goals and reports. It is single-user today, but every table is keyed by `user_id` with Row Level Security, so multi-user support needs no data-model changes.

## System overview

```
 ┌──────────────┐     ┌───────────────┐            ┌──────────────────────────────────────┐
 │  apps/web    │     │ (future)      │            │ Supabase                              │
 │  React/Vite  │     │ Expo iOS app  │            │                                      │
 └──────┬───────┘     └──────┬────────┘            │  Postgres (RLS on every table)        │
        │  @budget/api       │  @budget/api        │   ├─ tables, views, RPCs              │
        │  @budget/core      │  @budget/core       │   └─ pg_cron → scheduled-sync         │
        ├────────────────────┴──── HTTPS ─────────►│                                      │
        │   PostgREST (as the signed-in user)      │  Edge Functions (Deno, service role)  │
        │   functions.invoke('plaid')              │   ├─ plaid           (user actions)   │
        │                                          │   ├─ plaid-webhook   (Plaid → us)     │
        │                                          │   └─ scheduled-sync  (cron)           │
        │                                          │        uses @budget/core copy         │
        │                                          └───────────────┬──────────────────────┘
        │                                                          │ secrets live only here
        └── Plaid Link (browser SDK) ─────────────── Plaid ◄───────┘
```

- Both frontends talk to the same backend independently. They never talk to each other.
- The browser holds only the public Supabase URL and anon key. The Plaid secret, service-role key and token-encryption key exist only as edge function secrets.
- Every client query runs as the signed-in user under RLS. Edge functions use the service role, so they authenticate the caller and scope every query by that user's id.

## Repository layout

```
packages/core/         Pure TypeScript domain logic. Zero dependencies. Runs on web, React Native and Deno.
packages/api/          Typed data access over supabase-js. Takes an injected SupabaseClient. No React, no DOM.
apps/web/              React + Vite UI. Presentation only; calls @budget/api and @budget/core.
supabase/migrations/   Schema, RLS, RPCs (the source of truth for the database).
supabase/functions/    Edge functions. _shared/core/ is a generated copy of packages/core.
supabase/scheduler/    One-time SQL to schedule the periodic sync (environment-specific).
tests/db/              Migrations + RLS + RPC tests against real Postgres (PGlite).
```

### Where logic lives

| Concern                                                    | Location                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| Budget math, rollovers, overspending status                | `core/budget.ts`                                                    |
| Cash flow (income − expenses, transfers excluded)          | `core/cashflow.ts`                                                  |
| Categorization pipeline (rules → history → provider)       | `core/categorize.ts`, `core/rules.ts`, `core/providerCategories.ts` |
| Transfer detection                                         | `core/transfers.ts`                                                 |
| Splits (validation, reporting lines, rebalancing)          | `core/splits.ts`                                                    |
| Recurring detection, schedules, upcoming bills             | `core/recurring.ts`                                                 |
| Goals (progress, monthly contribution)                     | `core/goals.ts`                                                     |
| Reports (by category, merchant, month; trends)             | `core/reports.ts`                                                   |
| Account balance presentation                               | `core/accounts.ts`                                                  |
| Sync planning (idempotent upserts, pending→posted, splits) | `core/sync.ts`, `core/plaid.ts`                                     |
| Transaction filters (shared definition + URL params)       | `core/filters.ts`                                                   |
| Merchant normalization                                     | `core/merchant.ts`                                                  |
| Row ↔ domain mapping                                       | `core/rows.ts`                                                      |
| Queries/mutations against Supabase                         | `packages/api`                                                      |
| Atomic writes, grouping/summing, access control            | SQL (migrations)                                                    |
| Plaid HTTP calls, token encryption, webhook verification   | `supabase/functions/_shared`                                        |

The rule: **SQL stores, secures and groups; TypeScript decides what it means.** For example, `category_month_totals` sums lines by month, category and kind. Whether a kind counts as spending is decided in `core/budget.ts` and `core/cashflow.ts`.

## Database

All money is `bigint` cents. All calendar dates are `date` (no time zone). Enumerations use `text` + `CHECK` so they're easy to evolve.

| Table                  | Purpose                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `profiles`             | Per-user preferences (1:1 with `auth.users`).                                                                  |
| `connections`          | One per linked institution login (Plaid Item): status, sync cursor, last sync, lease.                          |
| `connection_secrets`   | AES-GCM-encrypted access token. RLS on, **no policies** → service role only.                                   |
| `accounts`             | Accounts under a connection with balances. Clients may edit only `display_name` and `is_hidden`.               |
| `transactions`         | Raw provider columns + user overrides + classification + generated effective `name`/`date`.                    |
| `transaction_splits`   | Parts of a split transaction. A deferred constraint trigger enforces sum = parent amount.                      |
| `categories`           | Two-level tree (group → category), `kind` expense/income, rollover settings, archive flag.                     |
| `budgets`              | Amount per category per month (`month` = first of month).                                                      |
| `categorization_rules` | AND-ed conditions (name contains/equals/starts with, account, direction, amount range) → category and/or kind. |
| `recurring_series`     | Bills/subscriptions/paychecks: expected amount/range, frequency, next date, account, category, status.         |
| `savings_goals`        | Target, current (or linked account balance), optional date.                                                    |
| `sync_runs`            | Audit log of syncs (counts and error codes only).                                                              |

Views and RPCs:

- `transaction_lines` is the reporting source of truth: one line per split, or one per unsplit transaction.
- `category_month_totals`, `merchant_totals` and `search_transactions` are read-side (security invoker, so RLS applies).
- `set_transaction_splits`, `link_transfer` and `set_transaction_kind` are atomic user edits.
- `apply_transaction_sync`, `apply_transfer_pairs` and `acquire_sync_lease` are service-role only.

### The transaction model

```
transactions
  provider_*  original_*  amount_cents  pending  merchant_key   ← written by sync (read-only to clients for imported rows)
  name_override  date_override  notes                            ← user edits, never touched by sync
  category_id + category_source   kind + kind_source             ← who decided: user | rule | history | provider
  transfer_pair_id  recurring_id
  name, date  (GENERATED: coalesce(override, original))          ← what every query uses
```

- **Sync can't undo user edits.** The sync upsert's `ON CONFLICT` clause updates only provider-owned columns. Categories, notes, overrides, splits and transfer links are never in the update set.
- **Pending → posted keeps edits.** When Plaid posts a pending charge, the posted id is moved onto the existing pending row ("rekey") instead of a delete + insert.
- **Idempotent.** Upserts are keyed by `(user_id, provider_transaction_id)`, and duplicates within a batch are merged before writing. The whole batch plus the new cursor commit in one database transaction, so replaying a sync converges on the same state.
- **Guards.** A trigger blocks clients from changing raw provider columns on imported rows. RLS allows inserting and deleting only `source = 'manual'` transactions.

### Signs and kinds

- `amount_cents` is from the user's point of view: **positive = money in, negative = money out.** Plaid uses the opposite sign; `core/plaid.ts` flips it.
- `kind` is `expense | income | transfer`.
  - Spending = −(sum of expense lines). A refund is a positive expense line, so it reduces spending.
  - Income = sum of income lines.
  - Transfers are excluded from income, spending and budgets.
- **Credit cards.** A card purchase is an expense when it happens. The later payment (checking → card) is a transfer on both sides, so it is never a second expense.

## Architectural decisions

| #   | Decision                                                                                                             | Why                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Supabase Edge Functions are the only server.** No separate Node service.                                           | One backend for web and iOS. Secrets stay server-side. Nothing extra to host.                                                                             |
| 2   | **`@budget/core` is dependency-free TS with `.ts` import extensions.**                                               | The same file runs in Vite, Metro (Expo) and Deno. ESLint forbids platform imports there.                                                                 |
| 3   | **Core is _copied_ into `supabase/functions/_shared/core`**, committed, and drift-checked (`npm run core:check`).    | The Supabase function bundler reliably resolves only files under `supabase/functions`. A committed copy works with any deploy path, and CI catches drift. |
| 4   | **Integer cents everywhere.**                                                                                        | Floating-point money errors can't happen. `bigint` in Postgres, `number` (safe integers) in TS.                                                           |
| 5   | **Dates as `YYYY-MM-DD` strings.**                                                                                   | Transactions are calendar days. `Date` objects shift across time zones and would misplace month boundaries.                                               |
| 6   | **Raw vs. override columns with generated effective values** (not separate tables).                                  | Simple queries and indexes, with no join needed to read a transaction. Provider data stays intact and user edits are isolated.                            |
| 7   | **`*_source` columns** record who decided a category or kind.                                                        | Automation (rules, retroactive rules, detection) never overrides an explicit user choice. `source = 'user'` rows feed history learning.                   |
| 8   | **One atomic sync RPC** (`apply_transaction_sync`) advances the cursor with the data.                                | A crash can't leave the cursor ahead of the data (which would skip transactions) or behind it (replays are harmless anyway).                              |
| 9   | **Aggregation in SQL, semantics in TS.**                                                                             | Fast queries over years of history, with all business rules shared and unit-tested.                                                                       |
| 10  | **Composite `(id, user_id)` foreign keys.**                                                                          | A row can never reference another user's category/account/transaction, even through a service-role bug. This is a multi-user-ready invariant.             |
| 11  | **Access tokens encrypted in-app (AES-256-GCM) with the connection id as AAD**, in a table with RLS and no policies. | Defense in depth. Leaking the table isn't enough, and ciphertexts can't be swapped between rows.                                                          |
| 12  | **Categories are archived, not deleted**, when referenced (FK `ON DELETE RESTRICT`).                                 | History keeps its categories. Deleting is allowed only for unused categories.                                                                             |
| 13  | **Rollover carries overspending forward as a negative amount.**                                                      | "Correctly handle overspending": going over this month reduces next month's available budget. Rollover starts at `rollover_start_month`.                  |
| 14  | **Pending transactions count toward spending.**                                                                      | That money is already committed. They're flagged "Pending" everywhere.                                                                                    |
| 15  | **Recurring series edited by the user become `manual`**; `ignored` series are never resurrected by detection.        | Detection refreshes dates without fighting user edits.                                                                                                    |
| 16  | **Hidden accounts are a display preference only**; their transactions still count.                                   | Hiding a rarely used account shouldn't silently change budgets. Disconnecting an institution offers keep or delete history.                               |
| 17  | **`user_id` defaults to `auth.uid()`** on user-managed tables.                                                       | Clients never send `user_id`. RLS `WITH CHECK` still verifies it.                                                                                         |

## Sync pipeline

```
Plaid webhook ─┐
Scheduled cron ├─► syncConnection(connectionId)
"Sync now"     ┘      1. acquire_sync_lease (skip if another sync holds it)
                      2. decrypt access token (AAD = connection id)
                      3. /accounts/get → upsert accounts + balances, deactivate missing ones
                      4. /transactions/sync from cursor, all pages
                         (restart from the original cursor on TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION)
                      5. core.planTransactionSync: dedupe, rekey pending→posted, classify new rows,
                         rebalance splits whose amount changed
                      6. apply_transaction_sync RPC (one DB transaction, cursor included)
                      7. post-sync: link transfers (core.findTransferPairs → apply_transfer_pairs),
                         refresh recurring series (core.detectRecurring → planRecurringUpdates)
                      8. connection status/errors; sync_runs row
```

Item errors (e.g. `ITEM_LOGIN_REQUIRED`) mark the connection `login_required`. The Accounts page then shows **Reconnect**, which opens Plaid Link in update mode.

## Reuse by the React Native / Expo app

**Reusable as-is:**

- `@budget/core`: all calculations, detection, filters, row mapping and formatting. It relies on `Intl.NumberFormat` and `Intl.DateTimeFormat`, which Hermes supports.
- `@budget/api`: every query and mutation. Create the Supabase client with React Native session storage (`expo-secure-store` or `AsyncStorage`) and pass it to `createBudgetApi(client)`.
- `apps/web/src/hooks/queries.ts`: TanStack Query hooks that depend only on `@budget/api`. **Move them to a shared package** (e.g. `packages/hooks`) when the Expo app starts. They are left in the web app for now to avoid an extra package before it's needed.
- The backend (RLS, RPCs, edge functions) is platform-neutral.

**Needs a native implementation (presentation only):**

- UI components (Tailwind + Radix are web-only). Consider NativeWind to keep the design-token names.
- Charts: `recharts` is web-only. Use `victory-native` or Skia. The chart _data_ (`monthlyTotals`, `categoryTrend`, `amountsByCategory`, …) already comes from core.
- Plaid Link: use `react-native-plaid-link-sdk` with the same `plaid` edge function actions.

**Decisions that could make the iOS app harder, and how they're handled:**

1. **Business logic in SQL.** Kept to storage concerns. Anything a client needs to compute lives in core.
2. **Web-specific session storage.** The Supabase client is injected into `@budget/api`, never created there.
3. **`import.meta.env`.** Used only in `apps/web/src/lib/supabase.ts`.
4. **Plaid OAuth redirects.** The web flow uses `PLAID_REDIRECT_URI` and `/plaid/oauth`. iOS needs a universal link as its redirect URI. **Follow-up:** let `create_link_token` accept a platform parameter and choose the redirect URI per platform, instead of one env value.
5. **Monorepo + Metro.** Expo (SDK 52+) supports npm workspaces. Metro resolves the explicit `.ts` imports in core.
6. **Deep links.** `filtersToParams`/`filtersFromParams` in core give the same filter URLs to Expo Router.

Not built yet (by design): notifications (no device-token table), offline cache persistence, net worth, investments.
