import {
  BackendError,
  callBackend,
  type GlossaryDocument,
  type GlossaryEntry,
  type GlossaryExportResult,
  type GlossaryImportResult,
  type GlossaryMode,
  type GlossaryScope,
  type TranslationWarningSample
} from './api';
import casefoldTable from './glossary-casefold.json';

/** The limits the core enforces (mwt/glossary.py); checking them here only saves a round trip. */
export const GLOSSARY_LIMIT = 2000;
export const MAX_SOURCE_CHARS = 200;
export const MAX_TARGET_CHARS = 200;
export const MAX_NOTE_CHARS = 300;
/** The core refuses a longer import text. */
export const MAX_IMPORT_CHARS = 2 * 1024 * 1024;

// Every limit above counts Unicode characters (Python `len`), not UTF-16 units: one emoji is one.
/** The number of Unicode code points in `text`. */
export function charCount(text: string): number {
  // Up to two units per character, so a short string needs no walk.
  if (text.length <= 1) return text.length;
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** The first `max` Unicode characters of `text`; it never cuts a surrogate pair in two. */
export function truncateChars(text: string, max: number): string {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join('');
}

// The characters whose full case folding is not their lowercase form (ß -> ss, ς -> σ, ligatures, ...).
// Generated from Python's `str.casefold()`; tests/test_glossary_fold.py checks the table against it.
const CASEFOLD_EXTRA = new Map<string, string>(Object.entries(casefoldTable.map));

/**
 * The folded form of a source, the same as the core's `fold_key` (`str.casefold()`): lowercase, then the
 * characters where folding differs from lowercase. Lowercasing first also covers the rest of Unicode;
 * a final sigma comes out as ς and the table turns it into σ like Python.
 */
export function foldKey(text: string): string {
  let folded = '';
  for (const char of text.toLowerCase()) folded += CASEFOLD_EXTRA.get(char) ?? char;
  return folded;
}

type Named = { source: string; caseSensitive: boolean };

/**
 * Whether two entries cannot both be in one list, as the core decides it: equal folded sources, unless
 * both are case-sensitive and differ in spelling ("Mira" and "mira"). An entry that ignores case claims
 * every spelling. The sources are compared as they are saved, trimmed. The core stays the judge; this
 * only saves a round trip.
 */
export function sourcesClash(a: Named, b: Named): boolean {
  const left = a.source.trim();
  const right = b.source.trim();
  return foldKey(left) === foldKey(right) && !(a.caseSensitive && b.caseSensitive && left !== right);
}

export type FieldName = 'source' | 'target' | 'note';
export type ProblemReason = 'required' | 'tooLong' | 'control' | 'duplicate' | 'targetRequired';
export type EntryProblem = { key: string; field: FieldName; reason: ProblemReason };

/** An entry being edited: `key` identifies the row on screen (it survives edits), `id` is the stored id. */
export type DraftEntry = { key: string; id: string; source: string; target: string; mode: GlossaryMode; caseSensitive: boolean; note: string };

let serial = 0;
export function newKey(): string {
  serial += 1;
  return `g${serial}`;
}

export function toDraft(entry: GlossaryEntry): DraftEntry {
  return {
    key: newKey(), id: entry.id ?? '', source: entry.source ?? '', target: entry.target ?? '',
    mode: entry.mode === 'keep' ? 'keep' : 'translate', caseSensitive: entry.caseSensitive === true, note: entry.note ?? ''
  };
}

export function blankDraft(init: Partial<DraftEntry> = {}): DraftEntry {
  return { key: newKey(), id: '', source: '', target: '', mode: 'translate', caseSensitive: false, note: '', ...init };
}

function isBlank(draft: DraftEntry): boolean {
  return !draft.source.trim() && !draft.target.trim() && !draft.note.trim();
}

/** What is sent for a row: trimmed, a keep entry has no target. A row without an id gets the core's. */
export function fromDraft(draft: DraftEntry): Omit<GlossaryEntry, 'id'> & { id?: string } {
  const entry = {
    source: draft.source.trim(), target: draft.mode === 'keep' ? '' : draft.target.trim(), mode: draft.mode,
    caseSensitive: draft.caseSensitive, note: draft.note.trim()
  };
  return draft.id ? { id: draft.id, ...entry } : entry;
}

/** The rows that are saved: untouched blank rows are dropped, not reported. */
export function savableDrafts(drafts: DraftEntry[]): DraftEntry[] {
  return drafts.filter((draft) => !isBlank(draft));
}

const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;
// A note may hold line breaks and tabs; any other control character is refused.
const NOTE_CONTROL = /[^\P{Cc}\n\t]|[\p{Zl}\p{Zp}]/u;

/** Every rule the core checks, per field, in row order. */
export function validateDrafts(drafts: DraftEntry[]): EntryProblem[] {
  const problems: EntryProblem[] = [];
  // Sources taken so far, by folded form: only entries sharing one can clash.
  const seen = new Map<string, Named[]>();
  for (const draft of savableDrafts(drafts)) {
    const source = draft.source.trim();
    const target = draft.mode === 'keep' ? '' : draft.target.trim();
    const note = draft.note.trim();
    if (!source) problems.push({ key: draft.key, field: 'source', reason: 'required' });
    else if (charCount(source) > MAX_SOURCE_CHARS) problems.push({ key: draft.key, field: 'source', reason: 'tooLong' });
    else if (CONTROL.test(source)) problems.push({ key: draft.key, field: 'source', reason: 'control' });
    else {
      const name = { source, caseSensitive: draft.caseSensitive };
      const folded = foldKey(source);
      const taken = seen.get(folded) ?? [];
      if (taken.some((other) => sourcesClash(other, name))) problems.push({ key: draft.key, field: 'source', reason: 'duplicate' });
      else seen.set(folded, [...taken, name]);
    }
    if (draft.mode === 'translate' && !target) problems.push({ key: draft.key, field: 'target', reason: 'targetRequired' });
    else if (charCount(target) > MAX_TARGET_CHARS) problems.push({ key: draft.key, field: 'target', reason: 'tooLong' });
    else if (CONTROL.test(target)) problems.push({ key: draft.key, field: 'target', reason: 'control' });
    if (charCount(note) > MAX_NOTE_CHARS) problems.push({ key: draft.key, field: 'note', reason: 'tooLong' });
    else if (NOTE_CONTROL.test(note)) problems.push({ key: draft.key, field: 'note', reason: 'control' });
  }
  return problems;
}

/** A comparable form of what would be saved, for "are there unsaved changes". */
export function snapshot(drafts: DraftEntry[]): string {
  return JSON.stringify(savableDrafts(drafts).map(fromDraft));
}

/**
 * Rows whose source, target or note contains the text (case-insensitive). An empty query keeps
 * everything. Rows still being typed (`pinned` keys, and empty rows) stay, so a new row does not
 * vanish mid-edit.
 */
export function filterDrafts(drafts: DraftEntry[], query: string, pinned: readonly string[] = []): DraftEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return drafts;
  return drafts.filter((draft) => pinned.includes(draft.key) || isBlank(draft)
    || `${draft.source}\n${draft.target}\n${draft.note}`.toLocaleLowerCase().includes(needle));
}

