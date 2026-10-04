import type { GlossaryEntry } from './api';
import type { MessageKey } from './i18n/index.svelte';

export type GlossaryRowError = {
  index: number;
  messages: { key: MessageKey; values?: Record<string, string | number> }[];
};

export type GlossaryValidation = { entries: GlossaryEntry[] | null; errors: GlossaryRowError[] };

const MAX_ENTRIES = 2_000;
const MAX_SOURCE = 200;
const MAX_TARGET = 500;
const MAX_NOTE = 500;
const FORMAT_CODE = /§[0-9a-fk-orx]/i;
const length = (value: string) => Array.from(value).length;

/** Mirrors the sidecar's glossary contract and returns localized message keys for the UI. */
export function inspectGlossaryEntries(value: unknown): GlossaryValidation {
  if (!Array.isArray(value)) return { entries: null, errors: [{ index: 0, messages: [{ key: 'glossary.error.entry' }] }] };
  const errors: GlossaryRowError[] = [];
  const normalized: GlossaryEntry[] = [];
  const seen: { source: string; caseSensitive: boolean; index: number }[] = [];

  if (value.length > MAX_ENTRIES) errors.push({ index: MAX_ENTRIES, messages: [{ key: 'glossary.error.limit' }] });

  value.slice(0, MAX_ENTRIES).forEach((raw, index) => {
    const messages: GlossaryRowError['messages'] = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ index, messages: [{ key: 'glossary.error.entry' }] });
      return;
    }
    const item = raw as Partial<GlossaryEntry>;
    let source = typeof item.source === 'string' ? item.source.trim() : '';
    let target = item.target === undefined ? '' : typeof item.target === 'string' ? item.target.trim() : '';
    let mode = item.mode === undefined ? 'translate' : item.mode;
    let note = item.note === undefined ? '' : typeof item.note === 'string' ? item.note.trim() : '';
    let caseSensitive = item.caseSensitive === undefined ? false : item.caseSensitive;

    if (typeof item.source !== 'string') messages.push({ key: 'glossary.error.entry' });
    if (!source) messages.push({ key: 'glossary.error.sourceRequired' });
    if (length(source) > MAX_SOURCE) messages.push({ key: 'glossary.error.sourceLength' });
    if (item.target !== undefined && typeof item.target !== 'string') messages.push({ key: 'glossary.error.entry' });
    if (length(target) > MAX_TARGET) messages.push({ key: 'glossary.error.targetLength' });
    if (mode !== 'translate' && mode !== 'keep') messages.push({ key: 'glossary.error.mode' });
    if (mode === 'translate' && !target) messages.push({ key: 'glossary.error.targetRequired' });
    if (item.note !== undefined && typeof item.note !== 'string') messages.push({ key: 'glossary.error.entry' });
    if (length(note) > MAX_NOTE) messages.push({ key: 'glossary.error.noteLength' });
    if (typeof caseSensitive !== 'boolean') {
      messages.push({ key: 'glossary.error.entry' });
      caseSensitive = false;
    }
    if (FORMAT_CODE.test(source) || FORMAT_CODE.test(target)) messages.push({ key: 'glossary.error.formatCode' });

    const duplicate = seen.find((prior) => source === prior.source || (
      source.toLocaleLowerCase() === prior.source.toLocaleLowerCase() && (!caseSensitive || !prior.caseSensitive)
    ));
    if (duplicate) messages.push({ key: 'glossary.error.duplicate', values: { row: duplicate.index + 1 } });
    if (source && length(source) <= MAX_SOURCE && typeof caseSensitive === 'boolean') seen.push({ source, caseSensitive, index });

    if (messages.length) errors.push({ index, messages });
    else normalized.push({ source, target, mode, note, caseSensitive });
  });

  return { entries: errors.length ? null : normalized, errors };
}
