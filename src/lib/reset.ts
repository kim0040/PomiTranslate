import type { NativeResetOutcome } from './api';

/** What is still left after the shell's half of "reset the app", when it did not fully work. */
export type ResetShortfall = {
  /** Saved keys were asked for and are not all gone (or not confirmed gone). */
  keys: boolean;
  /** Some key stores were emptied already, so a retry finishes the job rather than starting it. */
  keysPartial: boolean;
  /** The saved run reports are still there. */
  reports: boolean;
  /** Stable codes of what failed, in the order the shell gave them, without repeats. */
  errors: string[];
};

/**
 * The page resets the core's own data only when the shell's half fully worked: the run reports are
 * gone and, when keys were asked for, every key store is confirmed empty. Anything else returns what
 * is left so the person can see it and try again; an unknown answer is never counted as done.
 */
export function assessReset(outcome: NativeResetOutcome, clearKeys: boolean): ResetShortfall | null {
  const keys = clearKeys && !outcome.keysDeleted;
  const reports = !outcome.reportsCleared;
  if (!keys && !reports) return null;
  return {
    keys,
    keysPartial: keys && outcome.keysPartiallyDeleted === true,
    reports,
    errors: [...new Set(outcome.errors)]
  };
}
