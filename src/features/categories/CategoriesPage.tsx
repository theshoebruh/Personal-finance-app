import { useState, type FormEvent } from 'react';
import { useApp, useFinanceData } from '@/app/AppContext';
import { type BudgetGroup, type Category, MAX_BUDGET_GROUPS } from '@/domain/models';
import { GROUP_IDS } from '@/domain/defaults';
import { groupIdForCategory } from '@/domain/calculations/buckets';
import {
  addCategory,
  addGroup,
  addSuggestedCategories,
  deleteGroup,
  missingSuggestions,
  moveCategory,
  renameCategory,
  renameGroup,
  setCategoryArchived,
  setGroupTargets,
} from '@/services/categoriesService';
import { Alert, Card, Loading, useStatus } from '@/components/ui';
import { useConfirm } from '@/components/ConfirmDialog';
import { PageHeader } from '@/components/PageHeader';
import { groupColour, groupHint } from '../home/useBuckets';

type Run = ReturnType<typeof useStatus>['run'];

/** Needs, Wants and Savings can be renamed but not deleted; the leftover group never. */
const BUILT_IN = new Set<string>([GROUP_IDS.needs, GROUP_IDS.wants, GROUP_IDS.savings]);

function GoalsForm({
  groups,
  onSave,
}: {
  groups: BudgetGroup[];
  onSave: (t: Record<string, number>) => void;
}) {
  const [values, setValues] = useState(() =>
    Object.fromEntries(groups.map((g) => [g.id, String(g.targetPercent)])),
  );
  const parsed = Object.fromEntries(groups.map((g) => [g.id, Number(values[g.id] ?? 0)]));
  const total = Math.round(groups.reduce((s, g) => s + (parsed[g.id] || 0), 0) * 100) / 100;
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSave(parsed);
      }}
    >
      <div className="goal-inputs">
        {groups.map((g) => (
          <label key={g.id} className="goal-input">
            <span>
              <span className={`swatch chart-${groupColour(g)}`} aria-hidden="true" /> {g.name}
            </span>
            <span className="input-suffix">
              <input
                inputMode="decimal"
                value={values[g.id] ?? ''}
                aria-label={`${g.name} goal (% of income)`}
                onChange={(e) => setValues((v) => ({ ...v, [g.id]: e.target.value }))}
              />
              %
            </span>
          </label>
        ))}
      </div>
      <div className="row-between">
        <span className={total === 100 ? 'small positive' : 'small negative'} aria-live="polite">
          Total {total}%{total === 100 ? '' : ' — needs to be 100%'}
        </span>
        <button type="submit" className="btn btn-primary" disabled={total !== 100}>
          Save goals
        </button>
      </div>
    </form>
  );
}