type EntryField = FieldName | 'mode' | 'id' | 'caseSensitive';
export type InvalidLocation =
  | { kind: 'entry'; index: number; field: EntryField }
  | { kind: 'document'; field: string };

/**
 * Where a GLOSSARY_INVALID message points. The core starts the message with a field path such as
 * `entries[3].source: is longer than 200 characters`; only the path is used, never the English rest.
 */
export function parseInvalidPath(message: string): InvalidLocation | null {
  const head = /^([^\s:]+):/.exec(message.trim());
  if (!head) return null;
  const entry = /^entries\[(\d+)\]\.(\w+)$/.exec(head[1]);
  if (entry) return { kind: 'entry', index: Number(entry[1]), field: entry[2] as EntryField };
  return { kind: 'document', field: head[1] };
}

export const SKIP_REASONS = [
  'empty_source', 'source_too_long', 'target_too_long', 'note_too_long', 'control_character', 'invalid_mode',
  'missing_target', 'invalid_case_sensitive', 'duplicate_in_file', 'limit'
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
export function isSkipReason(value: unknown): value is SkipReason {
  return typeof value === 'string' && (SKIP_REASONS as readonly string[]).includes(value);
}

/** Warning codes the glossary work adds to a run. */
export const QUALITY_WARNING_CODES = ['glossary_mismatch', 'format_residue', 'glossary_truncated'] as const;
export function isQualityWarningCode(value: string): boolean {
  return (QUALITY_WARNING_CODES as readonly string[]).includes(value);
}

/** Whole warning counts for display: known codes first, then any other code the core adds. */
export function warningRows(counts: Record<string, number> | undefined): { code: string; count: number }[] {
  if (!counts) return [];
  const rows = Object.entries(counts)
    .map(([code, count]) => ({ code, count: Math.floor(Number(count)) }))
    .filter((row) => Number.isFinite(row.count) && row.count > 0);
  const rank = (code: string) => {
    const index = (QUALITY_WARNING_CODES as readonly string[]).indexOf(code);
    return index < 0 ? QUALITY_WARNING_CODES.length : index;
  };
  return rows.sort((a, b) => rank(a.code) - rank(b.code));
}

export function warningTotal(counts: Record<string, number> | undefined): number {
  return warningRows(counts).reduce((sum, row) => sum + row.count, 0);
}

/** The few samples the result screen shows. */
export const WARNING_SAMPLE_LIMIT = 5;
export function shownWarningSamples(samples: TranslationWarningSample[] | undefined): TranslationWarningSample[] {
  return (samples ?? [])
    .filter((item) => item && typeof item.source === 'string' && typeof item.translated === 'string' && typeof item.code === 'string')
    .slice(0, WARNING_SAMPLE_LIMIT);
}

/** `global:<id>` or `world:<id>` (the core names the list); a bare id still works and means either list. */
export function splitEntryId(entryId: string): { scope: GlossaryScope | null; id: string } {
  const match = /^(global|world):(.+)$/.exec(entryId);
  return match ? { scope: match[1] as GlossaryScope, id: match[2] } : { scope: null, id: entryId };
}

/** The entry a sample missed, when it still exists in the list the warning names. */
export function entryForSample(entries: GlossaryEntry[] | Partial<Record<GlossaryScope, GlossaryEntry[]>>, sample: TranslationWarningSample): GlossaryEntry | null {
  if (!sample.entryId) return null;
  const { scope, id } = splitEntryId(sample.entryId);
  const lists = Array.isArray(entries) ? [entries] : scope ? [entries[scope] ?? []] : [entries.world ?? [], entries.global ?? []];
  for (const list of lists) {
    const found = list.find((entry) => entry.id === id);
    if (found) return found;
  }
  return null;
}

// --- requests ----------------------------------------------------------------------------------

function scopePayload(scope: GlossaryScope, worldDir: string): Record<string, unknown> {
  return scope === 'world' ? { scope, worldDir } : { scope };
}

function cleanDocument(document: GlossaryDocument, scope: GlossaryScope): GlossaryDocument {
  return {
    scope,
    revision: Number.isInteger(document?.revision) ? document.revision : 0,
    updatedAt: typeof document?.updatedAt === 'string' ? document.updatedAt : null,
    entries: Array.isArray(document?.entries) ? document.entries : []
  };
}

export async function loadGlossary(scope: GlossaryScope, worldDir: string): Promise<GlossaryDocument> {
  return cleanDocument(await callBackend<GlossaryDocument>('glossary.get', scopePayload(scope, worldDir)), scope);
}

const BUSY_RETRIES = 2;
const BUSY_DELAY_MS = 350;

/**
 * Save the whole list. GLOSSARY_BUSY means another save of the same glossary was in progress; it is
 * tried again a couple of times before the failure is shown, and the person's edits stay as they are.
 */
export async function saveGlossary(scope: GlossaryScope, worldDir: string, baseRevision: number, entries: unknown[]): Promise<GlossaryDocument> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return cleanDocument(await callBackend<GlossaryDocument>('glossary.set', { ...scopePayload(scope, worldDir), baseRevision, entries }), scope);
    } catch (cause) {
      if (cause instanceof BackendError && cause.code === 'GLOSSARY_BUSY' && attempt < BUSY_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, BUSY_DELAY_MS * (attempt + 1)));
        continue;
      }
      throw cause;
    }
  }
}

