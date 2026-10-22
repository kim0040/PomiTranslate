import { describe, expect, it } from 'vitest';

import { resultPresentation, emptyProgress, reduceProgress, SAMPLE_CHARS, SAMPLE_LIMIT } from '../../src/lib/workflow';
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
