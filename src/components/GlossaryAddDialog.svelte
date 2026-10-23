<script lang="ts">
  import { untrack } from 'svelte';
  import { app } from '../lib/app.svelte';
  import type { GlossaryMode, GlossaryScope } from '../lib/api';
  import { t } from '../lib/i18n/index.svelte';
  import { addGlossaryEntry, blankDraft, validateDrafts, MAX_SOURCE_CHARS, MAX_TARGET_CHARS } from '../lib/glossary';
  import Dialog from './Dialog.svelte';

  // Adds one rule to the stored glossary without leaving the review. The source starts as the part of
  // the sentence the person selected, or the whole sentence.
  let { source, onClose }: { source: string; onClose: () => void } = $props();

  // The dialog is opened fresh for each sentence, so the starting text is read once.
  let text = $state(untrack(() => source));
  let mode = $state<GlossaryMode>('translate');
  let target = $state('');
  let scope = $state<GlossaryScope>('global');
  let working = $state(false);
  let error = $state('');
  let exists = $state(false);
  const hasWorld = $derived(!!app.worldDir);
  const activeScope = $derived<GlossaryScope>(scope === 'world' && hasWorld ? 'world' : 'global');
  const draft = $derived(blankDraft({ source: text, target, mode }));
  const problem = $derived.by(() => {
    const found = validateDrafts([draft])[0];
    if (!found) return '';
    if (found.reason === 'tooLong') return t('glossary.problem.tooLong', { max: found.field === 'source' ? MAX_SOURCE_CHARS : MAX_TARGET_CHARS });
    return t(`glossary.problem.${found.reason}` as 'glossary.problem.required');
  });
  // A rule is shown only after a try, so the empty form is not scolded.
  let tried = $state(false);

  async function submit(): Promise<void> {
    tried = true;
    error = '';
    exists = false;
    if (problem || working) return;
    working = true;
    try {
      const result = await addGlossaryEntry(activeScope, app.worldDir, draft);
      if (result.status === 'exists') {
        exists = true;
        return;
      }
      app.notify(t('glossary.addDialog.done'), 'success');
      onClose();
    } catch (cause) {
      error = app.describe(cause);
    } finally {
      working = false;
    }
  }

  function openGlossary(): void {
    onClose();
    app.goto('glossary');
  }
</script>

<Dialog title={t('glossary.addDialog.title')} {onClose}>
  <form id="glossary-add-form" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
    <div class="field">
      <label class="label" for="glossary-add-source">{t('glossary.addDialog.source')}</label>
      <input id="glossary-add-source" class="input" type="text" autocomplete="off" spellcheck="false" lang="en" bind:value={text} data-autofocus />
    </div>
    <div class="field">
      <span class="label" id="glossary-add-mode">{t('glossary.addDialog.mode')}</span>
      <div class="segmented" role="group" aria-labelledby="glossary-add-mode">
        <button type="button" aria-pressed={mode === 'translate'} onclick={() => (mode = 'translate')}>{t('glossary.mode.translate')}</button>
        <button type="button" aria-pressed={mode === 'keep'} onclick={() => (mode = 'keep')}>{t('glossary.mode.keep')}</button>
      </div>
    </div>
    {#if mode === 'translate'}
      <div class="field">
        <label class="label" for="glossary-add-target">{t('glossary.addDialog.target')}</label>
        <input id="glossary-add-target" class="input" type="text" autocomplete="off" spellcheck="false" placeholder={t('glossary.target.placeholder')} bind:value={target} />
      </div>
    {:else}
      <p class="hint">{t('glossary.target.keep')}</p>
    {/if}
    <div class="field">
      <span class="label" id="glossary-add-scope">{t('glossary.addDialog.scope')}</span>
      <div class="segmented" role="group" aria-labelledby="glossary-add-scope">
        <button type="button" aria-pressed={activeScope === 'global'} onclick={() => (scope = 'global')}>{t('glossary.scope.global')}</button>
        <button type="button" aria-pressed={activeScope === 'world'} disabled={!hasWorld} onclick={() => (scope = 'world')}>{t('glossary.scope.world')}</button>
      </div>
    </div>
    {#if tried && problem}<p class="problem" role="alert">{problem}</p>{/if}
    {#if exists}
      <p class="problem" role="alert">{t('glossary.addDialog.exists')} <button type="button" class="btn btn-quiet btn-sm" onclick={openGlossary}>{t('glossary.addDialog.openGlossary')}</button></p>
    {/if}
    {#if error}<p class="problem" role="alert">{error}</p>{/if}
    <p class="hint">{t('glossary.addDialog.note')}</p>
  </form>
  {#snippet actions()}
    <button type="button" class="btn btn-secondary" disabled={working} onclick={onClose}>{t('common.cancel')}</button>
    <button type="submit" form="glossary-add-form" class="btn btn-primary" disabled={working}>{t(working ? 'glossary.addDialog.adding' : 'glossary.addDialog.submit')}</button>
  {/snippet}
</Dialog>

<style>
  form { display: grid; gap: var(--space-3); }
  .problem { margin: 0; color: var(--danger-text); font-weight: 600; font-size: var(--text-sm); }
  .hint { margin: 0; }
</style>
