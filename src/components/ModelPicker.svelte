<script lang="ts">
  import type { ModelInfo } from '../lib/api';
  import { app } from '../lib/app.svelte';
  import { formatUsd } from '../lib/format';
  import { t } from '../lib/i18n/index.svelte';
  import { filterModels, formatContext, isSuitable, modelPrices, recommendedModels } from '../lib/models';
  import { supportsReasoning } from '../lib/reasoning';
  import Icon from './Icon.svelte';

  // A combobox for choosing a model: search, a "recommended" group, price and size at a glance,
  // and any other id can still be typed. `inline` keeps the list open in the page (the setup
  // wizard); otherwise it opens as a popup under the field.
  let {
    id = 'model', value = $bindable(''), models, inline = false, placeholder = '', describedby, disabled = false
  }: {
    id?: string; value?: string; models: ModelInfo[]; inline?: boolean; placeholder?: string; describedby?: string; disabled?: boolean;
  } = $props();

  const LIMIT = 120;
  let popup = $state(false);
  let query = $state('');
  let typing = $state(false);
  let active = $state(-1);
  let showHidden = $state(false);
  let input: HTMLInputElement | undefined = $state();

  const listId = `${id}-listbox`;
  const open = $derived(inline || popup);
  const hiddenCount = $derived(models.filter((model) => !isSuitable(model)).length);
  const usable = $derived(showHidden ? models : models.filter(isSuitable));
  const searching = $derived(typing && query.trim().length > 0);
  const recommended = $derived(searching ? [] : recommendedModels(usable));
  const rest = $derived.by(() => {
    if (searching) return filterModels(usable, query);
    const chosen = new Set(recommended.map((model) => model.id));
    return usable.filter((model) => !chosen.has(model.id));
  });
  const shownRest = $derived(rest.slice(0, LIMIT));
  const typed = $derived(value.trim());
  const isCustom = $derived(!!typed && !models.some((model) => model.id === typed));
  type Row = { kind: 'model'; model: ModelInfo; heading?: string } | { kind: 'custom'; heading?: string };
  const rows = $derived.by(() => {
    const out: Row[] = [];
    recommended.forEach((model, index) => out.push({ kind: 'model', model, heading: index === 0 ? t('picker.recommended') : undefined }));
    shownRest.forEach((model, index) => out.push({
      kind: 'model', model, heading: index === 0 ? (searching ? t('picker.results', { count: rest.length }) : t('picker.all')) : undefined
    }));
    if (typed && isCustom) out.push({ kind: 'custom', heading: out.length ? t('picker.other') : undefined });
    return out;
  });

  $effect(() => { void rows.length; if (active >= rows.length) active = rows.length - 1; });

  function show(): void {
    if (disabled) return;
    popup = true;
  }
  function hide(): void {
    popup = false;
    typing = false;
    query = '';
    active = -1;
  }
  function choose(row: Row): void {
    if (row.kind === 'model') value = row.model.id;
    hide();
    input?.focus();
  }
  function onInput(event: Event): void {
    value = (event.currentTarget as HTMLInputElement).value;
    query = value;
    typing = true;
    popup = true;
    active = -1;
  }
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { show(); return; }
      if (!rows.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + rows.length) % rows.length;
      document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && open && active >= 0 && rows[active]) {
      event.preventDefault();
      choose(rows[active]);
    } else if (event.key === 'Escape' && popup) {
      // Closing the list must not also close a dialog around it.
      event.preventDefault();
      event.stopPropagation();
      hide();
    } else if (event.key === 'Home' && open && active >= 0) {
      event.preventDefault();
      active = 0;
    } else if (event.key === 'End' && open && active >= 0) {
      event.preventDefault();
      active = rows.length - 1;
    }
  }

  const price = (model: ModelInfo): string => {
    const { input: from, output: to } = modelPrices(model);
    return from === null || to === null ? '' : `${formatUsd(from, app.locale)} / ${formatUsd(to, app.locale)}`;
  };
</script>

