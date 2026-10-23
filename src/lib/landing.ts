import type { BackupSummary, ResumeStatus, TranslationResult } from './api';

/**
 * What the app already knows about the world that is open, for the screens a person lands on when
 * they come back: the scan on hand, the last translation, and a job that can be continued.
 * Nothing here asks the core for anything.
 */
export type LandingSummary = {
  /** The scan on screen or restored from a saved job. `at` is a time in ms, 0 when unknown. */
  scan: { at: number; count: number } | null;
  /** The last outcome of this session, else the newest translation backup. */
  translation:
    | { kind: 'result'; status: string; at: number; files: number }
    | { kind: 'backup'; at: number; files: number }
    | null;
  /** A saved job that "continue" would pick up. */
  resume: { translated: number; cancelled: boolean } | null;
};

export type LandingInput = {
  scan: { candidateCount: number } | null;
  scanAt: number;
  result: Pick<TranslationResult, 'status' | 'changedFileCount'> | null;
  resultAt: number;
  backups: Pick<BackupSummary, 'kind' | 'createdAt' | 'fileCount'>[];
  resume: Pick<ResumeStatus, 'status' | 'translatedCount'> | null;
};

/** The newest backup made by a translation (recovery copies are not a translation). */
export function latestTranslationBackup<T extends Pick<BackupSummary, 'kind' | 'createdAt'>>(backups: T[]): T | undefined {
  const time = (backup: T) => { const value = Date.parse(backup.createdAt); return Number.isFinite(value) ? value : 0; };
  return backups.filter((backup) => backup.kind === 'translation').sort((a, b) => time(b) - time(a))[0];
}

export function landingSummary(input: LandingInput): LandingSummary {
  const backup = latestTranslationBackup(input.backups);
  const backupAt = backup ? Date.parse(backup.createdAt) : 0;
  return {
    scan: input.scan ? { at: input.scanAt > 0 ? input.scanAt : 0, count: input.scan.candidateCount } : null,
    translation: input.result
      ? { kind: 'result', status: input.result.status, at: input.resultAt > 0 ? input.resultAt : 0, files: input.result.changedFileCount ?? 0 }
      : backup
        ? { kind: 'backup', at: Number.isFinite(backupAt) ? backupAt : 0, files: backup.fileCount }
        : null,
    resume: input.resume ? { translated: input.resume.translatedCount ?? 0, cancelled: input.resume.status === 'cancelled' } : null
  };
}
