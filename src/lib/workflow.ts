import type { ProgressEvent } from './api';

/** The last few sentences a run translated, newest last, for the live feed on the run screen. */
export const SAMPLE_LIMIT = 5;
/** What one progress event may add, and how long each side of a sample may be (the core cuts them the same way). */
export const EVENT_SAMPLE_LIMIT = 3;
export const SAMPLE_CHARS = 160;
export type ProgressSample = { source: string; translated: string };

export type JobProgress = {
  phase: 'idle' | 'collect' | 'translate' | 'write' | 'recovery';
  fileIndex: number;
  fileTotal: number;
  done: number;
  total: number;
  failed: number;
  batch: number;
  batches: number;
  requests: number;
  requestsEstimate: number;
  retry: { attempt: number; max: number; code?: string } | null;
  startedAt: number;
  /** When sentences started going to the provider; the ETA is measured from here. */
  translateStartedAt: number;
  /** The file being read or written right now, as the core named it. */
  currentFile: string;
  samples: ProgressSample[];
  /** Money spent so far, when the core reports it. */
  cost: number | null;
};

export function emptyProgress(): JobProgress {
  return {
    phase: 'idle', fileIndex: 0, fileTotal: 0, done: 0, total: 0, failed: 0, batch: 0, batches: 0,
    requests: 0, requestsEstimate: 0, retry: null, startedAt: 0,
    translateStartedAt: 0, currentFile: '', samples: [], cost: null
  };
}

/** Convert sidecar event names into the small set of phases the interface explains to people. */
export function reduceProgress(current: JobProgress, event: ProgressEvent, now: number = Date.now()): JobProgress {
  const next = { ...current };
  // A recovery run reports {phase: 'recovery', done, total} under whatever event name the core chose.
  if (event.phase === 'recovery') {
    next.phase = 'recovery';
    next.done = event.done ?? event.completed ?? next.done;
    next.total = event.total ?? next.total;
    return next;
  }
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
      if (event.file) next.currentFile = event.file;
      break;
    case 'phase_start':
      if (event.phase === 'translate') {
        next.phase = 'translate';
        next.translateStartedAt = now;
        next.total = event.total ?? 0;
        next.done = 0;
        next.requestsEstimate = event.requests_estimate ?? 0;
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
      if (!next.translateStartedAt) next.translateStartedAt = now;
      // null means the provider reported no cost: nothing is shown, and it never turns into 0.
      if (typeof event.cost === 'number' && Number.isFinite(event.cost) && event.cost >= 0) next.cost = event.cost;
      if (Array.isArray(event.samples) && event.samples.length) {
        const fresh = event.samples
          .filter((item) => typeof item?.source === 'string' && typeof item?.translated === 'string')
          .slice(0, EVENT_SAMPLE_LIMIT)
          .map((item) => ({ source: item.source.slice(0, SAMPLE_CHARS), translated: item.translated.slice(0, SAMPLE_CHARS) }));
        next.samples = [...next.samples, ...fresh].slice(-SAMPLE_LIMIT);
      } else if (typeof event.source === 'string' && typeof event.translated === 'string') {
        next.samples = [...next.samples, { source: event.source, translated: event.translated }].slice(-SAMPLE_LIMIT);
      }
      break;
    case 'translation_batch_error':
      next.retry = { attempt: event.attempt ?? 1, max: event.max_attempts ?? 1, code: event.failure ?? event.code };
      break;
    case 'translation_batch_done':
      next.retry = null;
      break;
    default:
      return current;
  }
  return next;
}

export type ResultTone = 'success' | 'warning' | 'danger' | 'info';
export type ResultPresentation = {
  status: 'completed' | 'partial' | 'needs_retry' | 'failed' | 'cancelled' | 'locked' | 'invalidated' | 'unsupported';
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
    case 'invalidated': return { status, tone: 'warning', showReason: false };
    case 'unsupported': return { status, tone: 'danger', showReason: false };
    case 'locked': return { status, tone: 'warning', showReason: true };
    case 'failed':
    default:
      return { status: 'failed', tone: 'danger', showReason: true };
  }
}

/** Share of the work done, 0-100, or null when the total is not known yet. */
export function percentDone(progress: JobProgress): number | null {
  if (progress.phase === 'translate' || progress.phase === 'recovery') return progress.total > 0 ? (progress.done / progress.total) * 100 : null;
  return progress.fileTotal > 0 ? (progress.fileIndex / progress.fileTotal) * 100 : null;
}

/**
 * Seconds left, from the pace of the sentences finished so far. Silent until 5% is done: before
 * that the pace is mostly the first request's latency and the guess would swing wildly.
 */
export function remainingSeconds(progress: JobProgress, now: number): number | null {
  if (progress.phase !== 'translate' || progress.total <= 0 || !progress.translateStartedAt) return null;
  if (progress.done / progress.total <= 0.05 || progress.done >= progress.total) return null;
  const elapsed = (now - progress.translateStartedAt) / 1000;
  if (elapsed <= 0) return null;
  return (elapsed / progress.done) * (progress.total - progress.done);
}

/** The announcement tier: 0, 10, 20 ... so a screen reader hears milestones, not every sentence. */
export function milestone(percent: number | null): number | null {
  return percent === null ? null : Math.min(100, Math.floor(percent / 10) * 10);
}
