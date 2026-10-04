import type { ProgressEvent } from './api';

export type JobProgress = {
  phase: 'idle' | 'collect' | 'translate' | 'write';
  fileIndex: number;
  fileTotal: number;
  done: number;
  total: number;
  failed: number;
  batch: number;
  batches: number;
  requests: number;
  requestsEstimate: number;
  retry: { attempt: number; max: number } | null;
  startedAt: number;
  /** When the AI translation phase began, so throughput excludes the collect phase. */
  translateStartedAt: number;
  /** The newest translated pairs, newest last. */
  samples: { source: string; translated: string }[];
};

export const RECENT_SAMPLES = 5;
/** The remaining time is only a fair guess once this many batches have finished. */
export const ETA_MIN_BATCHES = 2;

export function emptyProgress(): JobProgress {
  return {
    phase: 'idle', fileIndex: 0, fileTotal: 0, done: 0, total: 0, failed: 0, batch: 0, batches: 0,
    requests: 0, requestsEstimate: 0, retry: null, startedAt: 0, translateStartedAt: 0, samples: []
  };
}

/** Convert sidecar event names into the small set of phases the interface explains to people. */
export function reduceProgress(current: JobProgress, event: ProgressEvent, now = Date.now()): JobProgress {
  const next = { ...current };
  switch (event.event) {
    case 'scan_start':
      next.phase = 'collect';
      next.fileTotal = event.total_files ?? next.fileTotal;
      break;
    case 'file_start':
    case 'file_done':
      if (event.phase === 'write') next.phase = 'write';
      else if (next.phase === 'idle') next.phase = 'collect';
      next.fileIndex = event.index ?? next.fileIndex;
      next.fileTotal = event.total ?? next.fileTotal;
      break;
    case 'phase_start':
      if (event.phase === 'translate') {
        next.phase = 'translate';
        next.total = event.total ?? 0;
        next.done = 0;
        next.requestsEstimate = event.requests_estimate ?? 0;
        next.translateStartedAt = now;
        next.samples = [];
      } else if (event.phase === 'write') {
        next.phase = 'write';
        next.fileIndex = 0;
        next.fileTotal = event.total ?? 0;
      }
      break;
    case 'translation_progress':
      next.phase = 'translate';
      next.done = event.completed ?? next.done;
      next.total = event.total ?? next.total;
      next.failed = event.failed ?? next.failed;
      next.batch = event.batch ?? next.batch;
      next.batches = event.batches ?? next.batches;
      next.requests = event.requests ?? next.requests;
      next.retry = null;
      break;
    case 'translation_sample':
      if (typeof event.source !== 'string' || typeof event.translated !== 'string') return current;
      next.samples = [...current.samples, { source: event.source, translated: event.translated }].slice(-RECENT_SAMPLES);
      break;
    case 'translation_batch_error':
      next.retry = { attempt: event.attempt ?? 1, max: event.max_attempts ?? 1 };
      break;
    case 'translation_batch_done':
      next.retry = null;
      break;
    default:
      return current;
  }
  return next;
}

/**
 * Seconds left, from the throughput so far. Null until enough batches finished for the rate to mean
 * something (the screen then says it is still calculating), and when nothing more is waiting.
 */
export function remainingSeconds(progress: JobProgress, now: number): number | null {
  if (progress.phase !== 'translate' || progress.batch < ETA_MIN_BATCHES || progress.done <= 0 || !progress.translateStartedAt) return null;
  const left = progress.total - progress.done;
  if (left <= 0) return 0;
  const elapsed = Math.max(0, (now - progress.translateStartedAt) / 1000);
  if (elapsed <= 0) return null;
  return Math.ceil((elapsed / progress.done) * left);
}

export type ResultTone = 'success' | 'warning' | 'danger' | 'info';
export type ResultPresentation = {
  status: 'completed' | 'partial' | 'needs_retry' | 'failed' | 'cancelled' | 'budget_stopped' | 'locked' | 'invalidated' | 'unsupported';
  tone: ResultTone;
  showReason: boolean;
};

/** Unknown backend statuses use the safe failure copy instead of appearing as raw identifiers. */
export function resultPresentation(status: string): ResultPresentation {
  switch (status) {
    case 'completed': return { status, tone: 'success', showReason: false };
    case 'partial': return { status, tone: 'warning', showReason: true };
    case 'needs_retry': return { status, tone: 'warning', showReason: true };
    case 'cancelled': return { status, tone: 'info', showReason: false };
    case 'budget_stopped': return { status, tone: 'warning', showReason: false };
    case 'invalidated': return { status, tone: 'warning', showReason: false };
    case 'unsupported': return { status, tone: 'danger', showReason: false };
    case 'locked': return { status, tone: 'warning', showReason: true };
    case 'failed':
    default:
      return { status: 'failed', tone: 'danger', showReason: true };
  }
}

/** A job whose translations are saved but that can still be continued from its checkpoint. */
export const RESUMABLE_STATUSES = ['awaiting_review', 'budget_stopped', 'cancelled', 'needs_retry', 'failed'];

/** The reasons the translation table can show for an edit the sidecar refused. */
export type EditReason = 'tokens' | 'empty' | 'too_long' | 'invalid';

/** Per-row refusals from an `EDITS_INVALID` error. Unknown shapes are ignored. */
export function editErrors(details: unknown): Record<string, EditReason> {
  const rows = (details as { rows?: unknown } | null)?.rows;
  const out: Record<string, EditReason> = {};
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const { id, reason } = (row ?? {}) as { id?: unknown; reason?: unknown };
    if (typeof id !== 'string') continue;
    out[id] = (['tokens', 'empty', 'too_long', 'invalid'] as const).find((item) => item === reason) ?? 'invalid';
  }
  return out;
}

/** True when the estimate's upper bound is above a nonzero cap. Unknown prices never block. */
export function exceedsCap(estimate: { cost: { high: number } | null } | null | undefined, cap: number | undefined): boolean {
  return !!estimate?.cost && (cap ?? 0) > 0 && estimate.cost.high > (cap ?? 0);
}
