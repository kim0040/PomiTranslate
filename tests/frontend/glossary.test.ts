import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock, isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { BackendError, type GlossaryEntry } from '../../src/lib/api';
import {
  addGlossaryEntry, blankDraft, entryForSample, filterDrafts, formatFromName, fromDraft, GLOSSARY_LIMIT, importGlossary, parseInvalidPath, splitEntryId,
  savableDrafts, saveGlossary, seedSource, shownWarningSamples, snapshot, toDraft, validateDrafts, warningRows, warningTotal
} from '../../src/lib/glossary';
import { emptyProgress, reduceProgress } from '../../src/lib/workflow';
import { en } from '../../src/lib/i18n/en';
import { ja } from '../../src/lib/i18n/ja';
import { ko } from '../../src/lib/i18n/ko';
import { setLocale, translate } from '../../src/lib/i18n/index.svelte';
import { warningText } from '../../src/lib/failures';

const entry = (over: Partial<GlossaryEntry> = {}): GlossaryEntry => ({ id: 'a'.repeat(20), source: 'Elder Mira', target: '', mode: 'keep', caseSensitive: false, note: '', ...over });

type Reply = { payload?: unknown; error?: { code: string; message?: string } };
/** Answers each `sidecar_request` from a queue and records what was asked. */
function sidecar(replies: Reply[]): { type: string; payload: Record<string, any> }[] {
  const asked: { type: string; payload: Record<string, any> }[] = [];
  invokeMock.mockImplementation(async (command: string, args: any) => {
    if (command !== 'sidecar_request') return undefined;
    asked.push({ type: args.request.type, payload: args.request.payload });
    const reply = replies.shift() ?? { payload: {} };
    return reply.error
      ? { v: 1, id: args.request.id, type: 'response.error', error: { message: 'x', ...reply.error } }
      : { v: 1, id: args.request.id, type: 'response.ok', payload: reply.payload };
  });
  return asked;
}

beforeEach(() => {
  invokeMock.mockReset();
  setLocale('en');
});

describe('entry rows', () => {
  it('a keep entry sends no target and a translate entry sends it trimmed', () => {
    const keep = toDraft(entry({ target: 'ignored' }));
    expect(fromDraft(keep)).toEqual({ id: 'a'.repeat(20), source: 'Elder Mira', target: '', mode: 'keep', caseSensitive: false, note: '' });
    const translate = blankDraft({ source: '  Mira ', target: ' 미라 ', mode: 'translate' });
    expect(fromDraft(translate)).toEqual({ source: 'Mira', target: '미라', mode: 'translate', caseSensitive: false, note: '' });
  });

  it('untouched blank rows are not saved and do not count as changes', () => {
    const rows = [toDraft(entry()), blankDraft()];
    expect(savableDrafts(rows)).toHaveLength(1);
    expect(snapshot(rows)).toBe(snapshot([rows[0]]));
  });

  it('checks the same rules as the core, per field', () => {
    const rows = [
      blankDraft({ source: 'ok', target: 'fine' }),
      blankDraft({ source: 'OK', target: 'dup' }),
      blankDraft({ source: 'x'.repeat(201), target: 'a' }),
      blankDraft({ source: 'needs target', mode: 'translate' }),
      blankDraft({ source: 'line\nbreak', target: 'a' }),
      blankDraft({ source: '', target: 'orphan' }),
      blankDraft({ source: 'note', mode: 'keep', note: 'x'.repeat(301) }),
      blankDraft({ source: 'bell', mode: 'keep', note: 'a\u0007b' }),
      blankDraft({ source: 'multi', mode: 'keep', note: 'two\nlines\tand tab' })
    ];
    const found = validateDrafts(rows).map((item) => `${rows.findIndex((row) => row.key === item.key)}:${item.field}:${item.reason}`);
    expect(found).toEqual([
      '1:source:duplicate', '2:source:tooLong', '3:target:targetRequired', '4:source:control', '5:source:required', '6:note:tooLong', '7:note:control'
    ]);
  });

  it('a case-sensitive source is not a duplicate of another case', () => {
    const rows = [blankDraft({ source: 'Mira', target: 'a', caseSensitive: true }), blankDraft({ source: 'mira', target: 'b', caseSensitive: true })];
    expect(validateDrafts(rows)).toEqual([]);
  });

  it('search matches source, translation and note, and keeps the rows being typed', () => {
    const rows = [toDraft(entry({ source: 'Elder Mira' })), toDraft(entry({ source: 'Gate', target: '문', mode: 'translate', note: 'north' })), blankDraft()];
    expect(filterDrafts(rows, 'mira', []).map((row) => row.source)).toEqual(['Elder Mira', '']);
    expect(filterDrafts(rows, 'NORTH').map((row) => row.source)).toEqual(['Gate', '']);
    const typing = blankDraft({ source: 'zzz' });
    expect(filterDrafts([...rows, typing], 'mira', [typing.key])).toContain(typing);
    expect(filterDrafts(rows, '  ')).toBe(rows);
  });

  it('a pasted sentence becomes a one-line source of at most 200 characters', () => {
    expect(seedSource('  Elder\n  Mira  ')).toBe('Elder Mira');
    expect(seedSource('x'.repeat(500))).toHaveLength(200);
  });

  it('knows the limit the core enforces and the file type from the name', () => {
    expect(GLOSSARY_LIMIT).toBe(2000);
    expect(formatFromName('terms.TSV')).toBe('tsv');
    expect(formatFromName('terms.csv')).toBe('csv');
    expect(formatFromName('terms.txt')).toBe('csv');
  });
});

