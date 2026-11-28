import type { RecurringRule } from '@/domain/models';
import type { IsoDate } from '@/domain/dates';
import type { SubscriptionSuggestion } from '@/domain/calculations/subscriptions';
import type { FinanceStore } from '@/data/repositories/types';
import { type Clock, DomainError, systemClock } from './common';
import { saveRecurringRule } from './planningService';

export interface SubscriptionInput {
  id?: string;
  name: string;
  amountCents: number;
  frequency: Extract<RecurringRule['frequency'], 'weekly' | 'monthly' | 'yearly'>;
  /** A due date: the next one, or any past one (later ones follow the frequency). */
  dueDate: IsoDate;
  categoryId: string | null;
}

/** Days either side of the due date in which a payment counts as this occurrence's. */
const MATCH_WINDOW_DAYS = 5;

/** Add or edit a subscription or monthly bill (a recurring expense item). */
export async function saveSubscription(
  store: FinanceStore,
  input: SubscriptionInput,
  clock: Clock = systemClock,
): Promise<RecurringRule> {
  const name = input.name.trim();
  if (!name) throw new DomainError('Give it a name');
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new DomainError('Enter an amount greater than zero');
  }
  const existing = input.id ? await store.recurringRules.get(input.id) : undefined;
  const { categoryId: _old, ...rest } = existing ?? ({} as Partial<RecurringRule>);
  return saveRecurringRule(
    store,
    {
      ...rest,
      ...(existing ? { id: existing.id, settledDates: existing.settledDates } : {}),
      name,
      direction: 'expense',
      amountCents: input.amountCents,
      frequency: input.frequency,
      startDate: input.dueDate,
      ...(input.categoryId ? { categoryId: input.categoryId } : {}),
      workspace: existing?.workspace ?? 'personal',
      active: existing?.active ?? true,
      matchWindowDays: existing?.matchWindowDays ?? MATCH_WINDOW_DAYS,
      alertLeadDays: existing?.alertLeadDays ?? 3,
    },
    { clock },
  );
}

/** Add subscriptions found in the transactions, as monthly items. */
export async function addSuggestedSubscriptions(
  store: FinanceStore,
  suggestions: readonly SubscriptionSuggestion[],
  clock: Clock = systemClock,
): Promise<number> {
  for (const s of suggestions) {
    await saveSubscription(
      store,
      {
        name: s.name,
        amountCents: s.amountCents,
        frequency: 'monthly',
        dueDate: s.lastDate,
        categoryId: s.categoryId,
      },
      clock,
    );
  }
  return suggestions.length;
}

/** Pause (stop expecting it) or resume an item. */
export async function setSubscriptionActive(
  store: FinanceStore,
  id: string,
  active: boolean,
  clock: Clock = systemClock,
): Promise<void> {
  const rule = await store.recurringRules.get(id);
  if (!rule) throw new DomainError('Not found');
  await store.recurringRules.put({ ...rule, active, updatedAt: clock.now() });
}
