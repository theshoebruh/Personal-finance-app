# Plan: imported transfers (F-03) and deleted data on the server (F-05)

Status: **proposed, not implemented.** Both items block real financial data (audit section 5).

---

## F-03 — Transfers inside bank statements

### Problem

Every imported CSV row becomes income or expense. A row such as "TRANSFER TO SAVINGS −2 160,00"
inflates spending, and if the savings account's statement is also imported, its "+2 160,00" inflates
income. Personal↔business moves have the same problem. Confirmed by the `it.fails` test F-03.

### Proposed behaviour

1. **Detect likely transfers while staging** (pure functions in `src/domain/imports/`):
   - **Paired:** another of your accounts already has the opposite amount within ±3 days that isn't
     already a transfer leg (from an earlier import or manual entry). Strong signal.
   - **Half-recorded:** an existing transfer leg in another account with no partner yet and the
     opposite amount within ±3 days (the other side was imported first). Strong signal.
   - **Wording only:** the description contains transfer words (`transfer`, `trf`, `savings`,
     `own account`, an account's name, `pocket`). Weak signal; suggested, never automatic.
2. **Review screen:** each suspected row shows "Looks like a transfer to/from _Savings_" with
   choices: _Import as transfer_ (default for paired/half-recorded) or _Keep as income/expense_
   (default for wording-only). A row can also be marked as a transfer by hand, choosing the other
   account. The summary counts transfers separately.
3. **Committing a transfer row:**
   - Paired → the existing transaction is converted into the other leg (type `transfer`, category
     cleared, same `transferId`), keeping its original text and source. The imported row becomes the
     first leg.
   - Half-recorded → the imported row becomes the missing leg of the existing transfer.
   - No counterpart yet → the row is stored as a single transfer leg (`transferId` set, no partner).
     When the other account's statement is imported later, step 1 pairs it automatically.
     Optionally "also record the other side now" creates both legs; that leg is marked so a later
     statement row is recognised as a duplicate of it, not a new transaction.
   - `transferKind` follows the accounts' workspaces (internal / owner contribution / owner draw).
4. **Existing transactions:** a _Convert to transfer…_ action on the Transactions page does the same
   for records already imported, finding the counterpart if one exists.
5. **Undo import** reverts conversions it made (restores the counterpart to its previous state) as
   well as removing the rows it added. The batch stores the counterpart's previous values to do this.

### What stays the same

- No server or schema change: transfers are already linked legs, and the server's integrity check
  allows at most two legs that balance (one leg alone is allowed).
- Reports, balances and available-to-spend already exclude transfers; they become correct once rows
  are typed correctly.
- `savingsMadeInPeriod` already counts transfers into non-spendable accounts as savings, so a
  savings transfer imported this way counts toward the R2,160 target once.

### Tests

- Unit: detection (paired, half-recorded, wording-only, ±3-day window, already-paired legs ignored,
  personal↔business kinds); staging summary counts.
- Integration: import main statement then savings statement → one transfer, spending and income
  unchanged; reverse order; one statement only + "record other side" then importing the second →
  no duplicate; undo restores converted counterparts; convert-to-transfer on existing records.
- Flip the F-03 `it.fails` test to a normal test.
- Two-device test: transfer created by import on one device appears as a pair on the other.

### Size and risks

Medium (about a day of work). Main risk: false positives (e.g. a R500 purchase and an unrelated
R500 deposit three days apart). Mitigation: amount + date match only pairs across _your own
accounts_, wording-only suggestions are off by default, and every suggestion is shown for review.

---

## F-05 — Deleted records keep their content on the server

### Problem

A delete only sets `deleted = true`; every column (description, amount, date, notes) stays stored.
"Delete all data" therefore leaves your financial details in the account. Still visible only to you
(RLS), but it contradicts what the button says and the privacy requirements. Confirmed by the
`it.fails` test F-05.

### Options considered

| Option                                      | How                                                                                                    | Verdict                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| A. Blank the content in tombstones          | Make every content column nullable with conditional CHECKs (`deleted or col is not null`) on 13 tables | Large, error-prone migration; constraints get hard to read            |
| **B. Separate deletions log (recommended)** | Hard-delete the row; record `(user_id, table, id, revision, deleted_at)` in a small `deletions` table  | Content really gone; tiny table; clean constraints                    |
| C. Periodically purge tombstones            | Scheduled job deletes tombstones after N days                                                          | Content kept for N days; devices offline longer than N miss deletions |

### Recommended design (option B)

New migration `supabase/migrations/<timestamp>_hard_deletes.sql`:

1. `create table public.deletions (user_id, table_name, id, revision, deleted_at, server_updated_at)`
   with primary key `(user_id, table_name, id)`, RLS forced, owner-only policies, no `anon` access,
   added to the Realtime publication.
2. `sync_push` delete: when the revision matches, **delete the row** and upsert the deletions entry
   with `revision + 1`. Upsert of an id that has a deletions entry: allowed only when `base_rev`
   equals that entry's revision (same conflict rule as today); the new row starts at that revision
   - 1 and the deletions entry is removed.
3. `sync_pull`: return deletions entries as tombstones (`{id, revision, deleted: true,
server_updated_at}`) alongside changed rows. The app already handles tombstones by id and
   revision only, so **no client change is needed for pulling**.
4. Data migration: move existing tombstoned rows into `deletions` and delete them. This permanently
   removes content you already deleted. Live (non-deleted) data is untouched.
5. Foreign keys stay `deferrable initially deferred`, so deleting a record and its dependants in one
   batch still works. A delete that would orphan a live record is rejected and shown as a failed
   change (as today).

App changes: small. Realtime also listens to the `deletions` table (row deletes can't be filtered by
user in Realtime). Wording on "Delete all data" stays accurate.

### Retention you should know about

- The `deletions` log keeps only ids, revisions and dates — no financial content — indefinitely, so a
  device that has been offline for a long time still learns about deletions.
- **Supabase backups:** on paid plans, daily backups (and point-in-time recovery if enabled) keep
  deleted data until those backups expire (typically 7 days on Pro). The free plan has no
  user-accessible backups. This should be stated in the privacy notes; it isn't something the app
  can change.

### Safety of applying it

- Test-first on the local stack: `db reset`, full `npm run test:db`, then a migration-from-old-data
  test (create rows and tombstones with the old schema, apply the new migration, check live rows
  are unchanged and tombstones moved).
- Before `db push` to your hosted project I will list exactly what it changes and wait for your
  confirmation. The only destructive step is purging rows that are already marked deleted.

### Tests

- DB: delete removes the row and creates a deletions entry; content no longer readable; re-creating
  the same id needs the deletion revision (conflict otherwise); pull returns deletion tombstones;
  RLS and anon denial on `deletions`; Realtime event on delete; migration preserves live rows.
- Flip the F-05 `it.fails` test; existing protocol tests updated (tombstone rows now come from
  `deletions`); two-device delete and restore-from-backup tests still pass.

### Size

Medium (about half a day plus review), mostly SQL and tests.

---

## Suggested order

1. **F-05** first: it is self-contained, changes the server, and is best applied before any real
   data exists (nothing to migrate then).
2. **F-03** next, then re-run the manual checklist's import steps with demo statements.
3. Meanwhile, **F-02** (deploy the branch) can happen any time — it makes the live site the synced
   build so the manual checklist can be run on it.
