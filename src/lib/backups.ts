import type { BackupSummary } from './api';

/** Journal states that mean the work is finished; anything else belongs to a job recovery may need. */
const FINISHED = new Set(['completed', 'committed', 'rolled_back', 'kept']);

function order(item: BackupSummary): string {
  return `${item.createdAt || ''}\u0000${item.backupSetId}`;
}

/**
 * Sets that are the only way back to the world as it was before translation: the newest
 * "translation" set, unless a newer "recovery" set exists (the world was restored since). The core
 * reports the same list in `usage.lastCopyIds`; this is the fallback for a core that does not.
 */
export function lastCopyIds(backups: BackupSummary[]): Set<string> {
  const translations = backups.filter((item) => item.kind === 'translation');
  if (!translations.length) return new Set();
  const newest = translations.reduce((a, b) => (order(b) > order(a) ? b : a));
  if (backups.some((item) => item.kind === 'recovery' && order(item) > order(newest))) return new Set();
  return new Set([newest.backupSetId]);
}

/** A set an unfinished job or restore may still need: it cannot be deleted. */
export function needsForRecovery(backup: BackupSummary): boolean {
  return backup.journalState !== undefined && backup.journalState !== null && !FINISHED.has(backup.journalState);
}

/** What "keep the newest N" would remove, mirroring the core: it never takes protected or last-copy sets. */
export function prunePlan(backups: BackupSummary[], keep: number, lastCopies: Set<string> = lastCopyIds(backups)): { doomed: BackupSummary[]; skipped: BackupSummary[] } {
  const ordered = [...backups].sort((a, b) => (order(a) < order(b) ? 1 : -1));
  const doomed: BackupSummary[] = [];
  const skipped: BackupSummary[] = [];
  for (const item of ordered.slice(Math.max(0, keep))) {
    if (needsForRecovery(item) || lastCopies.has(item.backupSetId)) skipped.push(item);
    else doomed.push(item);
  }
  return { doomed, skipped };
}
