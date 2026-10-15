# Implementation status

Tracks progress against `personal_finance_app_claude_code_requirements.md` (BRD/PRD).
Legend: ✅ done and tested · 🟡 partial · ⬜ not started.

_Last updated: 2026-10-15_

## Starting point

The repository was empty (only `.git`), so the preferred stack from §8.1 was scaffolded:
React 18 + TypeScript + Vite 6, vite-plugin-pwa, Dexie 4 (IndexedDB), Zod 3, React Router 7,
Vitest 4 + React Testing Library. No charting library has been added yet.

## Phase 0 — Foundation

| Item                                                    | Status | Notes                                                                                                                                               |
| ------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scripts: dev, build, test, typecheck, lint, format      | ✅     | All pass                                                                                                                                            |
| PWA manifest + icons                                    | ✅     | Valid manifest generated in `dist/`                                                                                                                 |
| Service worker / offline                                | ✅     | Verified in headless Microsoft Edge (`npm run check:pwa`): installs, app shell and signed-in data load offline. Not yet tested on a physical iPhone |
| Responsive shell (sidebar ≥900px, bottom nav on mobile) | ✅     | Checked at 375px and desktop; no horizontal page scroll                                                                                             |
| Dark design tokens                                      | ✅     | `src/styles/tokens.css`                                                                                                                             |
| Strict CSP                                              | ✅     | Injected into production `index.html`; `connect-src` allows only the configured Supabase project. Security headers in `public/_headers`             |
| No secrets committed                                    | ✅     | `.env.example` has placeholders only; `.env.local` is git-ignored; the build refuses secret/service-role keys                                       |

## Phase 1 — Domain model and local persistence

| Item                                      | Status | Notes                                                                                                       |
| ----------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| Entities + runtime validation             | ✅     | All §8.3 entities have Zod schemas. Invoice, Project and CategorisationRule tables exist but have no UI yet |
| IndexedDB schema + migrations             | ✅     | `SCHEMA_VERSIONS`. Test shows an upgrade keeps existing data                                                |
| Repository interfaces                     | ✅     | `FinanceStore`; Dexie implementation validates every write                                                  |
| Personal/Business workspaces, accounts    | ✅     | Workspaces are a fixed pair (personal, business) plus a Combined view, not user-created records             |
| Data persists across reloads              | ✅     | Tested by reopening the database                                                                            |
| Backup export / restore (merge + replace) | ✅     | Restoring twice creates no duplicates; invalid files are rejected without changes                           |
| Demo data separated + clearable           | ✅     | `isDemo` flag and "Demo ·" names. Clearing refuses if real records depend on demo ones                      |
| Delete all data                           | ✅     | Confirmed by typing DELETE                                                                                  |

## Phase 2 — Transactions and import

| Item                                                                      | Status | Notes                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual add/edit/archive/delete                                            | ✅     | Hard delete only for manual entries; imported entries can be archived or removed by undoing their import                                                                                                                            |
| Search, filter (date/account/category/workspace/type/status/source), sort | ✅     |                                                                                                                                                                                                                                     |
| Bulk category assignment                                                  | ✅     | Also clears "needs review"                                                                                                                                                                                                          |
| Transfers as linked legs; owner contribution/draw                         | ✅     | Edited and deleted as a pair                                                                                                                                                                                                        |
| Preserve original description, source, last update                        | ✅     | Imports store the original row text, source `csv`, fingerprint and import batch                                                                                                                                                     |
| CSV import with staging review                                            | ✅     | `/import`: account + file → column mapping with preview → review → confirm. PapaParse; handles BOM, `,` `;` tab `                                                                                                                   | ` delimiters, quotes |
| Excel files                                                               | 🟡     | CSV saved from Excel works. `.xlsx` files are rejected with instructions to save as “CSV UTF-8” (no spreadsheet parser added yet)                                                                                                   |
| Column mapping saved per account                                          | ✅     | Reused when the header row matches; re-guessed with a warning when the bank's format changes                                                                                                                                        |
| Date/amount normalisation                                                 | ✅     | Y-M-D, D/M/Y, M/D/Y, “15 Mar 2026”; signed or debit/credit columns; CR/DR markers; optional sign flip. Ambiguous D/M vs M/D is flagged (D/M/Y assumed)                                                                              |
| Invalid rows shown, never imported                                        | ✅     | Unreadable dates/amounts are listed with the reason                                                                                                                                                                                 |
| Duplicate detection (fingerprint)                                         | ✅     | Account + date + amount + normalised description (+ bank reference when mapped). Counted per fingerprint, so re-importing or overlapping statements don't duplicate, while identical same-day rows in one file are kept and flagged |
| Possible duplicates of manual entries                                     | ✅     | Same amount within ±3 days of a manual entry → unticked by default, shown with the matching entry                                                                                                                                   |
| Running-balance check + closing balance                                   | ✅     | Advisory: detects row order, suggests a sign flip, and can record the closing balance as the account's reconciliation check                                                                                                         |
| Import history + undo                                                     | ✅     | Undo removes that batch's transactions (warns if any were edited) and keeps the batch as "Undone"                                                                                                                                   |
| Schema migration                                                          | ✅     | v2 adds `importProfiles`; tested from a v1 database. Older backups without it still restore                                                                                                                                         |
| Transfer suggestions for imported rows                                    | ⬜     | Imported transfers to savings currently arrive as income/expense; re-record as a transfer (planned with categorisation rules)                                                                                                       |
| PDF import                                                                | ⬜     | Only if a reliable parser can be validated                                                                                                                                                                                          |
| Categorisation rules + learned corrections                                | ⬜     | **Next**. Imported rows arrive uncategorised and "Needs review"                                                                                                                                                                     |
| Split transactions                                                        | ⬜     |                                                                                                                                                                                                                                     |

