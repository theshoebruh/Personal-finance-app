import { useState, type FormEvent } from 'react';
import { useApp, useFinanceData } from '@/app/AppContext';
import {
  BUCKET_GROUP,
  BUCKET_LABELS,
  BUCKETS,
  type Bucket,
  type Category,
  type SpendingBucket,
} from '@/domain/models';
import { bucketTargets } from '@/domain/calculations/buckets';
import {
  addCategory,
  addSuggestedCategories,
  missingSuggestions,
  moveCategory,
  renameCategory,
  setCategoryArchived,
  setGroupTargets,
} from '@/services/categoriesService';
import { Alert, Card, Loading, useStatus } from '@/components/ui';
import { PageHeader } from '@/components/PageHeader';
import { BUCKET_HINT } from '../home/useBuckets';

const SPENDING: SpendingBucket[] = ['needs', 'wants', 'savings', 'rf'];

function GoalsForm({
  initial,
  onSave,
}: {
  initial: Record<Bucket, number>;
  onSave: (t: Record<Bucket, number>) => void;
}) {
  const [values, setValues] = useState(() =>
    Object.fromEntries(BUCKETS.map((b) => [b, String(initial[b])])),
  );
  const parsed = Object.fromEntries(BUCKETS.map((b) => [b, Number(values[b])])) as Record<
    Bucket,
    number
  >;
  const total = Math.round(BUCKETS.reduce((s, b) => s + (parsed[b] || 0), 0) * 100) / 100;
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSave(parsed);
      }}
    >
      <div className="goal-inputs">
        {BUCKETS.map((b) => (
          <label key={b} className="goal-input">
            <span>{BUCKET_LABELS[b]}</span>
            <span className="input-suffix">
              <input
                inputMode="decimal"
                value={values[b]}
                aria-label={`${BUCKET_LABELS[b]} goal (% of income)`}
                onChange={(e) => setValues((v) => ({ ...v, [b]: e.target.value }))}
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

function CategoryRow({
  cat,
  bucket,
  run,
}: {
  cat: Category;
  bucket: SpendingBucket | 'income';
  run: ReturnType<typeof useStatus>['run'];
}) {
  const { store } = useApp();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(cat.name);
  return (
    <li className="cat-row">
      {editing ? (
        <form
          className="cat-rename"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await renameCategory(store, cat.id, name);
              setEditing(false);
            }, 'Renamed');
          }}
        >
          <input
            value={name}
            autoFocus
            aria-label={`New name for ${cat.name}`}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="btn btn-sm btn-primary">
            Save
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setName(cat.name);
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </form>
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
            {bucket !== 'income' && (
              <>
                <label className="visually-hidden" htmlFor={`move-${cat.id}`}>
                  Group for {cat.name}
                </label>
                <select
                  id={`move-${cat.id}`}
                  className="select-sm"
                  value={bucket}
                  onChange={(e) =>
                    void run(
                      () => moveCategory(store, cat.id, e.target.value as SpendingBucket),
                      `${cat.name} moved to ${BUCKET_LABELS[e.target.value as Bucket]}`,
                    )
                  }
                >
                  {SPENDING.map((b) => (
                    <option key={b} value={b}>
                      {BUCKET_LABELS[b]}
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

function AddCategory({
  bucket,
  run,
}: {
  bucket: SpendingBucket | 'income';
  run: ReturnType<typeof useStatus>['run'];
}) {
  const { store } = useApp();
  const [name, setName] = useState('');
  const label = bucket === 'income' ? 'Income' : BUCKET_LABELS[bucket];
  return (
    <form
      className="cat-add"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await addCategory(store, { name, bucket });
          setName('');
        }, `Added to ${label}`);
      }}
    >
      <input
        value={name}
        placeholder={bucket === 'wants' ? 'e.g. Sports' : 'New category'}
        aria-label={`New ${label} category`}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" className="btn btn-sm" disabled={!name.trim()}>
        Add
      </button>
    </form>
  );
}

export function CategoriesPage() {
  const { store } = useApp();
  const data = useFinanceData();
  const { run, statusNode } = useStatus();
  if (!data) return <Loading />;
  // Business-workspace categories belong to the hidden Business feature.
  const visible = data.categories.filter((c) => c.workspace !== 'business');
  const inGroup = (group: Category['group']) =>
    visible
      .filter((c) => !c.archived && c.group === group)
      .sort((a, b) => a.name.localeCompare(b.name));
  const hidden = visible.filter((c) => c.archived).sort((a, b) => a.name.localeCompare(b.name));
  const suggestions = missingSuggestions(data.categories);

  return (
    <>
      <PageHeader title="Categories" subtitle="Your five groups and what goes in each" />

      <Card title="Group goals">
        <p className="small muted">
          How much of your income each group should get. Buffer is what you keep unspent.
        </p>
        <GoalsForm
          key={data.settings.updatedAt}
          initial={bucketTargets(data.settings)}
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
                void run(async () => {
                  const n = await addSuggestedCategories(store);
                  return n;
                }, 'Suggested categories added')
              }
            >
              Add them
            </button>
          }
        >
          {suggestions.length} suggested categories (like Gym, Snacks, Sports and RF costs) aren’t
          in your list yet.
        </Alert>
      )}

      {SPENDING.map((b) => {
        const cats = inGroup(BUCKET_GROUP[b]);
        return (
          <Card key={b} title={`${BUCKET_LABELS[b]} · ${cats.length}`}>
            <p className="xs faint">{BUCKET_HINT[b]}</p>
            <ul className="list cat-list">
              {cats.map((c) => (
                <CategoryRow key={c.id} cat={c} bucket={b} run={run} />
              ))}
            </ul>
            <AddCategory bucket={b} run={run} />
          </Card>
        );
      })}

      <Card title={`Income · ${inGroup('income').length}`}>
        <ul className="list cat-list">
          {inGroup('income').map((c) => (
            <CategoryRow key={c.id} cat={c} bucket="income" run={run} />
          ))}
        </ul>
        <AddCategory bucket="income" run={run} />
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
