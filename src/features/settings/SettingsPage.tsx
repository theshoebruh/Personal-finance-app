import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useApp, useFinanceData, type FinanceData } from '@/app/AppContext';
import { budgetableIncome, savingsRateWarning, savingsTarget } from '@/domain/calculations/income';
import { nextPayday } from '@/domain/calculations/period';
import { centsToDecimalString, parseAmountToCents } from '@/domain/money';
import { updateSettings } from '@/services/settingsService';
import {
  type Backup,
  backupFileName,
  deleteAllData,
  exportBackup,
  parseBackup,
  restoreBackup,
} from '@/services/backupService';
import { clearDemoData, hasDemoData, loadDemoData } from '@/services/demoService';
import { Alert, Card, DateText, Field, Loading, Money, useStatus } from '@/components/ui';

function PlanForm({ data, onSaved }: { data: FinanceData; onSaved: (m: string) => void }) {
  const { store, today } = useApp();
  const s = data.settings;
  const [salary, setSalary] = useState(centsToDecimalString(s.monthlySalaryCents));
  const [tithe, setTithe] = useState(centsToDecimalString(s.monthlyTitheCents));
  const [rate, setRate] = useState(String(s.savingsRatePercent));
  const [payday, setPayday] = useState(s.paydayDayOfMonth?.toString() ?? '');
  const [override, setOverride] = useState(s.nextPaydayOverride ?? '');
  const [mode, setMode] = useState(s.budgetPeriodMode);
  const [strict, setStrict] = useState(s.strictBudgetCap);
  const [reserve, setReserve] = useState(s.reservePlannedSavings);
  const [efMonths, setEfMonths] = useState(String(s.emergencyFundMonths));
  const [efFixed, setEfFixed] = useState(
    s.emergencyFundFixedTargetCents === null
      ? ''
      : centsToDecimalString(s.emergencyFundFixedTargetCents),
  );
  const [essential, setEssential] = useState(
    s.essentialMonthlyOverrideCents === null
      ? ''
      : centsToDecimalString(s.essentialMonthlyOverrideCents),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const salaryCents = parseAmountToCents(salary);
  const titheCents = parseAmountToCents(tithe);
  const rateNum = Number(rate);
  const preview =
    salaryCents !== null && titheCents !== null && rateNum >= 0 && rateNum <= 100
      ? {
          base: budgetableIncome(salaryCents, titheCents),
          target: savingsTarget(budgetableIncome(salaryCents, titheCents), rateNum),
        }
      : null;
  const rateWarn = Number.isFinite(rateNum) ? savingsRateWarning(rateNum) : null;
  const paydayNum = payday === '' ? null : Number(payday);
  const nextPd =
    paydayNum !== null && Number.isInteger(paydayNum) && paydayNum >= 1 && paydayNum <= 31
      ? nextPayday(today, { paydayDayOfMonth: paydayNum, nextPaydayOverride: override || null })
      : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (salaryCents === null || salaryCents < 0) errs.salary = 'Enter a valid amount';
    if (titheCents === null || titheCents < 0) errs.tithe = 'Enter a valid amount';
    if (salaryCents !== null && titheCents !== null && titheCents > salaryCents) {
      errs.tithe = 'Tithe is larger than the salary';
    }
    if (
      !Number.isFinite(rateNum) ||
      rateNum < 0 ||
      rateNum > 100 ||
      Math.round(rateNum * 100) !== rateNum * 100
    ) {
      errs.rate = 'Enter a percentage from 0 to 100 (up to 2 decimals)';
    }
    if (paydayNum !== null && (!Number.isInteger(paydayNum) || paydayNum < 1 || paydayNum > 31)) {
      errs.payday = 'Enter a day from 1 to 31, or leave blank';
    }
    const months = Number(efMonths);
    if (!Number.isInteger(months) || months < 1 || months > 24) errs.efMonths = 'Enter 1–24 months';
    const fixed = efFixed.trim() === '' ? null : parseAmountToCents(efFixed);
    if (efFixed.trim() !== '' && (fixed === null || fixed < 0))
      errs.efFixed = 'Enter a valid amount or leave blank';
    const ess = essential.trim() === '' ? null : parseAmountToCents(essential);
    if (essential.trim() !== '' && (ess === null || ess < 0))
      errs.essential = 'Enter a valid amount or leave blank';
    setErrors(errs);
    if (Object.keys(errs).length > 0 || salaryCents === null || titheCents === null) return;
    try {
      await updateSettings(store, {
        monthlySalaryCents: salaryCents,
        monthlyTitheCents: titheCents,
        savingsRatePercent: rateNum,
        paydayDayOfMonth: paydayNum,
        nextPaydayOverride: override || null,
        budgetPeriodMode: mode,
        strictBudgetCap: strict,
        reservePlannedSavings: reserve,
        emergencyFundMonths: months,
        emergencyFundFixedTargetCents: fixed,
        essentialMonthlyOverrideCents: ess,
        onboardingComplete: true,
      });
      onSaved('Settings saved');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form className="form" onSubmit={submit} noValidate aria-label="Budget settings">
      {submitError && <Alert tone="negative">{submitError}</Alert>}
      <fieldset>
        <legend>Income plan</legend>
        <div className="form-row">
          <Field label="Monthly salary (R)" htmlFor="s-salary" error={errors.salary}>
            <input
              id="s-salary"
              inputMode="decimal"
              value={salary}
              onChange={(e) => setSalary(e.target.value)}
            />
          </Field>
          <Field label="Monthly tithe (R)" htmlFor="s-tithe" error={errors.tithe}>
            <input
              id="s-tithe"
              inputMode="decimal"
              value={tithe}
              onChange={(e) => setTithe(e.target.value)}
            />
          </Field>
          <Field
            label="Savings target (%)"
            htmlFor="s-rate"
            error={errors.rate}
            hint={
              rateWarn === 'high'
                ? 'That is a high target — check it leaves enough for essentials.'
                : rateWarn === 'zero'
                  ? 'No savings will be planned.'
                  : 'Applied to salary after tithe.'
            }
          >
            <input
              id="s-rate"
              inputMode="decimal"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </Field>
        </div>
        {preview && (
          <p className="small muted">
            Budgetable salary <Money cents={preview.base} /> · savings target{' '}
            <Money cents={preview.target} /> a month. These are defaults you can change; other
            income is tracked as it is recorded.
          </p>
        )}
      </fieldset>

      <fieldset>
        <legend>Payday and budget period</legend>
        <div className="form-row">
          <Field
            label="Payday (day of month)"
            htmlFor="s-payday"
            error={errors.payday}
            hint={
              nextPd ? (
                <>
                  Next payday: <DateText date={nextPd} />
                </>
              ) : (
                'Leave blank to use month-end.'
              )
            }
          >
            <input
              id="s-payday"
              inputMode="numeric"
              value={payday}
              onChange={(e) => setPayday(e.target.value)}
              placeholder="e.g. 25"
            />
          </Field>
          <Field
            label="Next payday override (optional)"
            htmlFor="s-override"
            hint="e.g. when salary is paid early before a weekend."
          >
            <input
              id="s-override"
              type="date"
              value={override}
              onChange={(e) => setOverride(e.target.value)}
            />
          </Field>
          <Field label="Budget period" htmlFor="s-mode">
            <select
              id="s-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
            >
              <option value="calendar_month">Calendar month</option>
              <option value="pay_period">Payday to payday</option>
            </select>
          </Field>
        </div>
      </fieldset>

      <fieldset>
        <legend>Available-to-spend options</legend>
        <label className="check">
          <input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} />
          Cap available-to-spend at my remaining wants budget (when wants limits are set)
        </label>
        <label className="check">
          <input type="checkbox" checked={reserve} onChange={(e) => setReserve(e.target.checked)} />
          Reserve this period's planned savings that I haven't set aside yet
        </label>
      </fieldset>

      <fieldset>
        <legend>Emergency fund</legend>
        <div className="form-row">
          <Field label="Months of essential expenses" htmlFor="s-efm" error={errors.efMonths}>
            <input
              id="s-efm"
              inputMode="numeric"
              value={efMonths}
              onChange={(e) => setEfMonths(e.target.value)}
            />
          </Field>
          <Field label="Or a fixed target (R, optional)" htmlFor="s-eff" error={errors.efFixed}>
            <input
              id="s-eff"
              inputMode="decimal"
              value={efFixed}
              onChange={(e) => setEfFixed(e.target.value)}
            />
          </Field>
          <Field
            label="Essential monthly expenses (R, optional)"
            htmlFor="s-ess"
            error={errors.essential}
            hint="Leave blank to estimate from essential budgets or recent spending."
          >
            <input
              id="s-ess"
              inputMode="decimal"
              value={essential}
              onChange={(e) => setEssential(e.target.value)}
            />
          </Field>
        </div>
      </fieldset>

      <div className="btn-row">
        <button type="submit" className="btn btn-primary">
          Save settings
        </button>
      </div>
    </form>
  );
}

