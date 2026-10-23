import { describe, expect, it } from 'vitest';

import { resultPresentation, emptyProgress, reduceProgress, remainingSeconds, roundEta, SAMPLE_CHARS, SAMPLE_LIMIT, type JobProgress } from '../../src/lib/workflow';
import { LOCALES, translate, type MessageKey } from '../../src/lib/i18n/index.svelte';

describe('workflow progress mapping', () => {
  it('maps collect, translate, and write events to the user-facing phases', () => {
    const initial = { ...emptyProgress(), startedAt: 123 };
    const collecting = reduceProgress(initial, { event: 'scan_start', total_files: 18 });
    expect(collecting).toMatchObject({ phase: 'collect', fileTotal: 18, startedAt: 123 });

    const translating = reduceProgress(collecting, {
      event: 'phase_start',
      phase: 'translate',
      total: 42,
      requests_estimate: 7
    });
    expect(translating).toMatchObject({ phase: 'translate', total: 42, done: 0, requestsEstimate: 7 });

    const writing = reduceProgress(translating, { event: 'phase_start', phase: 'write', total: 5 });
    expect(writing).toMatchObject({ phase: 'write', fileIndex: 0, fileTotal: 5 });

    const writingFile = reduceProgress(writing, { event: 'file_start', phase: 'write', index: 3, total: 5 });
    expect(writingFile).toMatchObject({ phase: 'write', fileIndex: 3, fileTotal: 5 });
  });

  it('clears a retry indicator after progress or a completed batch', () => {
    const initial = emptyProgress();
    const retrying = reduceProgress(initial, {
      event: 'translation_batch_error',
      attempt: 2,
      max_attempts: 4
    });
    expect(retrying.retry).toEqual({ attempt: 2, max: 4 });

    const progressed = reduceProgress(retrying, {
      event: 'translation_progress',
      completed: 3,
      total: 10,
      failed: 1,
      batch: 2,
      batches: 4,
      requests: 2
    });
    expect(progressed.retry).toBeNull();
    expect(progressed).toMatchObject({ phase: 'translate', done: 3, total: 10, failed: 1, batch: 2, batches: 4, requests: 2 });

    const retryingAgain = reduceProgress(progressed, { event: 'translation_batch_error', attempt: 1, max_attempts: 4 });
    const batchDone = reduceProgress(retryingAgain, { event: 'translation_batch_done' });
    expect(batchDone.retry).toBeNull();
  });

  it('returns the same state for unknown raw events', () => {
    const current = { ...emptyProgress(), phase: 'translate' as const, done: 8, retry: { attempt: 1, max: 3 } };
    const next = reduceProgress(current, { event: 'translation_batch_start' });
    expect(next).toBe(current);
    expect(next).toEqual(current);
  });
});

describe('result status presentation', () => {
  it('maps every backend status to a localized known status', () => {
    const statuses = ['completed', 'partial', 'needs_retry', 'failed', 'cancelled', 'invalidated', 'unsupported', 'locked', 'unknown'];
    const knownStatuses = new Set(['completed', 'partial', 'needs_retry', 'failed', 'cancelled', 'locked', 'invalidated', 'unsupported']);

    for (const status of statuses) {
      const presentation = resultPresentation(status);
      expect(knownStatuses.has(presentation.status), status).toBe(true);
      expect(presentation.status, status).not.toBe('unknown');

      for (const locale of LOCALES) {
        const title = translate(locale, `result.${presentation.status}` as MessageKey);
        expect(title, `${locale}.${status}`).not.toBe(status);
        expect(title, `${locale}.${status}`).not.toBe('');
      }
    }
  });
});

describe('live samples and cost from translation_progress', () => {
  const event = { event: 'translation_progress', completed: 1, total: 9 };

  it('keeps the list bounded: three per event, each side clipped, five on screen', () => {
    let progress = emptyProgress();
    const long = 'x'.repeat(SAMPLE_CHARS + 50);
    for (let round = 0; round < 4; round += 1) {
      const samples = Array.from({ length: 6 }, (_, index) => ({ source: `${round}-${index}`, translated: long }));
      progress = reduceProgress(progress, { ...event, samples });
    }
    expect(progress.samples).toHaveLength(SAMPLE_LIMIT);
    expect(progress.samples.every((item) => item.translated.length === SAMPLE_CHARS)).toBe(true);
    // Only the first three of each event count, and the newest stay.
    expect(progress.samples.map((item) => item.source)).toEqual(['2-1', '2-2', '3-0', '3-1', '3-2']);
  });

  it('ignores samples that are not text', () => {
    const progress = reduceProgress(emptyProgress(), { ...event, samples: [{ source: 1, translated: 'x' }, null, { source: 'a', translated: 'b' }] as never });
    expect(progress.samples).toEqual([{ source: 'a', translated: 'b' }]);
  });

  it('shows a reported cost and never turns "not reported" into 0', () => {
    let progress = reduceProgress(emptyProgress(), { ...event, cost: null });
    expect(progress.cost).toBeNull();
    progress = reduceProgress(progress, { ...event, cost: 0.0123 });
    expect(progress.cost).toBe(0.0123);
    // A later event without a cost leaves what was reported; the running total is not reset.
    progress = reduceProgress(progress, { ...event, cost: null });
    expect(progress.cost).toBe(0.0123);
    expect(reduceProgress(emptyProgress(), { ...event, cost: Number.NaN }).cost).toBeNull();
  });
});