export async function importGlossary(
  scope: GlossaryScope, worldDir: string, baseRevision: number, text: string, format: 'csv' | 'tsv', mode: 'merge' | 'replace'
): Promise<GlossaryImportResult> {
  const result = await callBackend<GlossaryImportResult>('glossary.import', { ...scopePayload(scope, worldDir), baseRevision, text, format, mode });
  return {
    ...cleanDocument(result, scope),
    added: result.added ?? 0, updated: result.updated ?? 0, unchanged: result.unchanged ?? 0, removed: result.removed ?? 0,
    skipped: Array.isArray(result.skipped) ? result.skipped : [], skippedCount: result.skippedCount ?? (result.skipped?.length ?? 0)
  };
}

export async function exportGlossary(scope: GlossaryScope, worldDir: string, format: 'csv' | 'tsv'): Promise<GlossaryExportResult> {
  return callBackend<GlossaryExportResult>('glossary.export', { ...scopePayload(scope, worldDir), format });
}

/** The file type of an import, from its name: tab-separated for .tsv/.tab, comma-separated otherwise. */
export function formatFromName(name: string): 'csv' | 'tsv' {
  return /\.(tsv|tab)$/i.test(name) ? 'tsv' : 'csv';
}

export type AddResult = { status: 'added' | 'exists'; existing?: GlossaryEntry; document: GlossaryDocument };