function downloadJson(data: unknown, fileName: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function DataManagement() {
  const { store, today } = useApp();
  const { run, statusNode, setStatus } = useStatus();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Backup | null>(null);
  const [demo, setDemo] = useState(false);
  const [storageInfo, setStorageInfo] = useState<{
    persisted: boolean | null;
    usage?: number;
  } | null>(null);

  const refreshDemo = () => void hasDemoData(store).then(setDemo);
  useEffect(refreshDemo, [store]);
  useEffect(() => {
    void (async () => {
      const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null;
      const est = navigator.storage?.estimate ? await navigator.storage.estimate() : undefined;
      setStorageInfo({ persisted, ...(est?.usage !== undefined ? { usage: est.usage } : {}) });
    })();
  }, []);

  async function onFile(file: File) {
    if (file.size > 50 * 1024 * 1024) {
      setStatus({ tone: 'negative', text: 'That file is too large to be a backup from this app.' });
      return;
    }
    await run(async () => setPending(parseBackup(await file.text())));
    if (fileRef.current) fileRef.current.value = '';
  }

  return (
    <>
      <Card title="Backup and restore">
        <p className="small">
          Your data lives only in this browser on this device. It does not sync between your iPhone
          and PC, and it can be lost if browser data is cleared. Export a backup regularly and keep
          it somewhere private.
        </p>
        <Alert tone="warning">
          Backup files are not encrypted. They contain your financial records.
        </Alert>
        <div className="btn-row section">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() =>
              void run(async () => {
                const b = await exportBackup(store);
                downloadJson(b, backupFileName(b.exportedAt));
              }, 'Backup downloaded')
            }
          >
            Export backup (JSON)
          </button>
          <label className="btn" htmlFor="restore-file">
            Choose backup to restore…
          </label>
          <input
            id="restore-file"
            ref={fileRef}
            className="visually-hidden"
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
        </div>
        {pending && (
          <div className="panel stack" role="region" aria-label="Confirm restore">
            <p>
              Backup from <strong>{pending.exportedAt.slice(0, 10)}</strong>:{' '}
              {pending.data.accounts.length} accounts, {pending.data.transactions.length}{' '}
              transactions, {pending.data.goals.length} goals.
            </p>
            <p className="small muted">
              <strong>Merge</strong> adds or updates records by ID (restoring twice won't duplicate
              anything). <strong>Replace</strong> deletes everything on this device first — use it
              after data loss or on a new device.
            </p>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  void run(async () => {
                    await restoreBackup(store, pending, 'merge');
                    setPending(null);
                    refreshDemo();
                  }, 'Backup merged')
                }
              >
                Merge into current data
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  if (window.confirm('Replace ALL data on this device with this backup?')) {
                    void run(async () => {
                      await restoreBackup(store, pending, 'replace');
                      setPending(null);
                      refreshDemo();
                    }, 'Data replaced from backup');
                  }
                }}
              >
                Replace all data
              </button>
              <button type="button" className="btn" onClick={() => setPending(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        <details className="explainer">
          <summary>Storage on this device</summary>
          <p className="small">
            {storageInfo?.persisted === true &&
              'The browser has granted persistent storage, so data is less likely to be cleared automatically.'}
            {storageInfo?.persisted === false &&
              'Storage is “best effort”: the browser may clear it under storage pressure (Safari can remove data for sites not used for a while). Keep backups.'}
            {storageInfo?.persisted === null &&
              'This browser does not report storage persistence. Keep backups.'}
            {storageInfo?.usage !== undefined &&
              ` Using about ${(storageInfo.usage / 1024).toFixed(0)} KB.`}
          </p>
          {storageInfo?.persisted === false && navigator.storage?.persist && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                void run(async () => {
                  const ok = await navigator.storage.persist();
                  setStorageInfo((s) => ({ ...s, persisted: ok }));
                  if (!ok)
                    throw new Error(
                      'The browser declined. Installing the app to your home screen may help.',
                    );
                }, 'Persistent storage granted')
              }
            >
              Ask the browser to keep data
            </button>
          )}
        </details>
      </Card>

      <Card title="Demo data">
        <p className="small">
          Demo records are labelled “Demo” and can be removed without touching your own data. Demo
          data never changes your settings.
        </p>
        <div className="btn-row">
          {demo ? (
            <button
              type="button"
              className="btn"
              onClick={() =>
                void run(async () => {
                  const n = await clearDemoData(store);
                  refreshDemo();
                  setStatus({ tone: 'success', text: `Removed ${n} demo records` });
                })
              }
            >
              Clear demo data
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={() =>
                void run(async () => {
                  await loadDemoData(store, today);
                  refreshDemo();
                }, 'Demo data loaded')
              }
            >
              Load demo data
            </button>
          )}
        </div>
      </Card>

      <Card title="Delete all data">
        <p className="small">
          Permanently removes every account, transaction, goal and setting from this device.
        </p>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            const answer = window.prompt(
              'This cannot be undone. Export a backup first if you might need it.\n\nType DELETE to confirm.',
            );
            if (answer === 'DELETE') {
              void run(async () => {
                await deleteAllData(store);
                refreshDemo();
              }, 'All data deleted');
            }
          }}
        >
          Delete all data…
        </button>
      </Card>
      {statusNode}
    </>
  );
}