describe('where an invalid answer points', () => {
  it('reads the field path and ignores the rest of the message', () => {
    expect(parseInvalidPath('entries[3].source: is longer than 200 characters')).toEqual({ kind: 'entry', index: 3, field: 'source' });
    expect(parseInvalidPath('entries[0].target: is required when the mode is translate')).toEqual({ kind: 'entry', index: 0, field: 'target' });
    expect(parseInvalidPath('text: is longer than 2097152 characters')).toEqual({ kind: 'document', field: 'text' });
    expect(parseInvalidPath('baseRevision: must be a whole number')).toEqual({ kind: 'document', field: 'baseRevision' });
    expect(parseInvalidPath('something odd')).toBeNull();
  });
});

describe('requests', () => {
  it('a world list sends the world, the global list does not', async () => {
    const asked = sidecar([{ payload: { scope: 'world', revision: 2, updatedAt: null, entries: [] } }, { payload: { scope: 'global', revision: 0, updatedAt: null, entries: [] } }]);
    await saveGlossary('world', '/w', 2, []);
    await saveGlossary('global', '/w', 0, []);
    expect(asked[0]).toEqual({ type: 'glossary.set', payload: { scope: 'world', worldDir: '/w', baseRevision: 2, entries: [] } });
    expect(asked[1].payload).toEqual({ scope: 'global', baseRevision: 0, entries: [] });
  });

  it('GLOSSARY_BUSY is tried again and then succeeds', async () => {
    vi.useFakeTimers();
    try {
      const asked = sidecar([{ error: { code: 'GLOSSARY_BUSY' } }, { error: { code: 'GLOSSARY_BUSY' } }, { payload: { scope: 'global', revision: 5, updatedAt: null, entries: [entry()] } }]);
      const pending = saveGlossary('global', '', 4, [entry()]);
      await vi.runAllTimersAsync();
      expect((await pending).revision).toBe(5);
      expect(asked.map((item) => item.type)).toEqual(['glossary.set', 'glossary.set', 'glossary.set']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a save that stays busy fails with its code after the retries', async () => {
    vi.useFakeTimers();
    try {
      const asked = sidecar([{ error: { code: 'GLOSSARY_BUSY' } }, { error: { code: 'GLOSSARY_BUSY' } }, { error: { code: 'GLOSSARY_BUSY' } }]);
      const pending = saveGlossary('global', '', 4, []).catch((cause) => cause);
      await vi.runAllTimersAsync();
      const cause = await pending;
      expect(cause).toBeInstanceOf(BackendError);
      expect(cause.code).toBe('GLOSSARY_BUSY');
      expect(asked).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a conflict is not retried by a plain save', async () => {
    const asked = sidecar([{ error: { code: 'GLOSSARY_CONFLICT' } }]);
    await expect(saveGlossary('global', '', 1, [])).rejects.toMatchObject({ code: 'GLOSSARY_CONFLICT' });
    expect(asked).toHaveLength(1);
  });

  it('import sends the text and reports what the core counted', async () => {
    const asked = sidecar([{ payload: { scope: 'global', revision: 3, updatedAt: null, entries: [entry()], added: 1, updated: 0, unchanged: 0, removed: 2, skipped: [{ row: 4, reason: 'empty_source', source: '' }], skippedCount: 1 } }]);
    const result = await importGlossary('global', '', 2, 'a,b', 'csv', 'replace');
    expect(asked[0].payload).toEqual({ scope: 'global', baseRevision: 2, text: 'a,b', format: 'csv', mode: 'replace' });
    expect(result).toMatchObject({ added: 1, removed: 2, skippedCount: 1, revision: 3 });
  });

  it('adding from the review reports a rule that already exists instead of doubling it', async () => {
    const asked = sidecar([{ payload: { scope: 'global', revision: 1, updatedAt: null, entries: [entry({ source: 'Elder Mira' })] } }]);
    const result = await addGlossaryEntry('global', '', blankDraft({ source: 'elder mira', mode: 'keep' }));
    expect(result.status).toBe('exists');
    expect(asked.map((item) => item.type)).toEqual(['glossary.get']);
  });

  it('adding keeps the other entries and their ids, and retries once from the fresh list after a conflict', async () => {
    const first = entry({ id: 'b'.repeat(20), source: 'Gate', target: '문', mode: 'translate' });
    const asked = sidecar([
      { payload: { scope: 'global', revision: 1, updatedAt: null, entries: [first] } },
      { error: { code: 'GLOSSARY_CONFLICT' } },
      { payload: { scope: 'global', revision: 2, updatedAt: null, entries: [first] } },
      { payload: { scope: 'global', revision: 3, updatedAt: null, entries: [first, entry()] } }
    ]);
    const result = await addGlossaryEntry('global', '', blankDraft({ source: 'Elder Mira', mode: 'keep' }));
    expect(result.status).toBe('added');
    expect(asked.map((item) => item.type)).toEqual(['glossary.get', 'glossary.set', 'glossary.get', 'glossary.set']);
    expect(asked[1].payload.baseRevision).toBe(1);
    expect(asked[3].payload.baseRevision).toBe(2);
    expect(asked[3].payload.entries[0]).toEqual(first);
    expect(asked[3].payload.entries[1]).toMatchObject({ source: 'Elder Mira', mode: 'keep', target: '' });
    expect(asked[3].payload.entries[1].id).toBeUndefined();
  });
});

describe('quality warnings', () => {
  it('counts are shown known codes first, whole numbers only', () => {
    expect(warningRows({ other_new: 2, format_residue: 3, glossary_mismatch: 1, bad: -1, zero: 0 })).toEqual([
      { code: 'glossary_mismatch', count: 1 }, { code: 'format_residue', count: 3 }, { code: 'other_new', count: 2 }
    ]);
    expect(warningTotal({ glossary_mismatch: 1, format_residue: 3 })).toBe(4);
    expect(warningTotal(undefined)).toBe(0);
  });

  it('shows at most five well-formed samples and finds the entry that was missed', () => {
    const samples = Array.from({ length: 8 }, (_, index) => ({ code: 'glossary_mismatch', entryId: 'a'.repeat(20), source: `s${index}`, translated: `t${index}` }));
    expect(shownWarningSamples([...samples, { code: 'x' } as any])).toHaveLength(5);
    expect(entryForSample([entry()], samples[0])?.source).toBe('Elder Mira');
    expect(entryForSample([], samples[0])).toBeNull();
    // The core names the list: `global:<id>` or `world:<id>`; a bare id is looked up in either.
    const prefixed = { ...samples[0], entryId: `world:${'a'.repeat(20)}` };
    expect(entryForSample({ global: [entry()], world: [] }, prefixed)).toBeNull();
    expect(entryForSample({ global: [], world: [entry()] }, prefixed)?.source).toBe('Elder Mira');
    expect(entryForSample({ global: [entry()], world: [] }, { ...samples[0], entryId: `global:${'a'.repeat(20)}` })?.source).toBe('Elder Mira');
    expect(entryForSample({ global: [entry()] }, samples[0])?.source).toBe('Elder Mira');
    expect(splitEntryId(`world:${'b'.repeat(20)}`)).toEqual({ scope: 'world', id: 'b'.repeat(20) });
    expect(splitEntryId('b'.repeat(20))).toEqual({ scope: null, id: 'b'.repeat(20) });
    expect(entryForSample([entry()], { code: 'format_residue', source: 'a', translated: 'b' })).toBeNull();
  });

  it('the run keeps the latest counts and notes a glossary change on resume', () => {
    let progress = reduceProgress(emptyProgress(), { event: 'translation_progress', completed: 1, total: 4, warnings: { glossary_mismatch: 2, format_residue: 1.9, junk: -3 } });
    expect(progress.warnings).toEqual({ glossary_mismatch: 2, format_residue: 1 });
    progress = reduceProgress(progress, { event: 'translation_progress', completed: 2, total: 4 });
    expect(progress.warnings).toEqual({ glossary_mismatch: 2, format_residue: 1 });
    expect(progress.glossaryDropped).toBeNull();
    progress = reduceProgress(progress, { event: 'checkpoint_glossary_changed', dropped_translations: 7 });
    expect(progress.glossaryDropped).toBe(7);
  });

  it('the report-level glossary_changed warning says how many translations were dropped', () => {
    expect(warningText({ code: 'glossary_changed', dropped_translations: 12 })).toBe(en['scan.warn.glossary_changed'].replace('{count}', '12'));
  });
});

describe('texts', () => {
  const keys = [
    'error.GLOSSARY_CONFLICT', 'error.GLOSSARY_INVALID', 'error.GLOSSARY_WRITE_FAILED', 'error.GLOSSARY_BUSY',
    'quality.code.glossary_mismatch', 'quality.code.format_residue', 'quality.code.glossary_truncated',
    'quality.explain.glossary_mismatch', 'quality.explain.format_residue', 'quality.explain.glossary_truncated',
    'scan.warn.glossary_changed', 'scan.warn.glossary_truncated', 'quality.glossaryChanged', 'nav.glossary'
  ] as const;

  it.each(keys)('%s exists in every language and is not just the Korean text', (key) => {
    for (const catalog of [ko, en, ja]) expect((catalog as Record<string, string>)[key]).toBeTruthy();
    expect(en[key]).not.toBe(ko[key]);
    expect(ja[key]).not.toBe(ko[key]);
  });

  it('every glossary skip reason from the core has a sentence', () => {
    for (const reason of ['empty_source', 'source_too_long', 'target_too_long', 'note_too_long', 'control_character', 'invalid_mode', 'missing_target', 'invalid_case_sensitive', 'duplicate_in_file', 'limit']) {
      expect(translate('en', `glossary.skip.${reason}` as any)).not.toBe('Text unavailable');
    }
  });

  it('the empty state explains a glossary with the Elder Mira example', () => {
    for (const locale of ['ko', 'en', 'ja'] as const) expect(translate(locale, 'glossary.empty.body')).toContain('Elder Mira');
  });
});
