# Personal Finance Hub (working title)

A private Progressive Web App for one person to manage personal and small-business finances in
South African Rand. Its main job is answering **"how much can I safely spend?"**, with every figure
explained.

- Dark, responsive UI for Windows desktop and iPhone-sized screens, installable as a PWA
- Works offline: each device keeps a working copy in IndexedDB
- Optional **sync between devices** through your own Supabase account (sign-in, row-level security)
- Personal and Business workspaces, plus a Combined view
- No bank API: import CSV statements (reviewed before saving, undoable) or enter transactions manually

See [`docs/implementation-status.md`](docs/implementation-status.md) for what is built and the
assumptions made, [`docs/backend-plan.md`](docs/backend-plan.md) for the sync design, and
[`docs/deployment.md`](docs/deployment.md) for Supabase setup and Cloudflare Pages deployment.

## Getting started

Requires Node.js 20.19+ and npm. For sync and the database tests you also need Docker.

```bash
npm install
cp .env.example .env.local   # optional: fill in Supabase values to enable sign-in and sync
npm run dev                  # http://localhost:5173
```

With `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` empty, the dev server runs
**local-only**: no sign-in, data stays in this browser. With them set, the whole app is behind sign-in
and syncs. Production builds require both (set `ALLOW_LOCAL_ONLY_BUILD=true` to build the local-only
app on purpose). For a
local Supabase stack: `npx supabase start && npx supabase db reset` (details in
[`docs/deployment.md`](docs/deployment.md)).

| Script                   | What it does                                                         |
| ------------------------ | -------------------------------------------------------------------- |
| `npm run dev`            | Vite dev server                                                      |
| `npm run build`          | Type-check, then production build to `dist/` (PWA, CSP, `_headers`)  |
| `npm run preview`        | Serve the production build locally                                   |
| `npm test`               | Unit and integration tests (jsdom, fake IndexedDB, in-memory server) |
| `npm run test:db`        | RLS and sync tests against local Supabase (`npx supabase start`)     |
| `npm run check:pwa`      | Service worker, manifest, offline and CSP checks in headless Edge    |
| `npm run typecheck`      | `tsc --noEmit`                                                       |
| `npm run lint`           | ESLint                                                               |
| `npm run format`         | Prettier                                                             |
| `npm run build:artifact` | Local-only variant for the Claude artifact viewer (`dist-artifact/`) |

> **Windows note:** `package.json` overrides Rollup with its official WASM build
> (`@rollup/wasm-node`) because Windows Application Control on the development machine blocks
> Rollup's native `.node` binary. Builds are slightly slower; behaviour is the same.

## Deployment (Cloudflare Pages)

| Setting                | Value                                                                           |
| ---------------------- | ------------------------------------------------------------------------------- |
| Build command          | `npm run build`                                                                 |
| Build output directory | `dist`                                                                          |
| Environment variables  | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (Node 20.19 from `.nvmrc`) |

Both Supabase values are public by design (row-level security protects the data). The build fails
if either is missing, if only one is set, or if the key is a secret/service-role key, so a
misconfigured deployment can't ship the app without sign-in and sync. Full steps, including Supabase auth settings and
turning off sign-ups after creating your account, are in [`docs/deployment.md`](docs/deployment.md).

## Architecture

```
src/
  domain/            Pure, framework-free logic
    models/          Zod schemas + TypeScript types for every entity
    calculations/    Financial engine (pure functions, unit tested)
    imports/         CSV parsing, column mapping, normalisation, fingerprints, duplicate staging
    money.ts         Integer-cent helpers, ZAR parsing/formatting
    dates.ts         ISO calendar dates in Africa/Johannesburg
    defaults.ts      Editable defaults (R12,000 salary, R1,200 tithe, 20%) and seed categories
  data/
    local-db/        Dexie (IndexedDB) schema and versioned migrations
    repositories/    Storage-agnostic repository interfaces + Dexie implementation (validates on write)
    sync/            Change tracking (outbox), sync engine, Supabase client and row mapping
  services/          Use cases: accounts, transactions/transfers, planning, import, backup, demo
  app/               App shell, routing, sign-in gate, sync context, PWA update prompt
  components/        Shared UI primitives and confirmation dialog
  features/          Pages: dashboard, transactions, import, accounts, budgets, goals, business,
                     reports, settings (incl. sync)
supabase/
  migrations/        Versioned SQL: tables, constraints, RLS policies, sync functions
  tests/             Database tests run against the local stack
```

