<script lang="ts">
  import { tick, onDestroy } from 'svelte';
  import Dialog from './Dialog.svelte';
  import GlossaryEditor from './GlossaryEditor.svelte';
  import { app } from '../lib/app.svelte';
  import { getGlossary, setGlossary, type GlossaryEntry, type GlossaryScope } from '../lib/api';
  import { t } from '../lib/i18n/index.svelte';
  import { finishClose, type CloseSource } from '../lib/native';

  let { open = $bindable(false), world, initialEntry = null, initialScope = 'world' as GlossaryScope }: {
    open?: boolean; world: string; initialEntry?: GlossaryEntry | null; initialScope?: GlossaryScope;
  } = $props();

  let loading = $state(false);
  let saving = $state(false);
  let scope = $state<GlossaryScope>('world');
  let globalEntries = $state<GlossaryEntry[]>([]);
  let worldEntries = $state<GlossaryEntry[]>([]);
  let globalSaved = $state<GlossaryEntry[]>([]);
  let worldSaved = $state<GlossaryEntry[]>([]);
  let entries = $state<GlossaryEntry[]>([]);
  let invalid = $state(false);
  let error = $state('');
  let confirmDiscard = $state(false);
  let closingSource = $state<CloseSource | null>(null);
  let pendingNavigation: (() => void) | null = null;
  let ready = $state(false);
  let lastOpened = false;
  let seedSource = '';

  const dirty = $derived(ready && (
    JSON.stringify(scope === 'global' ? entries : globalEntries) !== JSON.stringify(globalSaved) ||
    JSON.stringify(scope === 'world' ? entries : worldEntries) !== JSON.stringify(worldSaved)
  ));
  $effect(() => {
    app.settingsDirty = open && dirty;
    app.glossaryGuard = open && dirty ? {
      leave: (next) => { pendingNavigation = next; confirmDiscard = true; },
      close: (source) => { closingSource = source; pendingNavigation = null; confirmDiscard = true; }
    } : null;
  });
  onDestroy(() => { app.settingsDirty = false; app.glossaryGuard = null; });

  function continueEditing(): void {
    confirmDiscard = false;
    closingSource = null;
    pendingNavigation = null;
  }

  function finishPending(): void {
    const source = closingSource;
    const next = pendingNavigation;
    continueEditing();
    if (source) void finishClose(source);
    else next?.();
  }

  $effect(() => {
    const requested = open;
    if (!requested) { lastOpened = false; return; }
    if (lastOpened) return;
    lastOpened = true;
    const selected = initialScope;
    const seed = initialEntry;
    void load(selected, seed);
  });

  async function load(nextScope: GlossaryScope, seed: GlossaryEntry | null): Promise<void> {
    loading = true;
    error = '';
    scope = nextScope;
    ready = false;
    try {
      const result = await getGlossary(world);
      globalEntries = result.global.map((entry) => ({ ...entry }));
      worldEntries = result.world.map((entry) => ({ ...entry }));
      if (seed) {
        seedSource = seed.source;
        const current = nextScope === 'global' ? globalEntries : worldEntries;
        const existing = current.find((entry) => entry.source === seed.source ||
          (entry.source.toLocaleLowerCase() === seed.source.toLocaleLowerCase() && (!entry.caseSensitive || !seed.caseSensitive)));
        if (existing) seedSource = '';
        else if (nextScope === 'global') globalEntries = [...globalEntries, { ...seed }];
        else worldEntries = [...worldEntries, { ...seed }];
      } else seedSource = '';
      globalSaved = globalEntries.map((entry) => ({ ...entry }));
      worldSaved = worldEntries.map((entry) => ({ ...entry }));
      if (seed) {
        if (nextScope === 'global') globalSaved = result.global.map((entry) => ({ ...entry }));
        else worldSaved = result.world.map((entry) => ({ ...entry }));
      }
      entries = (nextScope === 'global' ? globalEntries : worldEntries).map((entry) => ({ ...entry }));
      ready = true;
      invalid = false;
      await tick();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading = false;
    }
  }

  function switchScope(next: GlossaryScope): void {
    if (next === scope) return;
    if (scope === 'global') globalEntries = entries.map((entry) => ({ ...entry }));
    else worldEntries = entries.map((entry) => ({ ...entry }));
    if (seedSource) {
      const from = scope === 'global' ? globalEntries : worldEntries;
      const at = from.findIndex((entry) => entry.source === seedSource);
      if (at >= 0) {
        const [seed] = from.splice(at, 1);
        if (scope === 'global') globalEntries = from; else worldEntries = from;
        if (next === 'global') globalEntries = [...globalEntries, seed];
        else worldEntries = [...worldEntries, seed];
      }
    }
    scope = next;
    entries = (scope === 'global' ? globalEntries : worldEntries).map((entry) => ({ ...entry }));
    invalid = false;
    error = '';
  }

  async function save(): Promise<void> {
    if (!ready || invalid || saving || !dirty) return;
    if (scope === 'global') globalEntries = entries.map((entry) => ({ ...entry }));
    else worldEntries = entries.map((entry) => ({ ...entry }));
    saving = true;
    error = '';
    try {
      if (JSON.stringify(globalEntries) !== JSON.stringify(globalSaved)) {
        const result = await setGlossary('global', globalEntries);
        globalEntries = result.entries;
        globalSaved = result.entries.map((entry) => ({ ...entry }));
        app.settings = { ...app.settings, glossary: result.entries.map((entry) => ({ ...entry })) };
      }
      if (JSON.stringify(worldEntries) !== JSON.stringify(worldSaved)) {
        const result = await setGlossary('world', worldEntries, world);
        worldEntries = result.entries;
        worldSaved = result.entries.map((entry) => ({ ...entry }));
      }
      entries = (scope === 'global' ? globalEntries : worldEntries).map((entry) => ({ ...entry }));
      seedSource = '';
      app.translationReview.reset();
      if (app.scan) void app.loadEstimate();
      open = false;
      app.notify(t('glossary.saved'), 'success');
      finishPending();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      saving = false;
    }
  }

  function discard(): void {
    globalEntries = globalSaved.map((entry) => ({ ...entry }));
    worldEntries = worldSaved.map((entry) => ({ ...entry }));
    entries = (scope === 'global' ? globalEntries : worldEntries).map((entry) => ({ ...entry }));
    seedSource = '';
    invalid = false;
    confirmDiscard = false;
    open = false;
    finishPending();
  }

  function requestClose(): void {
    if (saving) return;
    if (dirty) confirmDiscard = true;
    else open = false;
  }