## Phase 3 — Budget engine and dashboard

| Item                                                   | Status | Notes                                                            |
| ------------------------------------------------------ | ------ | ---------------------------------------------------------------- |
| R12,000 − R1,200 = R10,800 base, counted once          | ✅     | Unit tested                                                      |
| 20% target = R2,160                                    | ✅     | Unit tested                                                      |
| 50/30/20 benchmark vs actual essentials, with warnings | ✅     | Budgets page; nothing is enforced                                |
| Monthly category budgets                               | ✅     | Budgets page                                                     |
| Recurring commitments + forecast/actual matching       | ✅     | Explicit link, mark as paid, or auto-match. Never deducted twice |
| Salary/tithe recurring items from the income plan      | ✅     | One click; the budget base still comes from settings only        |
| Available-to-spend + breakdown                         | ✅     | Every line explained on the dashboard                            |
| Daily allowance + payday logic                         | ✅     | Edge cases tested: payday 31, leap years, overrides, last day    |
| Actual vs forecast labelling                           | ✅     | Badges on dashboard lines                                        |
| Unaffordable-target warning                            | ✅     |                                                                  |
| Savings transfers not expenses                         | ✅     |                                                                  |

## Phase 4 — Goals, reports, business

| Item                                                                          | Status | Notes                                                                  |
| ----------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------- |
| Goals with virtual allocations, withdrawals, priorities                       | ✅     | Withdrawals can't exceed the allocation. Four default goals on request |
| Emergency fund = months × essential expenses                                  | ✅     | Sources: override → essential budgets → history → "insufficient data"  |
| Goal progress, required monthly amount, projection, behind-schedule alert     | ✅     |                                                                        |
| Business summary (revenue, expenses, estimated operating result, owner flows) | 🟡     | Current month only                                                     |
| Invoices / receivables / projects                                             | ⬜     |                                                                        |
| Reports                                                                       | 🟡     | 6-month income vs spending table and category spend; no charts         |
| CSV/Excel export with formula-injection protection                            | ⬜     |                                                                        |
| What-if calculator                                                            | ⬜     |                                                                        |

## Phase 5 — Forecasts, alerts, polish

| Item                                                                             | Status | Notes                                                                      |
| -------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------- |
| In-app alerts (shortfall, bills due, overdue, late income, budget, goal, review) | 🟡     | Dismissal only lasts for the current session; no per-alert preferences yet |
| Cash-flow forecast to payday/month-end                                           | 🟡     | Commitments and expected income within the window only                     |
| Empty, loading, error states                                                     | 🟡     | Present on built pages                                                     |
| Playwright end-to-end tests                                                      | ⬜     | Critical flows are covered by RTL integration tests for now                |

## Backend and sync (feature/supabase-sync)