Rules the code follows:

- **Money is integer cents.** No floating-point arithmetic on persisted values.
- **UI holds no formulas.** Pages call `domain/calculations` (e.g. `buildDashboard`).
- **Every write is validated** with Zod locally and by column types and CHECK constraints on the
  server.
- **Schema changes are migrations** — `SCHEMA_VERSIONS` in `src/data/local-db/db.ts` for IndexedDB,
  `supabase/migrations/` for Postgres. Never edit a released version.

### Sync in one paragraph

Each device works on its own IndexedDB copy, so the app is fast and works offline. Every local
write is also queued in an outbox in the same transaction. The sync engine sends queued changes
with the server revision the device last saw; the server applies a change only if nobody else changed
that record since, otherwise it reports a **conflict**. The synced version is then shown, and this
device's version is kept under Settings → Sync until you choose which to keep. It never silently
overwrites. Deletions sync as tombstones. Changes reach other devices within seconds through Supabase
Realtime, and also on app focus, when the network returns, and at least every minute. Every table has row-level
security limiting rows to their owner.

### How "available to spend" is calculated

```
cash_based = spendable posted balances
           − unpaid commitments due before the next payday (or month-end)
           − goal allocations still sitting in spendable accounts
           − planned savings not yet set aside this period   (optional, on by default)

available  = max(0, min(cash_based, remaining wants budget))   when strict budgets are on and set
           = max(0, cash_based)                                otherwise

daily      = floor(available ÷ days remaining, counting today)
```

Safeguards against double counting:

- A recurring bill is a forecast. It stops being deducted once a posted transaction matches it
  (same direction and workspace, amount within 10% or R1, date within the match window, and the
  same category or a description containing its name), or once you mark it as paid.
- Transfers between your own accounts are never income or expenses. The server also rejects a
  transfer with more than two legs or legs that don't balance.
- Imports: duplicates are checked against everything already synced (the import page syncs first),
  and the dashboard flags statement rows imported in two batches (e.g. on two devices offline).
- Goal money held in a non-spendable account isn't subtracted again; savings already made this
  period reduce the remaining planned savings.
- Expected income, pending transactions and unpaid invoices are never counted as cash.

### Importing statements

**Import statement** (`/import`) reads a CSV file on the device; the file itself is never uploaded
and no data is sent to any AI service. You confirm the column mapping against a preview, review every
row (unreadable rows are listed and never imported; duplicates are unticked; identical rows in one
file stay ticked but flagged), then import. Imported transactions are marked **Needs review**, keep
their original row text, and can be removed together with **Undo import**.

## Your data: backup, privacy and limitations

- **Signed in:** records are stored in your Supabase project, readable only through your account
  (RLS). They are encrypted in transit and at rest by Supabase but are **not end-to-end encrypted**:
  the database operator could read them. Not signed in: data stays in this browser only.
- Back up regularly anyway (Settings → Download backup file / Copy backup text): a deletion on one
  device deletes everywhere. **Backups are plain JSON and are not encrypted.**
- Restore offers **Merge** (upsert by ID, never duplicates) or **Replace** (also replaces the synced
  copy when signed in). Invalid files are rejected without changing anything.
- Signing out removes this device's copy by default; unsynced changes are sent first.
- Demo data is labelled "Demo" and can be cleared without touching your own records.

## Known limitations

- No bank connection of any kind. Capitec transaction-history access via an API is unverified, and
  the app never asks for banking credentials, PINs or OTPs. It cannot read iPhone SMS or
  notifications.
- Statement import is CSV only (save Excel workbooks as “CSV UTF-8”); no PDF import.
- Invoices, projects, charts, CSV/Excel export, what-if scenarios, categorisation rules, split
  transactions and configurable alert preferences are not built yet.
- Offline behaviour and the service worker were verified in headless Microsoft Edge on Windows, not
  yet on a physical iPhone.
- Figures are estimates based on what you enter. They are not financial advice, and business
  figures are not formal accounting or tax results.
