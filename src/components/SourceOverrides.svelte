<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { app } from '../lib/app.svelte';
  import { exportDocument } from '../lib/document-export';
  import { t } from '../lib/i18n/index.svelte';
  import { validateSourceOverrides } from '../lib/settings-import';
  import Icon from './Icon.svelte';

  // Saved manual translations as a table. The settings keep their object format ({ source: translation });
  // the rows here are only how it is edited. Only a list with no row errors is written back, so an
  // invalid row never reaches the settings, and a fully empty row is just ignored.
  let { overrides = $bindable({}), invalid = $bindable(false), resetKey = 0 }: { overrides?: Record<string, string>; invalid?: boolean; resetKey?: number } = $props();

  type Row = { id: number; source: string; target: string };
  type Problem = '' | 'source' | 'target' | 'duplicate' | 'long' | 'text';
  const PAGE = 50;
  const MAX_CHARS = 32000;

  let serial = 0;
  let rows = $state<Row[]>([]);
  let query = $state('');
  let page = $state(0);
  let lastSerialized = '';
  let lastReset = untrack(() => resetKey);
  let limitError = $state(false);
  let notice = $state('');
  let importInput: HTMLInputElement | undefined = $state();

  const fromObject = (value: Record<string, string>): Row[] => Object.entries(value).map(([source, target]) => ({ id: ++serial, source, target }));
  const blank = (row: Row) => !row.source.trim() && !row.target.trim();
  const badText = (value: string) => value.includes('\u0000') || Array.from(value).some((char) => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff);

  // Changes made elsewhere (discard, import, reset to defaults) replace the rows. A discard can leave the
  // saved object as it was while the rows hold unfinished edits, so the screen also bumps `resetKey`.
  $effect(() => {
    const next = JSON.stringify(overrides);
    const reset = resetKey;
    if (next !== lastSerialized || reset !== lastReset) {
      rows = fromObject(overrides);
      lastSerialized = next;
      lastReset = reset;
      limitError = false;
      invalid = false;
    }
  });

  const problems = $derived.by(() => {
    const seen = new Map<string, number>();
    for (const row of rows) if (!blank(row)) seen.set(row.source, (seen.get(row.source) ?? 0) + 1);
    return new Map<number, Problem>(rows.map((row) => {
      let problem: Problem = '';
      if (blank(row)) problem = '';
      else if (!row.source.trim()) problem = 'source';
      else if (!row.target.trim()) problem = 'target';
      else if ([...row.source].length > MAX_CHARS || [...row.target].length > MAX_CHARS) problem = 'long';
      else if (badText(row.source) || badText(row.target)) problem = 'text';
      else if ((seen.get(row.source) ?? 0) > 1) problem = 'duplicate';
      return [row.id, problem];
    }));
  });
  const entries = $derived(rows.filter((row) => !blank(row)));
  const problemCount = $derived([...problems.values()].filter(Boolean).length);

  const needle = $derived(query.trim().toLocaleLowerCase());
  const matching = $derived(needle ? rows.filter((row) => row.source.toLocaleLowerCase().includes(needle) || row.target.toLocaleLowerCase().includes(needle)) : rows);
  const pages = $derived(Math.max(1, Math.ceil(matching.length / PAGE)));
  const current = $derived(Math.min(page, pages - 1));
  const visible = $derived(matching.slice(current * PAGE, current * PAGE + PAGE));

  function commit(): void {
    if (problemCount) { invalid = true; return; }
    const next = Object.fromEntries(entries.map((row) => [row.source, row.target]));
    try {
      const checked = validateSourceOverrides(next);
      limitError = false;
      invalid = false;
      lastSerialized = JSON.stringify(checked);
      overrides = checked;
    } catch {
      limitError = true;
      invalid = true;
    }
  }

  function edit(row: Row, field: 'source' | 'target', value: string): void {
    row[field] = value;
    commit();
  }

  async function add(): Promise<void> {
    query = '';
    page = 0;
    const row = { id: ++serial, source: '', target: '' };
    rows = [row, ...rows];
    await tick();
    document.getElementById(`override-source-${row.id}`)?.focus();
  }

  function remove(row: Row): void {
    rows = rows.filter((item) => item.id !== row.id);
    commit();
  }

  async function importFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    notice = '';
    try {
      if (file.size > 1024 * 1024) throw new Error('oversized');
      let parsed: unknown = JSON.parse(await file.text());
      // A settings export keeps the list under `source_overrides`.
      if (parsed && typeof parsed === 'object' && 'source_overrides' in parsed && typeof (parsed as Record<string, unknown>).source_overrides === 'object') {
        parsed = (parsed as Record<string, unknown>).source_overrides;
      }
      const imported = validateSourceOverrides(parsed);
      const existing = new Map(rows.filter((row) => !blank(row)).map((row) => [row.source, row] as const));
      let replaced = 0;
      for (const [source, target] of Object.entries(imported)) {
        const row = existing.get(source);
        if (row) { if (row.target !== target) replaced += 1; row.target = target; }
        else rows.push({ id: ++serial, source, target });
      }
      commit();
      notice = t('overrides.imported', { count: Object.keys(imported).length, replaced });
    } catch {
      notice = '';
      app.notify(t('overrides.importFailed'), 'error');
    }
  }

  async function exportFile(): Promise<void> {
    try {
      if (await exportDocument('settings', Object.fromEntries(entries.map((row) => [row.source, row.target])))) app.notify(t('export.saved'), 'success');
    } catch (cause) { app.fail(cause); }
  }

  const problemKey = {
    source: 'overrides.error.source', target: 'overrides.error.target', duplicate: 'overrides.error.duplicate',
    long: 'overrides.error.long', text: 'overrides.error.text'
  } as const;