function InlineRename({
  value,
  label,
  onSave,
  onCancel,
}: {
  value: string;
  label: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(value);
  return (
    <form
      className="cat-rename"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(name);
      }}
    >
      <input value={name} autoFocus aria-label={label} onChange={(e) => setName(e.target.value)} />
      <button type="submit" className="btn btn-sm btn-primary">
        Save
      </button>
      <button type="button" className="btn btn-sm" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

function CategoryRow({
  cat,
  groupId,
  spending,
  run,
}: {
  cat: Category;
  /** The group it's listed under, or "income". */
  groupId: string;
  spending: BudgetGroup[];
  run: Run;
}) {
  const { store } = useApp();
  const [editing, setEditing] = useState(false);
  return (
    <li className="cat-row">
      {editing ? (
        <InlineRename
          value={cat.name}
          label={`New name for ${cat.name}`}
          onCancel={() => setEditing(false)}
          onSave={(name) =>
            void run(async () => {
              await renameCategory(store, cat.id, name);
              setEditing(false);
            }, 'Renamed')
          }
        />
      ) : (
        <>
          <button
            type="button"
            className="cat-name"
            onClick={() => setEditing(true)}
            aria-label={`Rename ${cat.name}`}
          >
            {cat.name}
          </button>
          <span className="cat-actions">
            {cat.kind === 'expense' && (
              <>
                <label className="visually-hidden" htmlFor={`move-${cat.id}`}>
                  Group for {cat.name}
                </label>
                <select
                  id={`move-${cat.id}`}
                  className="select-sm"
                  value={groupId}
                  onChange={(e) =>
                    void run(
                      () => moveCategory(store, cat.id, e.target.value),
                      `${cat.name} moved to ${spending.find((g) => g.id === e.target.value)?.name ?? 'another group'}`,
                    )
                  }
                >
                  {spending.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </>
            )}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              aria-label={`Hide ${cat.name}`}
              onClick={() =>
                void run(() => setCategoryArchived(store, cat.id, true), `${cat.name} hidden`)
              }
            >
              Hide
            </button>
          </span>
        </>
      )}
    </li>
  );
}

function AddCategory({ groupId, label, run }: { groupId: string; label: string; run: Run }) {
  const { store } = useApp();
  const [name, setName] = useState('');
  return (
    <form
      className="cat-add"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await addCategory(store, { name, groupId });
          setName('');
        }, `Added to ${label}`);
      }}
    >
      <input
        value={name}
        placeholder="New category"
        aria-label={`New ${label} category`}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" className="btn btn-sm" disabled={!name.trim()}>
        Add
      </button>
    </form>
  );
}

function GroupCard({
  group,
  cats,
  spending,
  run,
}: {
  group: BudgetGroup;
  cats: Category[];
  spending: BudgetGroup[];
  run: Run;
}) {
  const { store } = useApp();
  const confirm = useConfirm();
  const [renaming, setRenaming] = useState(false);
  const hint = groupHint(group);
  const canDelete = !BUILT_IN.has(group.id);
  return (
    <Card
      title={`${group.name} · ${cats.length}`}
      action={
        <span className="cat-actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-label={`Rename group ${group.name}`}
            onClick={() => setRenaming(true)}
          >
            Rename
          </button>
          {canDelete && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              aria-label={`Delete group ${group.name}`}
              onClick={() =>
                void (async () => {
                  const ok = await confirm({
                    title: `Delete the ${group.name} group?`,
                    message:
                      group.targetPercent > 0
                        ? `Its ${group.targetPercent}% goal moves to what’s left over. Categories must be moved or hidden first.`
                        : 'Categories must be moved or hidden first.',
                    confirmLabel: 'Delete group',
                    danger: true,
                  });
                  if (ok) await run(() => deleteGroup(store, group.id), `${group.name} deleted`);
                })()
              }
            >
              Delete
            </button>
          )}
        </span>
      }
    >
      {renaming ? (
        <InlineRename
          value={group.name}
          label={`New name for the ${group.name} group`}
          onCancel={() => setRenaming(false)}
          onSave={(name) =>
            void run(async () => {
              await renameGroup(store, group.id, name);
              setRenaming(false);
            }, 'Group renamed')
          }
        />
      ) : (
        hint && <p className="xs faint">{hint}</p>
      )}
      <ul className="list cat-list">
        {cats.map((c) => (
          <CategoryRow key={c.id} cat={c} groupId={group.id} spending={spending} run={run} />
        ))}
      </ul>
      <AddCategory groupId={group.id} label={group.name} run={run} />
    </Card>
  );
}

function AddGroupForm({ run, full }: { run: Run; full: boolean }) {
  const { store } = useApp();
  const [name, setName] = useState('');
  return (
    <Card title="Add a group">
      <p className="small muted">
        For example “Business”, “Car” or “Kids”. New groups start at 0%: give them a share in the
        goals above.
      </p>
      {full ? (
        <p className="small">You have the maximum of {MAX_BUDGET_GROUPS} groups.</p>
      ) : (
        <form
          className="cat-add"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await addGroup(store, { name });
              setName('');
            }, 'Group added');
          }}
        >
          <input
            value={name}
            placeholder="Group name"
            aria-label="New group name"
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="btn btn-sm" disabled={!name.trim()}>
            Add group
          </button>
        </form>
      )}
    </Card>
  );
}

