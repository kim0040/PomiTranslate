import type { TranslationCounts, TranslationPageMeta, TranslationRow } from '../api';

export type Page = 'workspace' | 'backups' | 'settings' | 'about' | 'help';
export type Step = 'world' | 'scan' | 'review' | 'run' | 'result';
export type Busy = '' | 'loading' | 'scan' | 'translate' | 'restore' | 'models' | 'prompt' | 'settings' | 'usage';
export type Tone = 'info' | 'success' | 'error';
export type ToastAction = { label: string; run: () => void };
export type UpdateState = 'idle' | 'checking' | 'installing' | 'error';

/** What a running translate-type operation is, so the progress screen can say it. */
export type Operation = 'translate' | 'resume' | 'retry' | 'apply' | 'reapply';

/** The full list of failed rows the result screen shows, loaded from the saved table. */
export type FailureList = {
  loading: boolean;
  /** Null until known; false when the sidecar holds no saved table for this job. */
  checkpoint: boolean | null;
  rows: TranslationRow[];
  total: number;
  counts: TranslationCounts | null;
  meta: TranslationPageMeta | null;
};

export const emptyFailures = (): FailureList => ({ loading: false, checkpoint: null, rows: [], total: 0, counts: null, meta: null });

export const STEPS: Step[] = ['world', 'scan', 'review', 'run', 'result'];

export function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value !== '' && value !== null && value !== undefined ? parsed : fallback;
}
