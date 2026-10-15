import { nowIso } from '@/domain/dates';

export function newId(): string {
  return crypto.randomUUID();
}

/** Clock is injectable so tests are deterministic. */
export interface Clock {
  now(): string;
}

export const systemClock: Clock = { now: () => nowIso() };

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}
