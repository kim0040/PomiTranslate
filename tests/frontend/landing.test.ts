import { describe, expect, it } from 'vitest';

import { landingSummary, latestTranslationBackup, type LandingInput } from '../../src/lib/landing';

const none: LandingInput = { scan: null, scanAt: 0, result: null, resultAt: 0, backups: [], resume: null };

describe('landing summary of the open world', () => {
  it('is empty for a world nobody has touched', () => {
    expect(landingSummary(none)).toEqual({ scan: null, translation: null, resume: null });
  });

  it('reports the scan on hand with its time, or without one when it is unknown', () => {
    expect(landingSummary({ ...none, scan: { candidateCount: 69 }, scanAt: 1_790_000_000_000 }).scan).toEqual({ at: 1_790_000_000_000, count: 69 });
    expect(landingSummary({ ...none, scan: { candidateCount: 3 }, scanAt: 0 }).scan).toEqual({ at: 0, count: 3 });
  });

  it('prefers this session\'s result, then the newest translation backup, and ignores recovery copies', () => {
    const backups = [
      { kind: 'recovery' as const, createdAt: '2026-10-02T09:00:00+09:00', fileCount: 9 },
      { kind: 'translation' as const, createdAt: '2026-09-28T09:00:00+09:00', fileCount: 5 },
      { kind: 'translation' as const, createdAt: '2026-09-29T16:24:18+09:00', fileCount: 69 }
    ];
    expect(latestTranslationBackup(backups)?.fileCount).toBe(69);
    expect(landingSummary({ ...none, backups }).translation).toEqual({ kind: 'backup', at: Date.parse('2026-09-29T16:24:18+09:00'), files: 69 });
    expect(landingSummary({ ...none, backups, result: { status: 'partial', changedFileCount: 4 }, resultAt: 5 }).translation)
      .toEqual({ kind: 'result', status: 'partial', at: 5, files: 4 });
    expect(landingSummary({ ...none, backups: [backups[0]] }).translation).toBeNull();
  });

  it('describes a job that can be continued', () => {
    expect(landingSummary({ ...none, resume: { status: 'cancelled', translatedCount: 12 } }).resume).toEqual({ translated: 12, cancelled: true });
    expect(landingSummary({ ...none, resume: { status: 'needs_retry' } }).resume).toEqual({ translated: 0, cancelled: false });
  });
});