</script>

{#if open}
  <Dialog title={t('glossary.sheet.title')} size="wide" onClose={requestClose}>
    {#if loading}
      <p role="status">{t('common.loading')}</p>
    {:else if ready}
      <div class="sheet">
        <label class="scope">
          <span class="label">{t('glossary.scope')}</span>
          <select class="select" value={scope} aria-label={t('glossary.scope')} onchange={(event) => switchScope(event.currentTarget.value as GlossaryScope)}>
            <option value="world">{t('glossary.scope.world')}</option>
            <option value="global">{t('glossary.scope.global')}</option>
          </select>
        </label>
        <p class="hint">{t(scope === 'world' ? 'glossary.sheet.worldHelp' : 'glossary.sheet.globalHelp')}</p>
        <GlossaryEditor bind:entries bind:invalid />
        {#if error}<p class="error" role="alert">{error}</p>{/if}
      </div>
    {:else if error}
      <p class="error" role="alert">{error}</p>
    {/if}
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" disabled={saving} onclick={requestClose}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-primary" disabled={!ready || !dirty || invalid || saving} onclick={save}>{saving ? t('settings.saving') : t('glossary.save')}</button>
    {/snippet}
  </Dialog>
{/if}

{#if confirmDiscard}
  <Dialog title={t(closingSource ? 'settings.close.title' : 'settings.leave.title')} hideClose onClose={continueEditing}>
    <p>{t('glossary.unsavedHelp')}</p>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" disabled={saving} data-autofocus onclick={continueEditing}>{t('settings.leave.stay')}</button>
      <button type="button" class="btn btn-danger" disabled={saving} onclick={discard}>{t(closingSource ? 'settings.close.discard' : 'settings.discard')}</button>
      <button type="button" class="btn btn-primary" disabled={!ready || invalid || saving} onclick={save}>{t(closingSource ? 'settings.close.save' : 'glossary.save')}</button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .sheet { display: grid; gap: var(--space-3); min-width: 0; }
  .scope { display: grid; grid-template-columns: minmax(120px, 1fr) minmax(180px, 2fr); align-items: center; gap: var(--space-3); max-width: 520px; }
  .scope .label { margin: 0; }
  .hint, .error { margin: 0; }
  .error { color: var(--danger-text); font-size: var(--text-sm); }
  @media (max-width: 480px) { .scope { grid-template-columns: 1fr; gap: var(--space-1); } }
</style>