<div class="picker" class:inline>
  <div class="field-row">
    <input
      {id}
      bind:this={input}
      class="input"
      type="text"
      role="combobox"
      aria-expanded={open}
      aria-controls={listId}
      aria-autocomplete="list"
      aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
      aria-describedby={describedby}
      autocomplete="off"
      spellcheck="false"
      {placeholder}
      {disabled}
      {value}
      oninput={onInput}
      onfocus={() => { if (!inline) show(); }}
      onclick={show}
      onblur={hide}
      onkeydown={onKeydown}
    />
    {#if !inline}
      <button type="button" class="btn btn-secondary btn-icon toggle" tabindex="-1" {disabled} aria-label={t('picker.toggle')}
        onmousedown={(event) => event.preventDefault()} onclick={() => { if (popup) hide(); else { show(); input?.focus(); } }}>
        <Icon name="chevron-down" size={16} />
      </button>
    {/if}
  </div>

  {#if open}
    <div class="list" id={listId} role="listbox" aria-label={t('picker.list')} tabindex="-1" onmousedown={(event) => event.preventDefault()}>
      {#if !rows.length}
        <p class="empty">{models.length ? t('picker.noMatch') : t('picker.empty')}</p>
      {/if}
      {#each rows as row, index (row.kind === 'model' ? row.model.id : 'custom')}
        {#if row.heading}<div class="group-title" aria-hidden="true">{row.heading}</div>{/if}
        {#if row.kind === 'model'}
          {@const model = row.model}
          <!-- Keyboard use is handled by the combobox field, as in the ARIA pattern. -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div id="{id}-opt-{index}" class="option" class:active={index === active} class:selected={model.id === typed} role="option" aria-selected={model.id === typed}
            tabindex="-1" onclick={() => choose(row)}>
            <span class="main">
              <span class="name">{model.display_name && model.display_name !== model.id ? model.display_name : model.id}</span>
              {#if model.display_name && model.display_name !== model.id}<span class="mono model-id">{model.id}</span>{/if}
            </span>
            <span class="meta">
              {#if !isSuitable(model)}<span class="pill pill-warning">{t('picker.unsuitable')}</span>{/if}
              {#if supportsReasoning(model)}<span class="pill pill-accent">{t('picker.reasoning')}</span>{/if}
              {#if model.context_length}<span class="num" title={t('picker.context')}>{formatContext(model.context_length)}</span>{/if}
              {#if price(model)}<span class="num" title={t('picker.priceTitle')}>{price(model)}</span>{/if}
            </span>
            {#if model.id === typed}<Icon name="check" size={14} />{/if}
          </div>
        {:else}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div id="{id}-opt-{index}" class="option custom" class:active={index === active} role="option" aria-selected="false"
            tabindex="-1" onclick={() => choose(row)}>
            <span class="main"><span class="name">{t('picker.custom')}</span><span class="mono model-id">{typed}</span></span>
          </div>
        {/if}
      {/each}
      {#if rest.length > LIMIT}<p class="empty">{t('picker.more', { count: rest.length - LIMIT })}</p>{/if}
    </div>
  {/if}

  {#if hiddenCount > 0}
    <div class="hidden-note">
      <span>{t(showHidden ? 'picker.hiddenShown' : 'picker.hidden', { count: hiddenCount })}</span>
      <button type="button" class="btn btn-quiet btn-sm" aria-pressed={showHidden} onclick={() => (showHidden = !showHidden)}>
        {t(showHidden ? 'picker.hideThem' : 'picker.showThem')}
      </button>
    </div>
  {/if}
</div>

<style>
  .picker { position: relative; display: grid; gap: var(--space-2); min-width: 0; }
  .field-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2); }
  .toggle { min-height: var(--control-height); }
  .input { min-width: 0; font-family: var(--font-mono); font-size: var(--text-md); }
  .list { overflow: auto; max-height: 320px; padding: var(--space-1); border: 1px solid var(--border-strong); border-radius: var(--radius-lg); background: var(--bg-surface); display: grid; align-content: start; gap: 1px; }
  .picker:not(.inline) .list { position: absolute; z-index: 30; inset-inline: 0; inset-block-start: calc(var(--control-height) + 4px); box-shadow: var(--shadow-pop); }
  .inline .list { max-height: min(300px, 38dvh); }
  .group-title { padding: var(--space-2) var(--space-2) var(--space-1); color: var(--text-secondary); font-size: var(--text-xs); font-weight: 700; letter-spacing: 0.02em; }
  .option { display: flex; align-items: center; gap: var(--space-3); padding: 6px var(--space-2); border-radius: var(--radius-md); cursor: pointer; min-width: 0; }
  .option.active { background: var(--bg-hover); outline: 2px solid var(--focus-ring); outline-offset: -2px; }
  .option.selected { background: var(--accent-soft); color: var(--accent-soft-text); }
  @media (hover: hover) { .option:hover { background: var(--bg-hover); } .option.selected:hover { background: var(--accent-soft); } }
  .main { flex: 1; min-width: 0; display: grid; gap: 1px; }
  .name { font-size: var(--text-md); font-weight: 600; overflow-wrap: anywhere; }
  .model-id { color: var(--text-secondary); font-size: var(--text-xs); overflow-wrap: anywhere; }
  .option.selected .model-id { color: inherit; }
  .meta { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 4px var(--space-2); color: var(--text-secondary); font-size: var(--text-xs); }
  .empty { margin: 0; padding: var(--space-3); color: var(--text-secondary); font-size: var(--text-sm); }
  .hidden-note { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); color: var(--text-secondary); font-size: var(--text-xs); }
  @media (max-width: 560px) { .option { align-items: start; flex-wrap: wrap; } .meta { justify-content: flex-start; } }
</style>
