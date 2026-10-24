import { describe, expect, it } from 'vitest';

import { editErrors, emptyProgress, exceedsCap, reduceProgress, remainingSeconds, RECENT_SAMPLES } from '../../src/lib/workflow';
import { FAILURE_CODES, failureKey } from '../../src/lib/failures';
import { hasMessage } from '../../src/lib/i18n/index.svelte';

describe('remaining time and recent translations', () => {
  // The pace rules of the estimate (10%, 20 s, four events, a steady pace) are in workflow.test.ts.
  const translating = (done: number) => ({
    ...emptyProgress(), phase: 'translate' as const, total: 100, done, translateStartedAt: 1000,
    // A steady pace: a quarter of the sentences every five seconds.
    paceSamples: [[6000, done / 4], [11000, done / 2], [16000, (done * 3) / 4], [21000, done]] as [number, number][]
  });

  it('is unknown when nothing is left and outside the translate phase', () => {
    expect(remainingSeconds(translating(100), 21000)).toBeNull();
    expect(remainingSeconds({ ...translating(50), phase: 'write' }, 21000)).toBeNull();
    expect(remainingSeconds(translating(50), 21000)).not.toBeNull();
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
    // Both taxonomies: the result list's codes and the review table's.
    for (const code of FAILURE_CODES) expect(hasMessage(failureKey(code)), code).toBe(true);
    expect(failureKey('Provider unavailable')).toBe('result.failure.other');
    expect(failureKey(undefined)).toBe('result.failure.other');
  });
});