describe('remaining time estimate', () => {
  const START = 1_000_000;
  /** A run of 100 sentences that began translating at START; each pair is [seconds after start, sentences done]. */
  function run(points: [number, number][], total = 100): JobProgress {
    let progress = reduceProgress({ ...emptyProgress(), startedAt: START }, { event: 'phase_start', phase: 'translate', total }, START);
    for (const [seconds, done] of points) {
      progress = reduceProgress(progress, { event: 'translation_progress', completed: done, total }, START + seconds * 1000);
    }
    return progress;
  }
  const steady: [number, number][] = [[10, 12], [20, 24], [30, 36], [40, 48]];

  it('stays hidden before 10% is done, before 20 seconds, and before enough events', () => {
    expect(remainingSeconds(run([[5, 5], [8, 8], [9, 9], [10, 9]], 100), START + 10_000)).toBeNull();
    // 10% and four events, but only 15 s have passed.
    expect(remainingSeconds(run([[3, 10], [6, 11], [9, 12], [15, 13]]), START + 15_000)).toBeNull();
    expect(remainingSeconds(run(steady.slice(0, 3)), START + 30_000)).toBeNull();
    expect(remainingSeconds(emptyProgress(), START)).toBeNull();
  });

  it('gives the time left at the pace so far and counts down between events', () => {
    const progress = run(steady);
    // 48 done in 40 s = 1.2 per second; 52 left = about 43 s.
    expect(remainingSeconds(progress, START + 40_000)).toBeCloseTo(52 / 1.2, 5);
    expect(remainingSeconds(progress, START + 50_000)).toBeCloseTo(52 / 1.2 - 10, 5);
  });

  it('hides the estimate when the recent pace swings away from the overall pace, or the run is overdue', () => {
    const slowing = run([[10, 20], [20, 40], [30, 41], [40, 42], [50, 43]]);
    expect(remainingSeconds(slowing, START + 50_000)).toBeNull();
    const speeding = run([[10, 1], [20, 2], [30, 3], [40, 4], [50, 5], [60, 40], [62, 50], [64, 60], [66, 70]]);
    expect(remainingSeconds(speeding, START + 66_000)).toBeNull();
    // The estimate ran out and no event came: no number rather than a zero.
    expect(remainingSeconds(run(steady), START + 200_000)).toBeNull();
  });

  it('hides the estimate once progress stalls for 3 typical gaps (at least 15 s), and brings it back with fresh progress', () => {
    const progress = run(steady);
    // Events came every 10 s, so 30 s of silence is the limit; the last event was at 40 s.
    expect(remainingSeconds(progress, START + 70_000)).not.toBeNull();
    expect(remainingSeconds(progress, START + 71_000)).toBeNull();
    // The estimate would still have had 10 s left at 80 s without the stall rule; it stays hidden.
    expect(remainingSeconds(progress, START + 80_000)).toBeNull();
    // A new event passes the usual stability checks again: the number returns.
    const resumed = reduceProgress(progress, { event: 'translation_progress', completed: 60, total: 100 }, START + 80_000);
    expect(remainingSeconds(resumed, START + 81_000)).not.toBeNull();
  });

  it('never waits less than 15 s before calling a fast run stalled', () => {
    const fast = run([[5, 12], [10, 24], [15, 36], [20, 48]]);
    expect(remainingSeconds(fast, START + 34_000)).not.toBeNull();
    expect(remainingSeconds(fast, START + 36_000)).toBeNull();
  });

  it('hides the estimate while a retry is reported and while cancelling', () => {
    const progress = run(steady);
    expect(remainingSeconds(progress, START + 45_000)).not.toBeNull();
    const retrying = reduceProgress(progress, { event: 'translation_batch_error', attempt: 1, max_attempts: 3, failure: 'rate_limit' }, START + 42_000);
    expect(remainingSeconds(retrying, START + 45_000)).toBeNull();
    // Fresh progress clears the retry and the estimate is back.
    const after = reduceProgress(retrying, { event: 'translation_progress', completed: 60, total: 100 }, START + 50_000);
    expect(after.retry).toBeNull();
    expect(remainingSeconds(after, START + 51_000)).not.toBeNull();
    expect(remainingSeconds(progress, START + 45_000, true)).toBeNull();
  });

  it('is silent outside the translate phase and when nothing is left', () => {
    expect(remainingSeconds({ ...run(steady), phase: 'write' }, START + 40_000)).toBeNull();
    expect(remainingSeconds(run([[10, 25], [20, 50], [30, 75], [40, 100]]), START + 40_000)).toBeNull();
  });

  it('restarts the pace when the translate phase starts again', () => {
    const again = reduceProgress(run(steady), { event: 'phase_start', phase: 'translate', total: 100 }, START + 60_000);
    expect(again.paceSamples).toEqual([]);
  });

  it('rounds to numbers that do not flicker', () => {
    expect(roundEta(3)).toBe(10);
    expect(roundEta(43.3)).toBe(50);
    expect(roundEta(599)).toBe(600);
    expect(roundEta(601)).toBe(660);
  });
});
