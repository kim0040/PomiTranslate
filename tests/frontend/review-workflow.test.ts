import { describe, expect, it } from 'vitest';

import { editErrors, emptyProgress, exceedsCap, reduceProgress, remainingSeconds, RECENT_SAMPLES } from '../../src/lib/workflow';
import { failureKey } from '../../src/lib/failures';
import { hasMessage } from '../../src/lib/i18n/index.svelte';

describe('remaining time and recent translations', () => {
  const translating = (batch: number, done: number, startedAt = 1000) => ({
    ...emptyProgress(), phase: 'translate' as const, total: 100, done, batch, batches: 10, translateStartedAt: startedAt
  });

  it('waits for two finished batches before guessing', () => {
    expect(remainingSeconds(translating(0, 0), 5000)).toBeNull();
    expect(remainingSeconds(translating(1, 10), 5000)).toBeNull();
    // 20 of 100 in 10 s -> 40 s for the other 80.
    expect(remainingSeconds(translating(2, 20), 11000)).toBe(40);
  });

  it('is zero when nothing is left and unknown outside the translate phase', () => {
    expect(remainingSeconds(translating(5, 100), 20000)).toBe(0);
    expect(remainingSeconds({ ...translating(5, 50), phase: 'write' }, 20000)).toBeNull();
  });

  it('keeps only the newest pairs and ignores malformed samples', () => {
    let progress = emptyProgress();
    for (let i = 0; i < RECENT_SAMPLES + 2; i++) progress = reduceProgress(progress, { event: 'translation_sample', source: `s${i}`, translated: `t${i}` });
    expect(progress.samples).toHaveLength(RECENT_SAMPLES);
    expect(progress.samples.at(-1)).toEqual({ source: `s${RECENT_SAMPLES + 1}`, translated: `t${RECENT_SAMPLES + 1}` });
    expect(reduceProgress(progress, { event: 'translation_sample', source: 'x' })).toBe(progress);
  });
});

describe('review helpers', () => {
  it('reads per-row refusals from an EDITS_INVALID error and tolerates other shapes', () => {
    expect(editErrors({ rows: [{ id: 'a', reason: 'tokens' }, { id: 'b', reason: 'odd' }, { reason: 'empty' }] })).toEqual({ a: 'tokens', b: 'invalid' });
    expect(editErrors(null)).toEqual({});
    expect(editErrors({ rows: 'nope' })).toEqual({});
  });

  it('blocks only when the upper bound is above a real cap', () => {
    const estimate = { cost: { high: 2 } };
    expect(exceedsCap(estimate, 1)).toBe(true);
    expect(exceedsCap(estimate, 2)).toBe(false);
    expect(exceedsCap(estimate, 0)).toBe(false);
    expect(exceedsCap({ cost: null }, 1)).toBe(false);
    expect(exceedsCap(null, 1)).toBe(false);
  });

  it('maps every failure code, and anything unknown, to catalog text', () => {
    for (const code of ['timeout', 'auth', 'rate_limit', 'quota', 'invalid_response', 'content_filter', 'network', 'provider_error', 'unknown']) {
      expect(hasMessage(failureKey(code))).toBe(true);
    }
    expect(failureKey('Provider unavailable')).toBe('failure.unknown');
    expect(failureKey(undefined)).toBe('failure.unknown');
  });
});
