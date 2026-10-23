<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { BackendError, type GlossaryImportResult, type GlossaryScope } from '../lib/api';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import { formatNumber } from '../lib/format';
  import { formatFromName, importGlossary, isSkipReason, MAX_IMPORT_CHARS } from '../lib/glossary';
  import Dialog from './Dialog.svelte';

  let { scope, worldDir, revision, entryCount, onDone, onStale, onClose }: {
    scope: GlossaryScope; worldDir: string; revision: number; entryCount: number;
    /** The import went through; the list on the page takes the new contents. */
    onDone: (result: GlossaryImportResult) => void;
    /** The list changed since it was loaded (GLOSSARY_CONFLICT): the page loads it again. */
    onStale: () => void;
    onClose: () => void;
  } = $props();

  // The file is read here, as text; nothing but its contents is sent, never a path.
  let input: HTMLInputElement | undefined = $state();
  let fileName = $state('');
  let text = $state('');
  let format = $state<'csv' | 'tsv'>('csv');
  let mode = $state<'merge' | 'replace'>('merge');
  let working = $state(false);
  let error = $state('');
  let confirmReplace = $state(false);
  let result = $state<GlossaryImportResult | null>(null);

  async function pick(event: Event): Promise<void> {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    error = '';
    try {
      // Up to four bytes a character; the core's own limit is on characters.
      if (file.size > MAX_IMPORT_CHARS * 4) throw new BackendError('large', 'TOO_BIG');
      const content = await file.text();
      if (content.length > MAX_IMPORT_CHARS) throw new BackendError('large', 'TOO_BIG');
      text = content;
      fileName = file.name;
      format = formatFromName(file.name);
    } catch (cause) {
      text = '';
      fileName = '';
      error = cause instanceof BackendError && cause.code === 'TOO_BIG' ? t('glossary.import.tooBig') : t('glossary.import.readFailed');
    }
  }

  function run(): void {
    if (!text) {
      error = t('glossary.import.noFile');
      return;
    }
    if (mode === 'replace' && entryCount > 0) confirmReplace = true;
    else void go();
  }

  async function go(): Promise<void> {
    confirmReplace = false;
    working = true;
    error = '';
    try {
      result = await importGlossary(scope, worldDir, revision, text, format, mode);
      onDone(result);
    } catch (cause) {
      if (cause instanceof BackendError && cause.code === 'GLOSSARY_INVALID') error = t('glossary.import.invalid');
      else {
        error = app.describe(cause);
        if (cause instanceof BackendError && cause.code === 'GLOSSARY_CONFLICT') onStale();
      }
    } finally {
      working = false;
    }
  }

  const reasonText = (reason: string): string => t((isSkipReason(reason) ? `glossary.skip.${reason}` : 'glossary.skip.unknown') as MessageKey);
</script>

<Dialog title={result ? t('glossary.import.resultTitle') : t('glossary.import.title')} size={result?.skippedCount ? 'wide' : 'normal'} {onClose}>
  {#if result}
    <dl class="counts">
      <div><dt>{t('glossary.import.added')}</dt><dd class="num">{formatNumber(result.added, app.locale)}</dd></div>
      <div><dt>{t('glossary.import.updated')}</dt><dd class="num">{formatNumber(result.updated, app.locale)}</dd></div>
      <div><dt>{t('glossary.import.unchanged')}</dt><dd class="num">{formatNumber(result.unchanged, app.locale)}</dd></div>
      <div><dt>{t('glossary.import.removed')}</dt><dd class="num">{formatNumber(result.removed, app.locale)}</dd></div>
    </dl>
    {#if result.skippedCount > 0}
      <section aria-labelledby="skipped-title">
        <h3 id="skipped-title">{t('glossary.import.skipped', { count: formatNumber(result.skippedCount, app.locale) })}</h3>
        <ul class="skipped">
          {#each result.skipped as item (item.row)}
            <li><span>{t('glossary.import.skippedRow', { row: formatNumber(item.row, app.locale), reason: reasonText(item.reason) })}</span>{#if item.source}<span class="muted src"> · {item.source}</span>{/if}</li>
          {/each}
        </ul>
        {#if result.skippedCount > result.skipped.length}<p class="muted">{t('glossary.import.skippedMore', { shown: formatNumber(result.skipped.length, app.locale) })}</p>{/if}
      </section>
    {/if}
  {:else}
    <p>{t('glossary.import.help')}</p>
    <div class="pick">
      <input type="file" accept=".csv,.tsv,.tab,.txt,text/csv,text/tab-separated-values,text/plain" bind:this={input} onchange={pick} hidden />
      <button type="button" class="btn btn-secondary" disabled={working} onclick={() => input?.click()}>{t('glossary.import.pick')}</button>
      {#if fileName}<span class="muted file" role="status">{t('glossary.import.chosen', { name: fileName })}</span>{/if}
    </div>
    <fieldset class="modes" disabled={working}>
      <legend>{t('glossary.import.mode')}</legend>
      <label class="check"><input type="radio" name="glossary-import-mode" value="merge" bind:group={mode} /><span>{t('glossary.import.merge')}</span></label>
      <label class="check"><input type="radio" name="glossary-import-mode" value="replace" bind:group={mode} /><span>{t('glossary.import.replace')}</span></label>
    </fieldset>
    {#if error}<p class="problem" role="alert">{error}</p>{/if}
  {/if}
  <!-- The snippet sits at the top level of the dialog's content, or the dialog would not receive it. -->
  {#snippet actions()}
    {#if result}
      <button type="button" class="btn btn-primary" data-autofocus onclick={onClose}>{t('common.close')}</button>
    {:else}
      <button type="button" class="btn btn-quiet" disabled={working} onclick={onClose}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-primary" data-autofocus disabled={working || !text} onclick={run}>{t('glossary.import.run')}</button>
    {/if}
  {/snippet}
</Dialog>

{#if confirmReplace}
  <Dialog showClose={false} tone="danger" title={t('glossary.import.replaceTitle')} onClose={() => (confirmReplace = false)}>
    <p>{t('glossary.import.replaceBody', { count: formatNumber(entryCount, app.locale) })}</p>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" data-autofocus onclick={() => (confirmReplace = false)}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-danger-solid" onclick={go}>{t('glossary.import.replaceConfirm')}</button>
    {/snippet}
  </Dialog>
{/if}

<style>
  p { margin: 0; }
  .pick { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
  .file { overflow-wrap: anywhere; }
  .modes { display: grid; gap: var(--space-2); margin: 0; padding: 0; border: 0; }
  .modes legend { font-weight: 600; margin-bottom: var(--space-2); padding: 0; }
  .modes .check { align-items: flex-start; }
  .modes .check input { margin-top: 3px; }
  .problem { color: var(--danger-text); font-weight: 600; font-size: var(--text-sm); }
  .counts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); margin: 0; }
  .counts div { display: grid; gap: 2px; padding: var(--space-3); border-radius: var(--radius-lg); background: var(--bg-sunken); }
  .counts dt { font-size: var(--text-sm); color: var(--text-secondary); }
  .counts dd { margin: 0; font-size: var(--text-xl); font-weight: 650; }
  h3 { font-size: var(--text-md); font-weight: 600; margin-bottom: var(--space-2); }
  .skipped { list-style: none; margin: 0 0 var(--space-2); padding: 0; display: grid; gap: var(--space-1); font-size: var(--text-sm); }
  .skipped li { padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--bg-sunken); overflow-wrap: anywhere; }
  @media (max-width: 520px) { .counts { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
