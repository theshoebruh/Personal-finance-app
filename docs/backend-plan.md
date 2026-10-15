# Backend, sync and deployment plan

Branch: `feature/supabase-sync`. Status: in progress — see the checklist at the end.

## 1. Audit of the current app

| Area            | Finding                                                                                                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework       | React 18 + TypeScript (strict) + Vite 6, React Router 7, Zod 3                                                                                                                                                                         |
| Package manager | npm (`package-lock.json`); Node ≥ 20.19                                                                                                                                                                                                |
| Persistence     | IndexedDB via Dexie 4 behind a repository interface (`FinanceStore`, `src/data/repositories/types.ts`). Every write is Zod-validated. Schema versions with migrations in `src/data/local-db/db.ts` (currently v2)                      |
| Data model      | 13 stores: accounts, transactions, categories, budgets, goals, goalContributions, recurringRules, importBatches, importProfiles, categorisationRules, projects, invoices, settings. Money is integer cents; dates are ISO `YYYY-MM-DD` |
| Transfers       | Not a separate store: two transaction legs share a `transferId` (`transferKind` internal / owner contribution / owner draw)                                                                                                            |
| Workspaces      | A fixed pair (personal, business) plus a Combined view; not stored records                                                                                                                                                             |
| Routes          | `/` dashboard, `/transactions`, `/import`, `/budgets`, `/goals`, `/accounts`, `/business`, `/reports`, `/settings`                                                                                                                     |
| Tests           | 124 Vitest tests (unit, Dexie integration with fake-indexeddb, React Testing Library UI flows). No end-to-end browser tests                                                                                                            |
| PWA             | vite-plugin-pwa manifest + Workbox service worker, icons 192/512/180, build-time CSP meta tag. Offline behaviour not yet verified on a real device                                                                                     |
| Builds          | `npm run build` → `dist/` (PWA); `npm run build:artifact` → `dist-artifact/` (Claude artifact variant)                                                                                                                                 |

### Working vs placeholder

Working and tested: accounts, manual transactions, transfers, CSV import (review, duplicates, undo), budgets, recurring items with forecast matching, goals, available-to-spend dashboard, backup/restore (file and copy/paste), demo data.

Placeholder or partial: invoices/receivables and projects (tables exist, no UI), categorisation rules (table exists, no engine), reports (tables only, no charts/export), alert preferences.

## 2. Key decisions

1. **Local-first stays.** IndexedDB remains the app's working copy on each device. The UI and all
   services keep using `FinanceStore` unchanged. Supabase is the synced copy, not a replacement, so
   the app still works offline and nothing already working is rewritten.
2. **Plain relational rows protected by row-level security**, not client-side encryption: the brief
   asks for tables around the existing model with per-owner RLS. Data is encrypted in transit
   (HTTPS) and at rest by Supabase, but readable by the database operator. The app does **not**
   claim end-to-end encryption.
3. **Sync is optional.** Without `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` the app runs
   local-only exactly as today (tests, the artifact build). With them, the app requires sign-in.
4. **One local database per signed-in user** (`personal-finance-hub-<userId>`), so two people on one
   browser can never see each other's cached data. The old local-only database is offered once for
   copying into the account.

## 3. Database (Supabase Postgres)

Migrations live in `supabase/migrations/` (Supabase CLI).

- One table per store, snake_case columns mirroring the Zod models: `accounts`, `transactions`,
  `categories`, `budgets`, `goals`, `goal_contributions`, `recurring_rules`, `import_batches`,
  `import_profiles`, `categorisation_rules`, `projects`, `invoices`, `settings`.
- Primary key `(user_id, id)`. `user_id uuid not null default auth.uid() references auth.users on
delete cascade`. Client IDs stay text (seed IDs like `cat-salary` exist on every device).
- Composite foreign keys scoped to the same user (e.g. `transactions(user_id, account_id) →
accounts(user_id, id)`), `deferrable initially deferred` so a batch can arrive in any order.
- CHECK constraints mirror domain rules: non-zero amounts, sign by type (income > 0, expense < 0,
  refund > 0), enums, transfer legs must carry a transfer ID.
- Sync columns on every table: `revision bigint` (incremented by trigger), `server_updated_at
timestamptz` (trigger, `clock_timestamp()`), `deleted boolean` (tombstone).
- Transfer integrity (deferred constraint trigger): at most two live legs per `transfer_id`, and a
  complete pair must sum to zero — a server-side guard against inflated transfers.