export function SettingsPage() {
  const data = useFinanceData();
  const { statusNode, setStatus } = useStatus();
  if (!data) return <Loading />;
  return (
    <>
      <div className="topbar">
        <h1>Settings &amp; import</h1>
      </div>
      <div className="grid">
        <Card title="Budget settings">
          <PlanForm
            key={data.settings.updatedAt}
            data={data}
            onSaved={(m) => setStatus({ tone: 'success', text: m })}
          />
        </Card>
        <Card title="Import transactions">
          <Alert tone="info">
            Statement import (CSV / Excel-compatible, then PDF where it can be read reliably) is the
            next feature being built. Until then, add transactions manually on the Transactions
            page.
          </Alert>
        </Card>
        <Card title="Bank connections">
          <p className="small">
            This app does <strong>not</strong> connect to Capitec or any other bank, and never asks
            for banking usernames, passwords, PINs or OTPs. It cannot read SMS messages or
            notifications on iPhone. A consent-based bank-data provider may be investigated later,
            only after checking that it supports Capitec transaction history, its terms and its
            privacy obligations.
          </p>
        </Card>
        <DataManagement />
        <Card title="About these numbers">
          <p className="small muted">
            Figures are estimates from the data you enter and the assumptions shown with each
            number. They are not financial advice, and business figures are not formal accounting or
            tax results.
          </p>
        </Card>
      </div>
      {statusNode}
    </>
  );
}