| Item                         | Status | Notes                                                                                                                                                       |
| ---------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase schema + migrations | ✅     | `supabase/migrations/`: 13 tables mirroring the app stores, user-scoped composite keys and foreign keys, money/sign/enum checks, transfer-integrity trigger |
| Row-level security           | ✅     | Enabled and forced on every table, owner-only policies, nothing for `anon`. Verified by `npm run test:db` (41 RLS/protocol tests)                           |
| Auth + protected app         | ✅     | Email/password, create account, reset password; whole app behind sign-in when configured; tokens in IndexedDB                                               |
| Data access + sync           | ✅     | Existing repository layer kept; tracked store + outbox; push/pull with revisions; Realtime; offline queue                                                   |
| Conflicts                    | ✅     | Never silently overwritten; Settings → Sync lets you keep either version; identical edits auto-resolve                                                      |
| Per-user local data          | ✅     | One IndexedDB per user; sign-out removes the device copy by default; pre-sign-in data can be copied into the account                                        |
| Double-counting with sync    | ✅     | Transfers checked server-side; import syncs before duplicate check; repeated imports across devices flagged                                                 |
| Two-device verification      | ✅     | 7 real-API two-device tests; manual browser check with two origins (change appeared without reload)                                                         |
| Cloudflare Pages             | 🟡     | Configured and documented (`docs/deployment.md`); not yet deployed — needs your Cloudflare and Supabase accounts                                            |
| Physical iPhone test         | ⬜     | After deployment                                                                                                                                            |

## Phase 6 — Integrations

Not started, by design. No bank API, provider SDK or SMS/notification capture exists or is implied
in the UI.

## Assumptions and interpretations (please review)

1. **Daily-allowance window** runs from today through the **day before** the next payday (money
   received on payday starts a new window), or through month-end if no payday is set. Today counts
   as one day. The allowance rounds **down** to the cent.
2. **Payday on or after the 29th** falls on the last day of shorter months. Payday itself counts as
   the start of the next period.
3. **Budget period** defaults to the calendar month (category limits, savings target). An optional
   "payday to payday" mode is available. The daily-allowance window always ends before the next
   payday.
4. **Eligible cash is posted balances only.** Pending transactions are shown separately and not
   subtracted. This follows the spec; subtracting pending debits would be more conservative —
   decide whether you want that.
5. **Commitments** include unpaid bills from the start of the budget period (so overdue, unmatched
   ones still count and are flagged) through the end of the spending window.
6. **Auto-matching tolerance:** amount within 10% (minimum R1), date within the rule's match window
   (default ±5 days), and the same category or a description containing the item's name.
7. **Planned savings reservation** (on by default) subtracts this period's remaining savings target.
   "Saved this period" counts positive goal allocations plus transfers from spendable to
   non-spendable accounts that aren't already linked to an allocation.
8. **Remaining wants budget** = total discretionary limits − all spending in discretionary
   categories (budgeted or not). Uncategorised spending is reported but not counted.
9. **Account opening balance** is the balance at the start of its opening date; earlier
   transactions are assumed to be included already.
10. **"Needs review" transactions** count toward balances (they're real); only "excluded" and
    archived ones don't.
11. **Salary budget base** comes from the income plan in Settings, not from recorded income, so it
    is counted once. Variable or business income is tracked as actuals but isn't added to the base.
12. **Workspaces** are the fixed pair Personal/Business rather than user-created records.
13. **Combined view** shows both workspaces' spendable cash; the salary savings target applies to
    the Personal and Combined views, not Business.
14. **Imported rows** start uncategorised with status "Needs review" (they still count toward the
    balance). Positive amounts become income, negative ones expenses; nothing is auto-classified as
    a transfer or refund yet.
15. **Import duplicates** that exactly match an existing transaction, and likely matches of manual
    entries, are **unticked by default** but always shown, so the user decides. Undoing an import
    deletes its transactions (they are recreated by importing again).
16. **Imports into demo accounts** are treated as demo data, so "Clear demo data" removes them.

## Next steps (proposed order)

1. Categorisation rules: user rules → learned merchant mappings → heuristics → review, with
   "this transaction only / remember"; apply suggestions during import. Include transfer
   suggestions (matching in/out amounts across own accounts).
2. CSV export with formula-injection escaping.
3. Invoices/receivables and projects; then charts and the what-if calculator.
4. Persistent alert dismissal/preferences; Playwright end-to-end tests; real-device PWA checks.
5. PDF statement import only if a parser proves reliable on real statements (with mandatory review).
