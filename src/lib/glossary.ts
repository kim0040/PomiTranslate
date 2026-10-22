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

/** The limits the core enforces (mwt/glossary.py); checking them here only saves a round trip. */
export const GLOSSARY_LIMIT = 2000;
export const MAX_SOURCE_CHARS = 200;
export const MAX_TARGET_CHARS = 200;
export const MAX_NOTE_CHARS = 300;
/** The core refuses a longer import text. */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

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

function dedupeKey(draft: DraftEntry): string {
  const source = draft.source.trim();
  return draft.caseSensitive ? source : source.toLocaleLowerCase('en-US');
}

/** Every rule the core checks, per field, in row order. */
export function validateDrafts(drafts: DraftEntry[]): EntryProblem[] {
  const problems: EntryProblem[] = [];
  const seen = new Map<string, string>();
  for (const draft of savableDrafts(drafts)) {
    const source = draft.source.trim();
    const target = draft.mode === 'keep' ? '' : draft.target.trim();
    const note = draft.note.trim();
    if (!source) problems.push({ key: draft.key, field: 'source', reason: 'required' });
    else if (source.length > MAX_SOURCE_CHARS) problems.push({ key: draft.key, field: 'source', reason: 'tooLong' });
    else if (CONTROL.test(source)) problems.push({ key: draft.key, field: 'source', reason: 'control' });
    else {
      const id = dedupeKey(draft);
      if (seen.has(id)) problems.push({ key: draft.key, field: 'source', reason: 'duplicate' });
      else seen.set(id, draft.key);
    }
    if (draft.mode === 'translate' && !target) problems.push({ key: draft.key, field: 'target', reason: 'targetRequired' });
    else if (target.length > MAX_TARGET_CHARS) problems.push({ key: draft.key, field: 'target', reason: 'tooLong' });
    else if (CONTROL.test(target)) problems.push({ key: draft.key, field: 'target', reason: 'control' });
    if (note.length > MAX_NOTE_CHARS) problems.push({ key: draft.key, field: 'note', reason: 'tooLong' });
    else if (NOTE_CONTROL.test(note)) problems.push({ key: draft.key, field: 'note', reason: 'control' });
  }
  return problems;
}

/** A comparable form of what would be saved, for "are there unsaved changes". */
export function snapshot(drafts: DraftEntry[]): string {
  return JSON.stringify(savableDrafts(drafts).map(fromDraft));
}

/** Rows whose source, target or note contains the text (case-insensitive). An empty query keeps everything. */
export function filterDrafts(drafts: DraftEntry[], query: string): DraftEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return drafts;
  return drafts.filter((draft) => `${draft.source}\n${draft.target}\n${draft.note}`.toLocaleLowerCase().includes(needle));
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

/** The entry a sample missed, when it still exists in the glossary. */
export function entryForSample(entries: GlossaryEntry[], sample: TranslationWarningSample): GlossaryEntry | null {
  return sample.entryId ? entries.find((entry) => entry.id === sample.entryId) ?? null : null;
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
    const wanted = dedupeKey(entry);
    const existing = document.entries.find((item) => (item.caseSensitive ? item.source : item.source.toLocaleLowerCase('en-US')) === wanted
      || (entry.caseSensitive && item.source === entry.source.trim()));
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

/** Text for the clipboard or a file: what `glossary.export` returned, as is. */
export function exportFileName(scope: GlossaryScope, format: 'csv' | 'tsv'): string {
  return `pomi-glossary-${scope === 'global' ? 'all-worlds' : 'world'}.${format}`;
}
