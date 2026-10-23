import type { ProgressEvent } from './api';

/** The last few sentences a run translated, newest last, for the live feed on the run screen. */
export const SAMPLE_LIMIT = 5;
/** What one progress event may add, and how long each side of a sample may be (the core cuts them the same way). */
export const EVENT_SAMPLE_LIMIT = 3;
export const SAMPLE_CHARS = 160;
export const PACE_SAMPLE_LIMIT = 12;
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
  /** [time, sentences done] at each progress event that moved the count; the ETA reads its pace from these. */
  paceSamples: [number, number][];
  /** The file being read or written right now, as the core named it. */
  currentFile: string;
  samples: ProgressSample[];
  /** Money spent so far, when the core reports it. */
  cost: number | null;
  /** Sentences so far whose translation missed a glossary term or left a format code behind, by code. */
  warnings: Record<string, number>;
  /** Set when a resumed run dropped saved translations because the glossary changed; the count dropped. */
  glossaryDropped: number | null;
};

/** Counts per warning code as the core sent them: whole, non-negative numbers only. */
export function cleanWarningCounts(value: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return counts;
  for (const [code, count] of Object.entries(value as Record<string, unknown>)) {
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) counts[code] = Math.floor(count);
  }
  return counts;
}

export function emptyProgress(): JobProgress {
  return {
    phase: 'idle', fileIndex: 0, fileTotal: 0, done: 0, total: 0, failed: 0, batch: 0, batches: 0,
    requests: 0, requestsEstimate: 0, retry: null, startedAt: 0,
    translateStartedAt: 0, paceSamples: [], currentFile: '', samples: [], cost: null, warnings: {}, glossaryDropped: null
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
        next.paceSamples = [];
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
      if (next.done > current.done) next.paceSamples = [...current.paceSamples, [now, next.done] as [number, number]].slice(-PACE_SAMPLE_LIMIT);
      next.total = event.total ?? next.total;
      next.failed = event.failed ?? next.failed;
      next.batch = event.batch ?? next.batch;
      next.batches = event.batches ?? next.batches;
      next.requests = event.requests ?? next.requests;
      next.retry = null;
      if (!next.translateStartedAt) next.translateStartedAt = now;
      // null means the provider reported no cost: nothing is shown, and it never turns into 0.
      if (typeof event.cost === 'number' && Number.isFinite(event.cost) && event.cost >= 0) next.cost = event.cost;
      if (event.warnings) next.warnings = cleanWarningCounts(event.warnings);
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
    case 'checkpoint_glossary_changed':
      next.glossaryDropped = typeof event.dropped_translations === 'number' && event.dropped_translations >= 0 ? Math.floor(event.dropped_translations) : 0;
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

/** The estimate stays hidden until this much is done and this long has passed: the first requests only measure latency. */
export const ETA_MIN_FRACTION = 0.1;
export const ETA_MIN_ELAPSED_SECONDS = 20;
/** Fewest progress events (three gaps) before the pace is trusted, and how far the recent pace may stray from the overall one. */
export const ETA_MIN_SAMPLES = 4;
export const ETA_STABLE_RATIO = 2;

/** A stall is no progress for this many typical gaps, but never less than this many seconds. */
export const ETA_STALL_GAPS = 3;
export const ETA_STALL_MIN_SECONDS = 15;

function medianGapSeconds(samples: [number, number][]): number {
  const gaps: number[] = [];
  for (let at = 1; at < samples.length; at += 1) gaps.push((samples[at][0] - samples[at - 1][0]) / 1000);
  gaps.sort((a, b) => a - b);
  const middle = gaps.length >> 1;
  return gaps.length % 2 ? gaps[middle] : (gaps[middle - 1] + gaps[middle]) / 2;
}

/**
 * Seconds left, from the pace of the sentences finished so far, or null while there is no honest
 * number: before 10% is done and 20 s have passed, while the pace is still swinging (the recent
 * pace is more than twice faster or slower than the overall one), when the run is overdue, when the
 * last progress is older than 3 typical gaps (at least 15 s: a stall), and while a retry is reported
 * or the run is being cancelled (`paused`). After a stall the number returns only once fresh progress
 * passes the same checks. The estimate counts down between events instead of being recomputed from a
 * longer elapsed time.
 */
export function remainingSeconds(progress: JobProgress, now: number, paused: boolean = false): number | null {
  if (paused || progress.retry) return null;
  if (progress.phase !== 'translate' || progress.total <= 0 || !progress.translateStartedAt) return null;
  if (progress.done / progress.total < ETA_MIN_FRACTION || progress.done >= progress.total) return null;
  if ((now - progress.translateStartedAt) / 1000 < ETA_MIN_ELAPSED_SECONDS) return null;
  const samples = progress.paceSamples;
  if (samples.length < ETA_MIN_SAMPLES) return null;
  const [lastAt, lastDone] = samples[samples.length - 1];
  if ((now - lastAt) / 1000 > Math.max(ETA_STALL_GAPS * medianGapSeconds(samples), ETA_STALL_MIN_SECONDS)) return null;
  const [firstAt, firstDone] = samples[samples.length - ETA_MIN_SAMPLES];
  const overall = lastDone / ((lastAt - progress.translateStartedAt) / 1000);
  const recent = (lastDone - firstDone) / ((lastAt - firstAt) / 1000);
  if (!Number.isFinite(overall) || !Number.isFinite(recent) || overall <= 0 || recent <= 0) return null;
  const ratio = recent / overall;
  if (ratio > ETA_STABLE_RATIO || ratio < 1 / ETA_STABLE_RATIO) return null;
  const left = (progress.total - lastDone) / overall - (now - lastAt) / 1000;
  return left > 0 ? left : null;
}

/** The announcement tier: 0, 10, 20 ... so a screen reader hears milestones, not every sentence. */
export function milestone(percent: number | null): number | null {
  return percent === null ? null : Math.min(100, Math.floor(percent / 10) * 10);
}

/** An estimate shown as a round number (10 s steps, then whole minutes), so it does not flicker like a stopwatch. */
export function roundEta(seconds: number): number {
  if (seconds < 600) return Math.max(10, Math.ceil(seconds / 10) * 10);
  return Math.ceil(seconds / 60) * 60;
}
