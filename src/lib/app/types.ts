import type { TranslationCounts, TranslationPageMeta, TranslationRow } from '../api';

export type Page = 'workspace' | 'backups' | 'glossary' | 'settings' | 'about' | 'help';
export type Step = 'world' | 'scan' | 'review' | 'run' | 'result';
export type Busy = '' | 'loading' | 'scan' | 'translate' | 'restore' | 'recovery' | 'prompt' | 'settings' | 'usage';
export type Tone = 'info' | 'success' | 'error';
export type ToastAction = { label: string; run: () => void };
export type Toast = { id: number; tone: Tone; message: string; ms: number; action?: ToastAction };
export type UpdateState = 'idle' | 'checking' | 'installing' | 'error';
/** Why Start is unavailable, in the order the screens explain it. */
export type RunBlocker = 'recovery' | 'credential' | 'interrupted' | 'model' | 'key';
/** What a pending question about dropping an unsaved review is about. */
export type DiscardReason = 'world' | 'restore' | 'forget' | 'rescan' | 'settings';
export type DraftState = 'idle' | 'saving' | 'saved' | 'error';

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

/** Backend calls whose type the core does not know yet (an older core) fail with these codes. */
export const UNKNOWN_COMMAND_CODES = ['UNSUPPORTED_REQUEST', 'UNKNOWN_REQUEST', 'UNKNOWN_MESSAGE'];

export function samePath(a: string, b: string): boolean {
  const norm = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return !!a && !!b && norm(a) === norm(b);
}