export function CategoriesPage() {
  const { store } = useApp();
  const data = useFinanceData();
  const { run, statusNode } = useStatus();
  if (!data) return <Loading />;
  const groups = data.budgetGroups;
  const spending = groups.filter((g) => g.kind === 'spending');
  const spendingIds = new Set(spending.map((g) => g.id));
  // Business-workspace categories belong to the hidden Business feature unless put in a group.
  const visible = data.categories.filter((c) => c.workspace !== 'business' || c.budgetGroupId);
  const byName = (a: Category, b: Category) => a.name.localeCompare(b.name);
  const inGroup = (groupId: string) =>
    visible
      .filter(
        (c) =>
          !c.archived && c.kind === 'expense' && groupIdForCategory(c, spendingIds) === groupId,
      )
      .sort(byName);
  const ungrouped = visible
    .filter((c) => !c.archived && c.kind === 'expense' && !groupIdForCategory(c, spendingIds))
    .sort(byName);
  const income = visible
    .filter((c) => !c.archived && c.kind === 'income' && !groupIdForCategory(c, spendingIds))
    .sort(byName);
  const incomeInGroups = visible.filter(
    (c) => !c.archived && c.kind === 'income' && groupIdForCategory(c, spendingIds),
  );
  const hidden = visible.filter((c) => c.archived).sort(byName);
  const suggestions = missingSuggestions(data.categories);

  return (
    <>
      <PageHeader title="Categories" subtitle="Your groups and what goes in each" />

      <Card title="Group goals">
        <p className="small muted">
          How much of your income each group should get. The last one is what you keep unspent.
        </p>
        <GoalsForm
          key={groups.map((g) => `${g.id}:${g.targetPercent}`).join('|')}
          groups={groups}
          onSave={(t) => void run(() => setGroupTargets(store, t), 'Goals saved')}
        />
      </Card>

      {suggestions.length > 0 && (
        <Alert
          tone="info"
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                void run(() => addSuggestedCategories(store), 'Suggested categories added')
              }
            >
              Add them
            </button>
          }
        >
          {suggestions.length} suggested categories aren’t in your list yet.
        </Alert>
      )}

      {spending.map((g) => (
        <GroupCard key={g.id} group={g} cats={inGroup(g.id)} spending={spending} run={run} />
      ))}

      {ungrouped.length > 0 && (
        <Card title={`Not in a group · ${ungrouped.length}`}>
          <p className="xs faint">Spending here isn’t counted in any group. Move it to one.</p>
          <ul className="list cat-list">
            {ungrouped.map((c) => (
              <CategoryRow key={c.id} cat={c} groupId="" spending={spending} run={run} />
            ))}
          </ul>
        </Card>
      )}

      <AddGroupForm run={run} full={groups.length >= MAX_BUDGET_GROUPS} />

      <Card title={`Income · ${income.length}`}>
        <ul className="list cat-list">
          {income.map((c) => (
            <CategoryRow key={c.id} cat={c} groupId="income" spending={spending} run={run} />
          ))}
        </ul>
        {incomeInGroups.length > 0 && (
          <p className="xs faint">
            {incomeInGroups.map((c) => c.name).join(', ')}: money coming back into a group, so it
            reduces that group instead of counting as income.
          </p>
        )}
        <AddCategory groupId="income" label="Income" run={run} />
      </Card>

      {hidden.length > 0 && (
        <details className="card hidden-cats">
          <summary>Hidden categories ({hidden.length})</summary>
          <ul className="list">
            {hidden.map((c) => (
              <li key={c.id}>
                <span>{c.name}</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    void run(() => setCategoryArchived(store, c.id, false), `${c.name} shown again`)
                  }
                >
                  Show
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="xs faint">
        Tap a name to rename it. Hiding a category keeps its past transactions; it just isn’t
        offered any more. Transactions move with a category when you change its group.
      </p>
      {statusNode}
    </>
  );
}
