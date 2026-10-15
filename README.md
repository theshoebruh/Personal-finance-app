# Personal Finance Hub (working title)

A private, local-first Progressive Web App for one person to manage personal and small-business
finances in South African Rand. Its main job is answering **"how much can I safely spend?"**, with
every figure explained.

- Dark, responsive UI for Windows desktop and iPhone-sized screens
- Data stays in this browser (IndexedDB). No account, no server, no bank login
- Personal and Business workspaces, plus a Combined view
- Works without any bank API: you enter transactions manually (statement import is next)

See [`docs/implementation-status.md`](docs/implementation-status.md) for what is built, what is
not, and the assumptions made.

## Getting started

Requires Node.js 20.19+ and npm.

```bash
npm install
npm run dev          # http://localhost:5173
```

| Script              | What it does                                            |
| ------------------- | ------------------------------------------------------- |
| `npm run dev`       | Vite dev server                                         |
| `npm run build`     | Type-check, then production build to `dist/` (+ PWA)    |
| `npm run preview`   | Serve the production build locally                      |
| `npm test`          | Vitest unit + integration tests (jsdom, fake IndexedDB) |
| `npm run typecheck` | `tsc --noEmit`                                          |
| `npm run lint`      | ESLint                                                  |
| `npm run format`    | Prettier                                                |
| `npm run icons`     | Regenerate the PNG app icons in `public/`               |

No environment variables or secrets are needed. The app makes no network requests for data.

> **Windows note:** `package.json` overrides Rollup with its official WASM build
> (`@rollup/wasm-node`) because Windows Application Control on the development machine blocks
> Rollup's native `.node` binary. Builds are slightly slower; behaviour is the same.

## Architecture

```
src/
  domain/            Pure, framework-free logic
    models/          Zod schemas + TypeScript types for every entity
    calculations/    Financial engine (pure functions, unit tested)
    money.ts         Integer-cent helpers, ZAR parsing/formatting
    dates.ts         ISO calendar dates in Africa/Johannesburg
    defaults.ts      Editable defaults (R12,000 salary, R1,200 tithe, 20%) and seed categories
  data/
    local-db/        Dexie (IndexedDB) schema and versioned migrations
    repositories/    Storage-agnostic repository interfaces + Dexie implementation (validates on write)
  services/          Application use cases: accounts, transactions/transfers, planning, backup, demo
  app/               App shell, routing, context, live data hook, PWA update prompt
  components/        Shared UI primitives
  features/          Pages: dashboard, transactions, accounts, budgets, goals, business, reports, settings
  styles/            Design tokens (dark theme) and app CSS
  test/              Test factories
```

Rules the code follows:

- **Money is integer cents.** No floating-point arithmetic on persisted values.
- **UI holds no formulas.** Pages call `domain/calculations` (e.g. `buildDashboard`,
  `calculateAvailableToSpend`).
- **Every write is validated** with Zod in the repository layer.
- **Schema changes are migrations.** Add a new entry to `SCHEMA_VERSIONS` in
  `src/data/local-db/db.ts`; never edit a released version.

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
- Transfers between your own accounts (including to savings, and personal↔business) are never
  income or expenses.
- Goal money held in a non-spendable account isn't subtracted again.
- Savings already made this period reduce the remaining planned savings.
- Expected income, pending transactions and unpaid invoices are never counted as cash.

The dashboard's "How this is calculated" panel shows each of these lines with its inputs.

## Your data: backup and limitations

- Data lives only in this browser profile on this device. **It does not sync between your iPhone
  and PC.**
- Browsers can clear site data (Safari may remove data for sites not used for a while). Use
  **Settings → Export backup** regularly and keep the file somewhere private. Installing the app to
  the home screen and allowing persistent storage reduce the risk.
- **Backup files are plain JSON and are not encrypted.**
- Restore offers **Merge** (upsert by ID, so restoring twice never duplicates) or **Replace**
  (for a new device or after data loss). Invalid files are rejected without changing anything.
- **Settings → Delete all data** wipes the device (type `DELETE` to confirm).
- Demo data is labelled "Demo" and can be cleared without touching your own records.

## Known limitations

- No bank connection of any kind. Capitec transaction-history access via an API is unverified, and
  the app never asks for banking credentials, PINs or OTPs. It cannot read iPhone SMS or
  notifications.
- Statement import (CSV/Excel, then PDF) is not built yet — manual entry only.
- Invoices, projects, charts, CSV/Excel export, what-if scenarios, categorisation rules, split
  transactions and configurable alert preferences are not built yet.
- Offline use relies on the service worker. It is generated and served by the production build,
  but installation/offline behaviour has not yet been verified on a real iPhone or desktop browser.
- Figures are estimates based on what you enter. They are not financial advice, and business
  figures are not formal accounting or tax results.
