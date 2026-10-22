import { describe, expect, it } from 'vitest';
import { lastCopyIds, needsForRecovery, prunePlan } from '../../src/lib/backups';
import type { BackupSummary } from '../../src/lib/api';

const set = (id: string, createdAt: string, kind: BackupSummary['kind'], extra: Partial<BackupSummary> = {}): BackupSummary =>
  ({ backupSetId: id, createdAt, fileCount: 1, verified: true, kind, ...extra });

describe('backup rules', () => {
  it('the newest translation set is the last copy until a newer recovery set exists', () => {
    const a = set('a', '2026-10-01T00:00:00Z', 'translation');
    const b = set('b', '2026-10-02T00:00:00Z', 'translation');
    expect([...lastCopyIds([a, b])]).toEqual(['b']);
    expect(lastCopyIds([a, b, set('r', '2026-10-03T00:00:00Z', 'recovery')]).size).toBe(0);
    expect(lastCopyIds([])).toEqual(new Set());
  });

  it('protects sets whose journal is unfinished', () => {
    expect(needsForRecovery(set('x', '2026-10-01', 'translation', { journalState: 'applying' }))).toBe(true);
    expect(needsForRecovery(set('x', '2026-10-01', 'translation', { journalState: 'completed' }))).toBe(false);
    expect(needsForRecovery(set('x', '2026-10-01', 'translation', { journalState: null }))).toBe(false);
    expect(needsForRecovery(set('x', '2026-10-01', 'translation'))).toBe(false);
  });

  it('prunes beyond the newest N but never a protected set or the last copy', () => {
    const list = [
      set('1', '2026-10-01T00:00:00Z', 'translation'),
      set('2', '2026-10-02T00:00:00Z', 'recovery'),
      set('3', '2026-10-03T00:00:00Z', 'translation', { journalState: 'applying' }),
      set('4', '2026-10-04T00:00:00Z', 'translation')
    ];
    const plan = prunePlan(list, 1);
    expect(plan.doomed.map((item) => item.backupSetId)).toEqual(['2', '1']);
    expect(plan.skipped.map((item) => item.backupSetId)).toEqual(['3']);
  });
});
