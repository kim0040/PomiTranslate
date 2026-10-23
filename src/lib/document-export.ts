import { invoke, isTauri } from '@tauri-apps/api/core';
import { fromShellError } from './api';

export type DocumentKind = 'settings' | 'scan_report' | 'translation_report' | 'glossary_csv' | 'glossary_tsv';

const GLOSSARY_TYPES: Partial<Record<DocumentKind, string>> = {
  glossary_csv: 'text/csv;charset=utf-8',
  glossary_tsv: 'text/tab-separated-values;charset=utf-8'
};

/**
 * Native builds use a save dialog; browser fixtures use an ordinary download. A glossary kind carries
 * the exact text of `glossary.export` as `payload` (a string, written as it is, byte-order mark and
 * all); `fileName` is the name the dialog starts with, and the shell accepts only
 * `pomi-glossary-(global|world).(csv|tsv)`. Resolves to false when the dialog was dismissed.
 */
export async function exportDocument(kind: DocumentKind, payload?: unknown, fileName?: string): Promise<boolean> {
  if (isTauri()) {
    try {
      return await invoke<boolean>('export_document', { kind, document: payload ?? null, fileName: fileName ?? null });
    } catch (cause) {
      throw fromShellError(cause);
    }
  }
  const textType = GLOSSARY_TYPES[kind];
  const filename = fileName ?? (kind === 'settings' ? 'pomi-settings.json' : kind === 'scan_report' ? 'scan-report.json'
    : kind === 'translation_report' ? 'translate-report.json' : kind === 'glossary_tsv' ? 'pomi-glossary.tsv' : 'pomi-glossary.csv');
  const body = textType ? String(payload ?? '') : JSON.stringify(payload, null, 2);
  const url = URL.createObjectURL(new Blob([body], { type: textType ?? 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
