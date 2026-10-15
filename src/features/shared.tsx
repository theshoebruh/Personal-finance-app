import {
  CATEGORY_GROUPS,
  CATEGORY_GROUP_LABELS,
  type Account,
  type Category,
  type Workspace,
} from '@/domain/models';

/** Category <option>s grouped by budget group, limited to a workspace when given. */
export function CategoryOptions({
  categories,
  workspace,
  kind,
}: {
  categories: readonly Category[];
  workspace?: Workspace | undefined;
  kind?: Category['kind'] | undefined;
}) {
  const usable = categories.filter(
    (c) =>
      !c.archived &&
      (!workspace || c.workspace === 'both' || c.workspace === workspace) &&
      (!kind || c.kind === kind),
  );
  return (
    <>
      {CATEGORY_GROUPS.map((g) => {
        const items = usable
          .filter((c) => c.group === g)
          .sort((a, b) => a.name.localeCompare(b.name));
        if (items.length === 0) return null;
        return (
          <optgroup key={g} label={CATEGORY_GROUP_LABELS[g]}>
            {items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </optgroup>
        );
      })}
    </>
  );
}

export function AccountOptions({
  accounts,
  includeArchived = false,
}: {
  accounts: readonly Account[];
  includeArchived?: boolean;
}) {
  return (
    <>
      {accounts
        .filter((a) => includeArchived || a.active)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
            {a.active ? '' : ' (archived)'}
          </option>
        ))}
    </>
  );
}

export function lookup<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((i) => [i.id, i]));
}
