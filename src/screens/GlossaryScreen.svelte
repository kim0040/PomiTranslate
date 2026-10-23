<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import { app } from '../lib/app.svelte';
  import { BackendError, type GlossaryDocument, type GlossaryImportResult, type GlossaryScope } from '../lib/api';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import { baseName, formatNumber } from '../lib/format';
  import { exportDocument } from '../lib/document-export';
  import {
    blankDraft, DraftTracker, exportFileName, exportGlossary, filterDrafts, fromDraft, GLOSSARY_LIMIT, loadGlossary, matchesQuery, matchingKeys,
    MAX_NOTE_CHARS, MAX_SOURCE_CHARS, MAX_TARGET_CHARS, parseInvalidPath, saveGlossary, savableDrafts, toDraft, validateDrafts,
    type DraftEntry, type EntryProblem, type FieldName
  } from '../lib/glossary';
  import Callout from '../components/Callout.svelte';
  import Dialog from '../components/Dialog.svelte';
  import GlossaryImportDialog from '../components/GlossaryImportDialog.svelte';
  import Icon from '../components/Icon.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import StatusScreen from '../components/StatusScreen.svelte';

  const UNKNOWN_COMMAND_CODES = ['UNSUPPORTED_REQUEST', 'UNKNOWN_REQUEST', 'UNKNOWN_MESSAGE'];
  const PAGE_SIZE = 200;

  let scope = $state<GlossaryScope>('global');
  const hasWorld = $derived(!!app.worldDir);
  // "This world" needs a world; without one the page falls back to the list for every world.
  const activeScope = $derived<GlossaryScope>(scope === 'world' && hasWorld ? 'world' : 'global');

  let loading = $state(true);
  let loadError = $state('');
  let revision = $state(0);
  let drafts = $state<DraftEntry[]>([]);
  // "Unsaved" and the saved-row count are kept up to date row by row (see DraftTracker), so a keystroke
  // does not walk the whole list. Every change to `drafts` is reported to it.
  const tracker = new DraftTracker();
  let dirty = $state(false);
  let count = $state(0);
  let query = $state('');
  // Rows added in this visit stay visible while a search is active, even before they match it.
  let pinned = $state<string[]>([]);
  let renderLimit = $state(PAGE_SIZE);
  let saving = $state(false);
  let conflict = $state(false);
  let error = $state('');
  let showProblems = $state(false);
  let serverProblem = $state<{ key: string; field: FieldName } | null>(null);
  let confirmDelete = $state<string | null>(null);
  let importing = $state(false);
  let exporting = $state(false);
  // A save to a file that failed: the text is kept so the clipboard can take its place.
  let exportFailure = $state<{ message: string; text: string; count: number } | null>(null);
  let generation = 0;
  let mounted = true;
  onDestroy(() => { mounted = false; });

  const full = $derived(count >= GLOSSARY_LIMIT);
  const problems = $derived<EntryProblem[]>(showProblems ? validateDrafts(drafts) : []);
  const filtering = $derived(query.trim().length > 0);
  // The rows a search keeps. Typing in a row must not read every other row, so the matches are worked out
  // when the list or the search changes; an edit only asks for that again (`matchRev`) when the edited
  // row itself starts or stops matching.
  let matchRev = $state(0);
  const matching = $derived.by(() => {
    const list = drafts;
    const text = query;
    void matchRev;
    return untrack(() => matchingKeys(list, text));
  });
  const visible = $derived(filtering ? drafts.filter((draft) => pinned.includes(draft.key) || matching.has(draft.key)) : drafts);
  const shown = $derived(visible.slice(0, renderLimit));
  const numbers = $derived(new Map(drafts.map((draft, index) => [draft.key, index + 1])));
  const worldName = $derived(app.worldDir ? baseName(app.worldDir) : '');

  function track(): void {
    dirty = tracker.dirty;
    count = tracker.count;
  }

  function applyDocument(document: GlossaryDocument): void {
    revision = document.revision;
    drafts = document.entries.map(toDraft);
    tracker.reset(drafts);
    track();
    pinned = [];
    renderLimit = PAGE_SIZE;
    conflict = false;
    error = '';
    showProblems = false;
    serverProblem = null;
    confirmDelete = null;
    exportFailure = null;
  }

  async function load(): Promise<void> {
    const mine = ++generation;
    loading = true;
    loadError = '';
    try {
      const document = await loadGlossary(activeScope, app.worldDir);
      if (mine === generation) applyDocument(document);
    } catch (cause) {
      if (mine !== generation) return;
      loadError = cause instanceof BackendError && UNKNOWN_COMMAND_CODES.includes(cause.code) ? t('glossary.unsupported') : app.describe(cause);
    } finally {
      if (mine === generation) loading = false;
    }
  }

  // Opening the page, or switching the list (switching is only possible with nothing unsaved).
  $effect(() => {
    void activeScope;
    void app.worldDir;
    untrack(() => void load());
  });

  // Leaving or quitting with unsaved edits asks first; "save and quit" saves this list.
  $effect(() => { app.glossaryDirty = dirty; });
  $effect(() => {
    app.saveDraft = save;
    return () => { app.saveDraft = null; };
  });
  $effect(() => () => {
    app.glossaryDirty = false;
    app.pendingLeave = null;
  });

  function setScope(next: GlossaryScope): void {
    if (dirty || saving || next === activeScope) return;
    if (next === 'world' && !hasWorld) return;
    scope = next;
  }

  // --- editing ---------------------------------------------------------------------------------

  function field(key: string, name: string): HTMLElement | null {
    return document.getElementById(`g-${name}-${key}`);
  }

  async function focusField(key: string, name = 'source'): Promise<void> {
    await tick();
    const node = field(key, name);
    node?.scrollIntoView({ block: 'nearest' });
    node?.focus();
  }

  async function addRow(after?: string): Promise<void> {
    if (full || saving) return;
    const row = blankDraft();
    const at = after ? drafts.findIndex((draft) => draft.key === after) + 1 : 0;
    drafts = [...drafts.slice(0, at), row, ...drafts.slice(at)];
    tracker.structure(drafts);
    track();
    pinned = [...pinned, row.key];
    // A row added past the rendered page must be rendered to be focused.
    const position = filterDrafts(drafts, query, pinned).findIndex((draft) => draft.key === row.key);
    if (position >= renderLimit) renderLimit = position + 1;
    await focusField(row.key);
  }

  function update(key: string, patch: Partial<DraftEntry>): void {
    // While a save is on its way the list stays as it was sent: the answer replaces the drafts.
    if (saving) return;
    // The row is changed in place: only what shows it is updated, not the other rows.
    const draft = tracker.draft(key);
    if (!draft) return;
    Object.assign(draft, patch);
    tracker.edit(key);
    track();
    if (filtering && matchesQuery(draft, query.trim().toLocaleLowerCase()) !== matching.has(key)) matchRev += 1;
    if (serverProblem?.key === key) serverProblem = null;
  }

  // Enter in the source or translation field adds a new entry below the current one (a note takes
  // Enter as a line break). It is ignored while a Korean, Japanese or Chinese word is still being
  // composed, because Enter then confirms the word.
  function onFieldKey(event: KeyboardEvent, key: string): void {
    if (saving || event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.shiftKey) return;
    event.preventDefault();
    void addRow(key);
  }

  async function remove(key: string): Promise<void> {
    if (saving) return;
    const index = visible.findIndex((draft) => draft.key === key);
    const neighbour = visible[index + 1] ?? visible[index - 1];
    drafts = drafts.filter((draft) => draft.key !== key);
    tracker.structure(drafts);
    track();
    pinned = pinned.filter((item) => item !== key);
    confirmDelete = null;
    if (neighbour) await focusField(neighbour.key);
    else document.getElementById('glossary-add')?.focus();
  }

  function askDelete(key: string): void {
    if (saving) return;
    const row = drafts.find((draft) => draft.key === key);
    // A row nothing was typed into needs no question.
    if (row && !row.source.trim() && !row.target.trim() && !row.note.trim()) void remove(key);
    else {
      confirmDelete = key;
      void focusField(key, 'delete-yes');
    }
  }

  // Escape answers the question with "no" without leaving the page.
  function askKey(event: KeyboardEvent, key: string): void {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    cancelDelete(key);
  }

  function cancelDelete(key: string): void {
    confirmDelete = null;
    void focusField(key, 'delete');
  }

  // --- problems --------------------------------------------------------------------------------

  function problemFor(key: string, name: FieldName): string {
    if (serverProblem?.key === key && serverProblem.field === name) {
      return t('glossary.invalid.at', { n: numbers.get(key) ?? 0, field: t(`glossary.col.${name}` as MessageKey) });
    }
    const found = problems.find((item) => item.key === key && item.field === name);
    if (!found) return '';
    if (found.reason === 'tooLong') {
      return t('glossary.problem.tooLong', { max: formatNumber(name === 'source' ? MAX_SOURCE_CHARS : name === 'target' ? MAX_TARGET_CHARS : MAX_NOTE_CHARS, app.locale) });
    }
    return t(`glossary.problem.${found.reason}` as MessageKey);
  }

  function rowHasProblem(key: string): boolean {
    return serverProblem?.key === key || problems.some((item) => item.key === key);
  }

  async function revealProblem(key: string, name: FieldName): Promise<void> {
    // The row may be filtered out or past the rendered page.
    query = '';
    pinned = [...pinned, key];
    const position = drafts.findIndex((draft) => draft.key === key);
    if (position >= renderLimit) renderLimit = position + 1;
    await focusField(key, name);
  }

  // --- saving ----------------------------------------------------------------------------------

  async function save(): Promise<boolean> {
    if (saving) return false;
    error = '';
    const found = validateDrafts(drafts);
    if (found.length) {
      showProblems = true;
      error = t('glossary.saveFixFirst');
      void revealProblem(found[0].key, found[0].field);
      return false;
    }
    const rows = savableDrafts(drafts);
    saving = true;
    try {
      applyDocument(await saveGlossary(activeScope, app.worldDir, revision, rows.map(fromDraft)));
      app.notify(t('glossary.saveDone'), 'success');
      return true;
    } catch (cause) {
      if (cause instanceof BackendError && cause.code === 'GLOSSARY_CONFLICT') {
        conflict = true;
        return false;
      }
      if (cause instanceof BackendError && cause.code === 'GLOSSARY_INVALID') {
        const where = parseInvalidPath(cause.message);
        const row = where?.kind === 'entry' ? rows[where.index] : undefined;
        if (where?.kind === 'entry' && row && ['source', 'target', 'note'].includes(where.field)) {
          serverProblem = { key: row.key, field: where.field as FieldName };
          error = t('glossary.saveFixFirst');
          void revealProblem(row.key, where.field as FieldName);
        } else {
          error = t('glossary.invalid.other');
        }
        return false;
      }
      // GLOSSARY_WRITE_FAILED, GLOSSARY_BUSY (already retried) and anything else: the edits stay as they are.
      error = app.describe(cause);
      return false;
    } finally {
      saving = false;
    }
  }

  function discard(): void {
    applyDocument({ scope: activeScope, revision, updatedAt: null, entries: tracker.savedEntries() });
  }

  // The saved version is fetched again; the person's edits are dropped (reload) or kept (keep).
  async function reloadSaved(): Promise<void> {
    await load();
  }

  async function keepMine(): Promise<void> {
    try {
      const latest = await loadGlossary(activeScope, app.worldDir);
      revision = latest.revision;
      conflict = false;
      error = '';
    } catch (cause) {
      error = app.describe(cause);
    }
  }

  // --- leaving ---------------------------------------------------------------------------------

  async function saveAndLeave(): Promise<void> {
    app.resolveLeave(await save());
  }

  function leaveWithoutSaving(): void {
    app.resolveLeave(true);
  }

  // --- import and export -------------------------------------------------------------------------

  function imported(result: GlossaryImportResult): void {
    const message = t('glossary.import.done', { added: result.added, updated: result.updated, removed: result.removed });
    // The page was left while the request ran. The import is stored all the same, so it is still
    // reported, and the next visit loads the new revision.
    if (!mounted) {
      app.notify(message, 'success');
      return;
    }
    applyDocument(result);
    app.notify(message, 'success');
  }

  function stale(): void {
    if (mounted) void load();
  }

  /** The text for a spreadsheet or a note: without the byte-order mark the file starts with. */
  const clipboardText = (text: string): string => text.replace(/^﻿/, '');

  async function copyExport(): Promise<void> {
    const failure = exportFailure;
    if (!failure) return;
    try {
      await navigator.clipboard.writeText(clipboardText(failure.text));
      exportFailure = null;
      app.notify(t('glossary.export.copied', { count: failure.count }), 'success');
    } catch {
      app.notify(t('glossary.export.failed'), 'error');
    }
  }

  async function exportList(): Promise<void> {
    if (exporting || dirty || saving) return;
    exporting = true;
    exportFailure = null;
    try {
      const result = await exportGlossary(activeScope, app.worldDir, 'csv');
      if (!result.count) {
        app.notify(t('glossary.export.empty'), 'info');
        return;
      }
      try {
        // The app opens a save dialog (a dismissed one says nothing); a browser downloads the file.
        if (await exportDocument('glossary_csv', result.text, exportFileName(activeScope, 'csv'))) {
          app.notify(t('glossary.export.saved', { count: result.count }), 'success');
        }
      } catch (cause) {
        exportFailure = { message: app.describe(cause), text: result.text, count: result.count };
      }
    } catch (cause) {
      app.notify(cause instanceof BackendError ? app.describe(cause) : t('glossary.export.failed'), 'error');
    } finally {
      exporting = false;
    }
  }

  // A note grows with its lines. Where the browser can size a field by its content it does so
  // itself (CSS field-sizing); elsewhere the height follows the text.
  const NATIVE_AUTOSIZE = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content');
  function autosize(node: HTMLTextAreaElement, _text: string) {
    const fit = () => {
      if (NATIVE_AUTOSIZE || !node.isConnected) return;
      node.style.height = 'auto';
      if (node.scrollHeight > 0) node.style.height = `${node.scrollHeight + node.offsetHeight - node.clientHeight}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return { update: fit, destroy: () => window.removeEventListener('resize', fit) };
  }
</script>

<div class="page glossary">
  <PageHeader title={t('glossary.title')} lead={t('glossary.lead')}>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary btn-sm" disabled={loading || dirty || saving} title={dirty ? t('glossary.needSaved') : undefined} onclick={() => (importing = true)}>
        <Icon name="download" size={14} /> {t('glossary.import')}
      </button>
      <button type="button" class="btn btn-secondary btn-sm" disabled={loading || dirty || saving || exporting || count === 0} title={dirty ? t('glossary.needSaved') : undefined} onclick={exportList}>
        {t('glossary.export')}
      </button>
    {/snippet}
  </PageHeader>

  <section class="scope" aria-labelledby="glossary-scope-label">
    <span class="label" id="glossary-scope-label">{t('glossary.scope.label')}</span>
    <div class="segmented" role="group" aria-labelledby="glossary-scope-label">
      <button type="button" aria-pressed={activeScope === 'global'} disabled={dirty || saving} onclick={() => setScope('global')}>{t('glossary.scope.global')}</button>
      <button type="button" aria-pressed={activeScope === 'world'} disabled={!hasWorld || dirty || saving} onclick={() => setScope('world')}>{t('glossary.scope.world')}</button>
    </div>
    <p class="hint">
      {#if hasWorld}<span class="world" title={app.worldDir}>{t('glossary.scope.worldName', { name: worldName })}</span> · {t('glossary.scope.help')}{:else}{t('glossary.scope.noWorld')}{/if}
    </p>
  </section>

  {#if conflict}
    <Callout tone="warning" title={t('glossary.conflict.title')} role="alert">
      {t('glossary.conflict.body')}
      {#snippet actions()}
        <button type="button" class="btn btn-secondary btn-sm" onclick={reloadSaved}>{t('glossary.conflict.reload')}</button>
        <button type="button" class="btn btn-primary btn-sm" onclick={keepMine}>{t('glossary.conflict.keep')}</button>
      {/snippet}
    </Callout>
  {/if}

  {#if error}
    <Callout tone="danger" title={t('error.title')} role="alert">{error}</Callout>
  {/if}

  {#if exportFailure}
    <Callout tone="danger" title={t('glossary.export.failed')} role="alert">
      {exportFailure.message}
      {#snippet actions()}
        <button type="button" class="btn btn-secondary btn-sm" onclick={copyExport}>{t('glossary.export.copy')}</button>
        <button type="button" class="btn btn-quiet btn-sm" onclick={() => (exportFailure = null)}>{t('common.close')}</button>
      {/snippet}
    </Callout>
  {/if}

  {#if loading && !drafts.length}
    <p class="muted" role="status">{t('glossary.loading')}</p>
  {:else if loadError}
    <Callout tone="danger" title={t('glossary.loadFailed')} role="alert">
      {loadError}
      {#snippet actions()}
        <button type="button" class="btn btn-secondary btn-sm" onclick={() => load()}>{t('glossary.retry')}</button>
      {/snippet}
    </Callout>
  {:else if drafts.length === 0}
    <StatusScreen icon="book" title={t('glossary.empty.title')}>
      <p>{t('glossary.empty.body')}</p>
      {#snippet actions()}
        <button type="button" class="btn btn-primary" id="glossary-add" disabled={saving} onclick={() => addRow()}><Icon name="plus" size={16} /> {t('glossary.empty.add')}</button>
      {/snippet}
    </StatusScreen>
  {:else}
    <div class="bar">
      <div class="search">
        <label class="sr-only" for="glossary-search">{t('glossary.search')}</label>
        <Icon name="search" size={16} />
        <input id="glossary-search" class="input" type="search" autocomplete="off" placeholder={t('glossary.search.placeholder')} bind:value={query} oninput={() => { pinned = []; renderLimit = PAGE_SIZE; }} />
      </div>
      <p class="count num" role="status" aria-live="polite">
        {#if filtering}{t('glossary.count.shown', { shown: formatNumber(visible.length, app.locale), count: formatNumber(count, app.locale), max: formatNumber(GLOSSARY_LIMIT, app.locale) })}
        {:else}{t('glossary.count', { count: formatNumber(count, app.locale), max: formatNumber(GLOSSARY_LIMIT, app.locale) })}{/if}
      </p>
      <button type="button" class="btn btn-primary btn-sm" id="glossary-add" disabled={full || saving} onclick={() => addRow()}><Icon name="plus" size={14} /> {t('glossary.add')}</button>
    </div>
    {#if full}<p class="hint" role="status">{t('glossary.full', { max: formatNumber(GLOSSARY_LIMIT, app.locale) })}</p>{/if}
    {#if problems.length}<p class="field-error" role="alert">{t('glossary.problems', { count: new Set(problems.map((item) => item.key)).size })}</p>{/if}

    <div class="entries-wrap">
      <div class="head" aria-hidden="true">
        <span>{t('glossary.col.source')}</span><span>{t('glossary.col.mode')}</span><span>{t('glossary.col.target')}</span>
        <span>{t('glossary.col.case')}</span><span>{t('glossary.col.note')}</span><span></span>
      </div>
      {#if visible.length === 0}
        <p class="muted none" role="status">{t('glossary.noMatch')}</p>
      {:else}
        <ul class="entries" class:long={shown.length > PAGE_SIZE} aria-label={t('glossary.list')} aria-busy={saving ? 'true' : undefined}>
          {#each shown as draft (draft.key)}
            {@const n = numbers.get(draft.key) ?? 0}
            {@const sourceError = problemFor(draft.key, 'source')}
            {@const targetError = problemFor(draft.key, 'target')}
            {@const noteError = problemFor(draft.key, 'note')}
            <li class="entry" class:invalid={rowHasProblem(draft.key)}>
              <div class="cell c-source">
                <input id={`g-source-${draft.key}`} class="input" type="text" autocomplete="off" spellcheck="false" lang="en"
                  value={draft.source} readonly={saving} placeholder={t('glossary.source.placeholder')} aria-label={t('glossary.field.source', { n })}
                  aria-invalid={sourceError ? 'true' : undefined} aria-describedby={sourceError ? `g-source-err-${draft.key}` : undefined}
                  oninput={(event) => update(draft.key, { source: event.currentTarget.value })} onkeydown={(event) => onFieldKey(event, draft.key)} />
              </div>
              <div class="cell c-mode">
                <select id={`g-mode-${draft.key}`} class="select" aria-label={t('glossary.field.mode', { n })} value={draft.mode} disabled={saving}
                  onchange={(event) => update(draft.key, { mode: event.currentTarget.value === 'keep' ? 'keep' : 'translate' })}>
                  <option value="translate">{t('glossary.mode.translate')}</option>
                  <option value="keep">{t('glossary.mode.keep')}</option>
                </select>
              </div>
              <div class="cell c-target">
                <input id={`g-target-${draft.key}`} class="input" type="text" autocomplete="off" spellcheck="false"
                  value={draft.mode === 'keep' ? '' : draft.target} disabled={draft.mode === 'keep'} readonly={saving}
                  placeholder={draft.mode === 'keep' ? t('glossary.target.keep') : t('glossary.target.placeholder')} aria-label={t('glossary.field.target', { n })}
                  aria-invalid={targetError ? 'true' : undefined} aria-describedby={targetError ? `g-target-err-${draft.key}` : undefined}
                  oninput={(event) => update(draft.key, { target: event.currentTarget.value })} onkeydown={(event) => onFieldKey(event, draft.key)} />
              </div>
              <label class="cell c-case case">
                <input id={`g-case-${draft.key}`} type="checkbox" checked={draft.caseSensitive} disabled={saving} aria-label={t('glossary.field.case', { n })}
                  onchange={(event) => update(draft.key, { caseSensitive: event.currentTarget.checked })} />
                <span class="case-text" aria-hidden="true">{t('glossary.col.case')}</span>
              </label>
              <div class="cell c-note">
                <textarea id={`g-note-${draft.key}`} class="input note" rows="1" autocomplete="off" spellcheck="false" use:autosize={draft.note}
                  value={draft.note} readonly={saving} placeholder={t('glossary.note.placeholder')}
                  aria-label={t('glossary.field.note', { n })} aria-invalid={noteError ? 'true' : undefined} aria-describedby={noteError ? `g-note-err-${draft.key}` : undefined}
                  oninput={(event) => update(draft.key, { note: event.currentTarget.value })}></textarea>
              </div>
              <div class="cell c-end">
                <button type="button" id={`g-delete-${draft.key}`} class="btn btn-quiet btn-icon btn-sm" aria-label={t('glossary.delete.label', { n })} title={t('glossary.delete')} disabled={saving} onclick={() => askDelete(draft.key)}>
                  <Icon name="trash" size={16} />
                </button>
              </div>
              {#if confirmDelete === draft.key}
                <div class="ask" role="group" aria-label={t('glossary.delete.ask')}>
                  <span>{t('glossary.delete.ask')}</span>
                  <button type="button" id={`g-delete-yes-${draft.key}`} class="btn btn-danger btn-sm" disabled={saving} onclick={() => remove(draft.key)} onkeydown={(event) => askKey(event, draft.key)}>{t('glossary.delete.confirm')}</button>
                  <button type="button" class="btn btn-quiet btn-sm" onclick={() => cancelDelete(draft.key)} onkeydown={(event) => askKey(event, draft.key)}>{t('common.cancel')}</button>
                </div>
              {/if}
              {#if sourceError}<p class="row-error" id={`g-source-err-${draft.key}`}>{sourceError}</p>{/if}
              {#if targetError}<p class="row-error" id={`g-target-err-${draft.key}`}>{targetError}</p>{/if}
              {#if noteError}<p class="row-error" id={`g-note-err-${draft.key}`}>{noteError}</p>{/if}
            </li>
          {/each}
        </ul>
        {#if visible.length > shown.length}
          <button type="button" class="btn btn-secondary more" onclick={() => (renderLimit += PAGE_SIZE)}>{t('glossary.more', { count: formatNumber(visible.length - shown.length, app.locale) })}</button>
        {/if}
      {/if}
    </div>
    <p class="hint">{t('glossary.delete.hint')}</p>
  {/if}

  {#if dirty}
    <div class="action-bar">
      <div class="note"><span>{t('glossary.dirty')}</span></div>
      <div class="buttons">
        <button type="button" class="btn btn-secondary" disabled={saving} onclick={discard}>{t('glossary.discard')}</button>
        <button type="button" class="btn btn-primary" disabled={saving} onclick={() => save()}>
          <Icon name="check" size={15} /> {t(saving ? 'glossary.saving' : 'glossary.save')}
        </button>
      </div>
    </div>
  {/if}
</div>

{#if importing}
  <GlossaryImportDialog scope={activeScope} worldDir={app.worldDir} {revision} entryCount={count} onDone={imported} onStale={stale} onClose={() => (importing = false)} />
{/if}

{#if app.pendingLeave}
  <Dialog showClose={false} title={t('glossary.leave.title')} onClose={() => app.resolveLeave(false)}>
    <p>{t('glossary.leave.body')}</p>
    {#snippet actions()}
      <button type="button" class="btn btn-quiet leave-stay" disabled={saving} onclick={() => app.resolveLeave(false)}>{t('glossary.leave.stay')}</button>
      <button type="button" class="btn btn-secondary" disabled={saving} onclick={leaveWithoutSaving}>{t('glossary.leave.discard')}</button>
      <button type="button" class="btn btn-primary" data-autofocus disabled={saving} onclick={saveAndLeave}>{t(saving ? 'glossary.saving' : 'glossary.leave.save')}</button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .scope { display: grid; gap: var(--space-2); justify-items: start; }
  .scope .label { font-size: var(--text-sm); font-weight: 600; color: var(--text-secondary); }
  .scope .hint { margin: 0; }
  .world { font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
  .search { position: relative; flex: 1 1 240px; max-width: 420px; }
  .search :global(.icon) { position: absolute; inset-inline-start: 10px; top: 50%; translate: 0 -50%; color: var(--text-secondary); pointer-events: none; }
  .search .input { padding-inline-start: 32px; }
  .count { margin: 0; font-size: var(--text-sm); color: var(--text-secondary); margin-inline-start: auto; }
  .field-error { margin: 0; color: var(--danger-text); font-size: var(--text-sm); font-weight: 600; }
  .entries-wrap { container: glossary-list / inline-size; display: grid; gap: var(--space-2); }
  .head, .entry {
    display: grid; grid-template-columns: minmax(140px, 1.3fr) 150px minmax(140px, 1.3fr) 56px minmax(100px, 1fr) 96px; gap: var(--space-2); align-items: center;
  }
  .head { padding: 0 var(--space-3); font-size: var(--text-overline); font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-secondary); }
  .head span:nth-child(4) { text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .entries { list-style: none; margin: 0; padding: 0; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-xl); box-shadow: var(--shadow-card); overflow: hidden; }
  .entry { padding: var(--space-2) var(--space-3); }
  /* Past the first page (up to 2,000 rows) the rows far off screen are not laid out or painted until they
     come near, and the size they had is remembered. Up to one page every row stays laid out, so assistive
     technology sees the whole list; browsers without content-visibility just lay everything out. */
  .entries.long .entry { content-visibility: auto; contain-intrinsic-size: auto 34px; }
  .entry + .entry { border-top: 1px solid var(--border); }
  .entry.invalid { background: var(--danger-soft); }
  .entry .input[aria-invalid='true'] { border-color: var(--danger-solid); }
  .cell { min-width: 0; }
  /* A text field of a fixed size and its own layout: typing in it lays out that field, not the whole list. */
  .entry input.input { height: var(--control-height); contain: size layout; }
  /* A note is a field that grows with its lines; with one line it looks like the other fields. */
  .note { display: block; resize: none; overflow: hidden; padding-block: 7px; line-height: 1.4; field-sizing: content; white-space: pre-wrap; overflow-wrap: anywhere; }
  .case { display: grid; place-items: center; gap: 2px; cursor: pointer; }
  .case input { width: 16px; height: 16px; accent-color: var(--accent); }
  .case-text { display: none; font-size: var(--text-xs); color: var(--text-secondary); }
  .c-end { display: flex; justify-content: flex-end; }
  .ask { grid-column: 1 / -1; display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); justify-content: flex-end; font-size: var(--text-sm); }
  .row-error { grid-column: 1 / -1; margin: 0; font-size: var(--text-sm); color: var(--danger-text); }
  .none { padding: var(--space-4); text-align: center; }
  .more { justify-self: center; }
  :global(.dialog) .leave-stay { margin-inline-end: auto; }
  /* A narrow list: each entry becomes a small card instead of a row of cramped columns. */
  @container glossary-list (max-width: 860px) {
    .head { display: none; }
    .entries.long .entry { contain-intrinsic-size: auto 220px; }
    .entry { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    .c-source { grid-column: 1 / -1; }
    .c-note { grid-column: 1 / -1; }
    .c-target { grid-column: 1; }
    .c-mode { grid-column: 2; }
    .case { grid-template-columns: auto 1fr; justify-items: start; place-items: center start; gap: var(--space-2); }
    .case-text { display: inline; }
    .c-case { grid-column: 1; }
    .c-end { grid-column: 2; }
  }
</style>