### Row-level security

RLS is enabled and forced on every table. Policies for the `authenticated` role only:
`select/insert/update/delete using (user_id = (select auth.uid()))` and `with check` the same.
`anon` gets no table privileges. No service-role key is used anywhere in the app.

### Sync functions (security invoker, so RLS still applies)

- `sync_push(changes jsonb)`: for each `{table, id, op, base_rev, record}` (table whitelisted):
  insert when new; update/tombstone only when `revision = base_rev`; otherwise return `conflict`
  with the server row. `user_id` is always forced to `auth.uid()`. One transaction per call.
- `sync_pull(since_ts, since_table, since_id, limit)`: rows changed after a keyset cursor, across all
  tables, including tombstones.

## 4. Client sync engine

- **Change tracking:** a `FinanceStore` decorator records every put/delete/clear in a local
  `outbox` store inside the same IndexedDB transaction (collapsed to the latest operation per
  record). Services are untouched.
- **Push:** sends the outbox with each record's last-seen server revision (`syncMeta`). Applied
  entries leave the outbox. If a batch fails as a whole (e.g. a constraint), entries are retried one
  by one so a single bad record can't block everything; it is marked failed with the reason.
- **Pull:** keyset pagination with a 60-second overlap; applying is idempotent (skips revisions
  already seen). Records with unpushed local edits are never overwritten by a pull.
- **Conflicts (deliberate, never silent):** when the server copy changed since this device last saw
  it, the server version is applied and the local version is kept in a `conflicts` list. Settings →
  Sync shows each conflict with the differing fields and offers "Keep this device's version" or
  "Keep the synced version". Identical content (ignoring timestamps) resolves automatically, which
  also makes retried pushes after a lost response harmless.
- **When:** after local changes (debounced), on app focus, when the network returns, every 60 s,
  and on Supabase Realtime notifications for instant cross-device updates. Exponential backoff on
  errors. Status shown in the app: synced / syncing / offline / error / conflicts.
- **First sync on a new device:** pull before seeding defaults, so a new device never overwrites
  your settings or categories with defaults.
- **Sign-out:** pending changes are pushed first; the device's copy is removed by default.
- **Auth tokens** are stored in IndexedDB rather than `localStorage`.

### Double-counting safeguards with sync

- Transfers: legs are created atomically, pushed in the same call, and checked by the server trigger.
- Tithe/bills: forecast matching is unchanged; it runs on the synced data.
- Imports: the import page syncs before staging so duplicate detection sees the other device's
  imports; a post-sync check flags fingerprints imported in two batches more often than in any
  single file (two devices importing the same statement offline).

## 5. Auth

Email + password (Supabase Auth): sign in, create account, reset password, sign out, session refresh.
The whole app is behind the sign-in screen when sync is configured. Recommended: after creating
your account, disable new sign-ups in the Supabase dashboard (single-user app).

## 6. Deployment (Cloudflare Pages)

- Build command `npm run build`, output directory `dist`, `NODE_VERSION=20.19.0`.
- Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (public by design;
  RLS protects the data). No secrets in the frontend.
- `public/_headers`: CSP (connect-src limited to the Supabase project), HSTS, no-sniff, referrer
  and permissions policies, no-cache for the service worker.
- SPA routing: Pages serves `index.html` for unknown paths when no `404.html` exists.

## 7. Verification plan

- Unit: row mapping round-trips for every entity, change tracking, sync engine against an
  in-memory remote that implements the same protocol (two devices, conflicts, deletes, retries,
  network failure, lost responses).
- Database (`npm run test:db`, needs `supabase start`): RLS isolation between two users and anon,
  forged `user_id`, push conflict rules, transfer trigger, and two "devices" syncing through the
  real local Supabase (create on one, appear on the other; deletes; backup restore; fresh login;
  sign-out; failed network then recovery).

## Checklist

- [x] Audit and plan
- [ ] Migrations, RLS, sync functions
- [ ] Change tracking and sync engine (+ tests)
- [ ] Auth, protected app, per-user database
- [ ] Sync status, conflicts UI, import safeguards
- [ ] RLS and two-device tests against local Supabase
- [ ] Cloudflare Pages config, PWA checks, `.env.example`, docs
