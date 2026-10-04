<script lang="ts">
  import type { GlossaryEntry } from '../lib/api';
  import { t } from '../lib/i18n/index.svelte';
  import Icon from './Icon.svelte';

  type RowError = { index: number; message: string };
  let { entries = $bindable<GlossaryEntry[]>([]), invalid = $bindable(false), resetKey = 0 }: {
    entries?: GlossaryEntry[]; invalid?: boolean; resetKey?: number;
  } = $props();
  let query = $state('');
  let fileInput: HTMLInputElement | undefined = $state();
  let importError = $state('');

  function validate(value: GlossaryEntry[]): RowError[] {
    const errors: RowError[] = [];
    if (value.length > 2000) errors.push({ index: 2000, message: t('glossary.error.limit') });
    const valid: { entry: GlossaryEntry; index: number }[] = [];
    value.forEach((entry, index) => {
      const problems: string[] = [];
      const source = entry.source.trim();
      if (!source) problems.push(t('glossary.error.sourceRequired'));
      if (source.length > 200) problems.push(t('glossary.error.sourceLength'));
      if (entry.target.length > 500) problems.push(t('glossary.error.targetLength'));
      if (entry.note.length > 500) problems.push(t('glossary.error.noteLength'));
      if (entry.mode === 'translate' && !entry.target.trim()) problems.push(t('glossary.error.targetRequired'));
      if (!['translate', 'keep'].includes(entry.mode)) problems.push(t('glossary.error.mode'));
      if (/§[0-9a-fk-orx]/i.test(entry.source) || /§[0-9a-fk-orx]/i.test(entry.target)) problems.push(t('glossary.error.formatCode'));
      const previous = valid.find(({ entry: old }) => {
        if (old.source.trim() === source) return true;
        return old.source.trim().toLocaleLowerCase() === source.toLocaleLowerCase() && (!old.caseSensitive || !entry.caseSensitive);
      });
      if (previous) problems.push(t('glossary.error.duplicate', { row: previous.index + 1 }));
      if (problems.length) errors.push({ index, message: problems.join(' ') });
      else valid.push({ entry, index });
    });
    return errors;
  }

  const errors = $derived(validate(entries));
  const filtered = $derived(entries.map((entry, index) => ({ entry, index })).filter(({ entry }) =>
    !query.trim() || `${entry.source}\n${entry.target}\n${entry.note}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  ));
  $effect(() => { invalid = errors.length > 0; void resetKey; });
  $effect(() => { void resetKey; query = ''; importError = ''; });

  function update(index: number, changes: Partial<GlossaryEntry>): void {
    entries = entries.map((entry, at) => at === index ? { ...entry, ...changes } : entry);
    importError = '';
  }

  function add(): void {
    if (entries.length >= 2000) return;
    entries = [...entries, { source: '', target: '', mode: 'translate', note: '', caseSensitive: false }];
    query = '';
  }

  function remove(index: number): void {
    entries = entries.filter((_, at) => at !== index);
  }

  function csvCell(value: string): string {
    return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  }

  function csvText(value: GlossaryEntry[]): string {
    const rows = [['source', 'target', 'mode', 'note', 'caseSensitive'], ...value.map((entry) => [
      entry.source, entry.target, entry.mode, entry.note, String(entry.caseSensitive)
    ])];
    return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  }

  function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;
    const input = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < input.length; i += 1) {
      const char = input[i];
      if (quoted) {
        if (char === '"' && input[i + 1] === '"') { cell += '"'; i += 1; }
        else if (char === '"') quoted = false;
        else cell += char;
      } else if (char === '"' && cell === '') quoted = true;
      else if (char === ',') { row.push(cell); cell = ''; }
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && input[i + 1] === '\n') i += 1;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += char;
    }
    if (quoted) throw new Error('unterminated quote');
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  async function importFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      let next: GlossaryEntry[];
      if (file.name.toLocaleLowerCase().endsWith('.csv')) {
        const rows = parseCsv(text);
        const header = ['source', 'target', 'mode', 'note', 'caseSensitive'];
        if (JSON.stringify(rows[0]) !== JSON.stringify(header)) throw new Error('invalid header');
        next = rows.slice(1).filter((row) => row.some((cell) => cell !== '')).map((row) => {
          if (row.length !== header.length || !['true', 'false'].includes(row[4])) throw new Error('invalid row');
          return { source: row[0], target: row[1], mode: row[2] as GlossaryEntry['mode'], note: row[3], caseSensitive: row[4] === 'true' };
        });
      } else {
        const parsed: unknown = JSON.parse(text);
        const rows = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' && 'entries' in parsed ? (parsed as { entries?: unknown }).entries : null);
        if (!Array.isArray(rows)) throw new Error('invalid JSON');
        next = rows.map((row) => {
          if (!row || typeof row !== 'object') throw new Error('invalid row');
          const item = row as Partial<GlossaryEntry>;
          return { source: String(item.source ?? ''), target: String(item.target ?? ''), mode: item.mode ?? 'translate', note: String(item.note ?? ''), caseSensitive: item.caseSensitive === true };
        });
      }
      entries = next;
      query = '';
      importError = '';
    } catch {
      importError = t('glossary.import.failed');
    } finally {
      input.value = '';
    }
  }

  function download(name: string, content: string, type: string): void {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function exportJson(): void {
    download('pomitranslate-glossary.json', `${JSON.stringify(entries, null, 2)}\n`, 'application/json;charset=utf-8');
  }

  function exportCsv(): void {
    download('pomitranslate-glossary.csv', `\uFEFF${csvText(entries)}\r\n`, 'text/csv;charset=utf-8');
  }
</script>

<div class="editor" data-testid="glossary-editor">
  <p class="help">{t('glossary.help')}</p>
  <p class="hint">{t('glossary.formatHelp')}</p>
  <div class="toolbar">
    <label class="search">
      <Icon name="search" size={15} />
      <input class="input" type="search" bind:value={query} placeholder={t('glossary.search')} aria-label={t('glossary.search')} />
    </label>
    <span class="count num">{t('glossary.count', { count: entries.length })}</span>
    <div class="actions">
      <input bind:this={fileInput} class="file" type="file" accept=".json,.csv,application/json,text/csv" aria-label={t('glossary.import.file')} onchange={importFile} />
      <button type="button" class="btn btn-secondary btn-sm" onclick={() => fileInput?.click()}><Icon name="upload" size={14} /> {t('glossary.import.action')}</button>
      <button type="button" class="btn btn-quiet btn-sm" onclick={exportJson}><Icon name="download" size={14} /> JSON</button>
      <button type="button" class="btn btn-quiet btn-sm" onclick={exportCsv}><Icon name="download" size={14} /> CSV</button>
      <button type="button" class="btn btn-primary btn-sm" disabled={entries.length >= 2000} onclick={add}><Icon name="plus" size={14} /> {t('glossary.add')}</button>
    </div>
  </div>
  {#if importError}<p class="error" role="alert">{importError}</p>{/if}
  {#if errors.length > 0}<p class="error" role="alert">{t('glossary.validationSummary', { count: errors.length })}</p>{/if}
  {#if filtered.length}
    <div class="table-scroll">
      <table>
        <thead><tr><th scope="col">{t('glossary.source')}</th><th scope="col">{t('glossary.target')}</th><th scope="col">{t('glossary.mode')}</th><th scope="col">{t('glossary.note')}</th><th scope="col">{t('glossary.caseSensitive')}</th><th scope="col"><span class="sr-only">{t('glossary.remove')}</span></th></tr></thead>
        <tbody>
          {#each filtered as row (row.index)}
            {@const entry = row.entry}
            {@const error = errors.find((item) => item.index === row.index)}
            <tr class:invalid={!!error}>
              <td><input class="input" value={entry.source} maxlength="200" aria-label={t('glossary.source')} aria-invalid={!!error} oninput={(event) => update(row.index, { source: event.currentTarget.value })} /></td>
              <td><input class="input" value={entry.target} maxlength="500" aria-label={t('glossary.target')} oninput={(event) => update(row.index, { target: event.currentTarget.value })} /></td>
              <td><select class="select" value={entry.mode} aria-label={t('glossary.mode')} onchange={(event) => update(row.index, { mode: event.currentTarget.value as GlossaryEntry['mode'] })}><option value="translate">{t('glossary.mode.translate')}</option><option value="keep">{t('glossary.mode.keep')}</option></select></td>
              <td><input class="input" value={entry.note} maxlength="500" aria-label={t('glossary.note')} oninput={(event) => update(row.index, { note: event.currentTarget.value })} /></td>
              <td><label class="case"><input type="checkbox" checked={entry.caseSensitive} aria-label={t('glossary.caseSensitive')} onchange={(event) => update(row.index, { caseSensitive: event.currentTarget.checked })} /><span class="sr-only">{t('glossary.caseSensitive')}</span></label></td>
              <td><button type="button" class="btn btn-quiet btn-icon btn-sm" aria-label={t('glossary.remove')} onclick={() => remove(row.index)}><Icon name="trash" size={15} /></button></td>
            </tr>
            {#if error}<tr class="error-row"><td colspan="6"><span class="error" role="alert">{t('glossary.rowError', { row: row.index + 1, message: error.message })}</span></td></tr>{/if}
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <p class="empty">{query.trim() ? t('glossary.emptySearch') : t('glossary.empty')}</p>
  {/if}
</div>

<style>
  .editor { display: grid; gap: var(--space-3); min-width: 0; }
  .help, .hint { margin: 0; }
  .help { color: var(--text); font-size: var(--text-sm); }
  .toolbar { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .search { position: relative; flex: 1 1 180px; min-width: 160px; }
  .search :global(.icon) { position: absolute; inset-inline-start: 9px; top: 50%; translate: 0 -50%; color: var(--text-secondary); pointer-events: none; }
  .search .input { padding-inline-start: 32px; }
  .count { color: var(--text-secondary); font-size: var(--text-xs); }
  .actions { display: flex; align-items: center; gap: var(--space-1); flex-wrap: wrap; margin-inline-start: auto; }
  .file { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); overflow: hidden; }
  .table-scroll { max-width: 100%; overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-md); }
  table { width: 100%; min-width: 740px; border-collapse: collapse; font-size: var(--text-xs); }
  th { padding: var(--space-2); text-align: start; color: var(--text-secondary); background: var(--bg-sunken); font-weight: 600; white-space: nowrap; }
  td { padding: 4px; border-top: 1px solid var(--border); }
  td:first-child, td:nth-child(2), td:nth-child(4) { min-width: 140px; }
  .case { display: grid; place-items: center; min-height: 36px; }
  .invalid td:first-child .input { border-color: var(--danger-solid); }
  .error-row td { padding: 2px 8px 6px; border-top: 0; }
  .error { display: block; margin: 0; color: var(--danger-text); font-size: var(--text-xs); overflow-wrap: anywhere; }
  .empty { margin: 0; padding: var(--space-4); border: 1px dashed var(--border); border-radius: var(--radius-md); text-align: center; color: var(--text-secondary); font-size: var(--text-sm); }
  @media (max-width: 600px) { .actions { margin-inline-start: 0; } }
</style>