/**
 * Append one entry to the stored glossary of a scope (the review screen's "Add to glossary"). The
 * saved list is read first, so a rule the person already has is reported instead of doubled. A stale
 * revision (GLOSSARY_CONFLICT) is retried once from the fresh list: nothing the person typed is lost,
 * because only this one entry is being added.
 */
export async function addGlossaryEntry(scope: GlossaryScope, worldDir: string, entry: DraftEntry): Promise<AddResult> {
  for (let attempt = 0; ; attempt += 1) {
    const document = await loadGlossary(scope, worldDir);
    const existing = document.entries.find((item) => sourcesClash(item, entry));
    if (existing) return { status: 'exists', existing, document };
    if (document.entries.length >= GLOSSARY_LIMIT) throw new BackendError('limit', 'GLOSSARY_INVALID', '', 'core');
    try {
      const saved = await saveGlossary(scope, worldDir, document.revision, [...document.entries, fromDraft({ ...entry, id: '' })]);
      return { status: 'added', document: saved };
    } catch (cause) {
      if (cause instanceof BackendError && cause.code === 'GLOSSARY_CONFLICT' && attempt < 1) continue;
      throw cause;
    }
  }
}

/** The file name offered for an export; the shell accepts exactly `pomi-glossary-(global|world).(csv|tsv)`. */
export function exportFileName(scope: GlossaryScope, format: 'csv' | 'tsv'): string {
  return `pomi-glossary-${scope}.${format}`;
}

/** A sentence or a selected part of it as a glossary source: one line, at most the allowed length. */
export function seedSource(text: string): string {
  return truncateChars(text.replace(/\s+/g, ' ').trim(), MAX_SOURCE_CHARS).trim();
}