</script>

<div class="overrides">
  <p class="hint">{t('overrides.help')}</p>
  <div class="toolbar">
    <span class="pill pill-accent num" aria-label={t('overrides.count', { count: entries.length })}>{t('overrides.count', { count: entries.length })}</span>
    <div class="search">
      <label class="sr-only" for="override-search">{t('overrides.search')}</label>
      <input id="override-search" class="input" type="search" bind:value={query} placeholder={t('overrides.search')} oninput={() => (page = 0)} autocomplete="off" />
    </div>
    <div class="buttons">
      <button type="button" class="btn btn-secondary btn-sm" onclick={add}><Icon name="plus" size={14} /> {t('overrides.add')}</button>
      <input type="file" accept="application/json,.json" bind:this={importInput} onchange={importFile} hidden />
      <button type="button" class="btn btn-secondary btn-sm" onclick={() => importInput?.click()}><Icon name="upload" size={14} /> {t('overrides.import')}</button>
      <button type="button" class="btn btn-secondary btn-sm" disabled={!entries.length || invalid} onclick={exportFile}><Icon name="download" size={14} /> {t('overrides.export')}</button>
    </div>
  </div>
  {#if notice}<p class="hint" role="status">{notice}</p>{/if}
  {#if limitError}<p class="field-error" role="alert">{t('overrides.invalid')}</p>{/if}
  {#if problemCount}<p class="field-error" role="alert">{t('overrides.fix', { count: problemCount })}</p>{/if}

  {#if rows.length}
    <table class="rows">
      <thead>
        <tr><th scope="col">{t('overrides.source')}</th><th scope="col">{t('overrides.target')}</th><th scope="col"><span class="sr-only">{t('overrides.remove')}</span></th></tr>
      </thead>
      <tbody>
        {#each visible as row (row.id)}
          {@const problem = problems.get(row.id) ?? ''}
          <tr class:bad={!!problem}>
            <td>
              <textarea id="override-source-{row.id}" class="textarea" rows="1" spellcheck="false" aria-label={t('overrides.source')} aria-invalid={problem === 'source' || problem === 'duplicate' || problem === 'long' || problem === 'text'}
                aria-describedby={problem ? `override-error-${row.id}` : undefined} value={row.source} oninput={(event) => edit(row, 'source', event.currentTarget.value)}></textarea>
            </td>
            <td>
              <textarea id="override-target-{row.id}" class="textarea" rows="1" spellcheck="false" aria-label={t('overrides.target')} aria-invalid={problem === 'target'}
                aria-describedby={problem ? `override-error-${row.id}` : undefined} value={row.target} oninput={(event) => edit(row, 'target', event.currentTarget.value)}></textarea>
            </td>
            <td class="end">
              <button type="button" class="btn btn-quiet btn-icon btn-sm" aria-label={t('overrides.removeRow', { source: row.source.slice(0, 40) })} onclick={() => remove(row)}><Icon name="trash" size={15} /></button>
            </td>
          </tr>
          {#if problem}
            <tr class="error-row"><td colspan="3"><span id="override-error-{row.id}" class="field-error" role="alert">{t(problemKey[problem])}</span></td></tr>
          {/if}
        {/each}
        {#if !visible.length}<tr><td colspan="3" class="hint empty">{t('overrides.noMatch')}</td></tr>{/if}
      </tbody>
    </table>
    {#if pages > 1}
      <div class="pager" role="group" aria-label={t('overrides.pages')}>
        <button type="button" class="btn btn-secondary btn-sm" disabled={current === 0} onclick={() => (page = current - 1)}><Icon name="chevron-left" size={14} /> {t('overrides.prev')}</button>
        <span class="hint num" role="status">{current * PAGE + 1}–{Math.min(matching.length, current * PAGE + PAGE)} / {matching.length}</span>
        <button type="button" class="btn btn-secondary btn-sm" disabled={current >= pages - 1} onclick={() => (page = current + 1)}>{t('overrides.next')} <Icon name="chevron-right" size={14} /></button>
      </div>
    {/if}
  {:else}
    <p class="hint empty-state">{t('overrides.empty')}</p>
  {/if}
</div>

<style>
  .overrides { display: grid; gap: var(--space-3); min-width: 0; }
  .hint { color: var(--text-secondary); font-size: var(--text-xs); line-height: 1.45; margin: 0; }
  .field-error { color: var(--danger-text); font-size: var(--text-xs); line-height: 1.4; margin: 0; }
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); }
  .search { flex: 1 1 200px; min-width: 0; }
  .buttons { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .rows { width: 100%; border-collapse: separate; border-spacing: 0 var(--space-2); table-layout: fixed; }
  th { text-align: start; color: var(--text-secondary); font-size: var(--text-xs); font-weight: 700; padding: 0 var(--space-1); }
  th:last-child, td.end { width: 40px; }
  td { vertical-align: top; padding: 0 var(--space-1); }
  td.end { text-align: end; }
  .textarea { min-height: var(--control-height); width: 100%; resize: vertical; field-sizing: content; max-height: 160px; padding-block: 5px; }
  tr.bad .textarea[aria-invalid='true'] { border-color: var(--danger-solid); }
  .error-row td { padding-block: 0 var(--space-1); }
  .empty, .empty-state { padding: var(--space-3); text-align: center; }
  .pager { display: flex; align-items: center; justify-content: center; gap: var(--space-3); }
  @media (max-width: 640px) {
    thead { display: none; }
    .rows, .rows tbody, .rows tr { display: block; }
    .rows tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2); padding: var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-lg); margin-bottom: var(--space-2); }
    td { display: block; padding: 0; width: auto; }
    td.end { grid-row: 1 / span 2; grid-column: 2; }
    .error-row { border: 0; padding: 0 var(--space-2); margin-top: calc(-1 * var(--space-2)); }
  }
</style>
