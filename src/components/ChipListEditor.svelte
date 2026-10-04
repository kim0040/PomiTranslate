<script lang="ts">
  import { t } from '../lib/i18n/index.svelte';
  import Icon from './Icon.svelte';

  // A list of short text rules as removable chips with one box to add more. A pasted block with
  // several lines adds one chip per line, so lists written for the old textarea still paste in.
  let {
    items = $bindable([]), id, label, help = '', placeholder = ''
  }: { items?: string[]; id: string; label: string; help?: string; placeholder?: string } = $props();

  let draft = $state('');

  function add(text: string): void {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const next = lines.filter((line, index) => !items.includes(line) && lines.indexOf(line) === index);
    if (next.length) items = [...items, ...next];
    draft = '';
  }
  function remove(index: number): void {
    items = items.filter((_, position) => position !== index);
  }
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      add(draft);
    }
  }
  function onPaste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData('text') ?? '';
    if (!/\r?\n/.test(text.trim())) return;
    event.preventDefault();
    add(text);
  }
</script>

<div class="chips-field">
  <label class="label" for={id}>{label}</label>
  {#if items.length}
    <ul class="chips" aria-label={label}>
      {#each items as item, index (item)}
        <li class="chip">
          <span class="mono">{item}</span>
          <button type="button" class="chip-remove" aria-label={t('chips.remove', { item })} onclick={() => remove(index)}><Icon name="x" size={12} /></button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="hint">{t('chips.empty')}</p>
  {/if}
  <div class="add">
    <input {id} class="input" type="text" bind:value={draft} {placeholder} autocomplete="off" spellcheck="false"
      aria-describedby={help ? `${id}-help` : undefined} onkeydown={onKeydown} onpaste={onPaste} onblur={() => { if (draft.trim()) add(draft); }} />
    <button type="button" class="btn btn-secondary btn-sm" disabled={!draft.trim()} onclick={() => add(draft)}><Icon name="plus" size={14} /> {t('chips.add')}</button>
  </div>
  {#if help}<p id="{id}-help" class="hint">{help}</p>{/if}
</div>

<style>
  .chips-field { display: grid; gap: var(--space-2); min-width: 0; }
  .label { font-size: var(--text-md); font-weight: 600; color: var(--text); }
  .hint { margin: 0; color: var(--text-secondary); font-size: var(--text-xs); line-height: 1.45; }
  .chips { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-2); }
  .chip { display: inline-flex; align-items: center; gap: 2px; max-width: 100%; min-height: 26px; padding: 0 2px 0 var(--space-2); border: 1px solid var(--border-strong); border-radius: var(--radius-full); background: var(--bg-surface); font-size: var(--text-xs); }
  .chip .mono { overflow-wrap: anywhere; }
  .chip-remove { background: none; border: 0; padding: 0; display: grid; place-items: center; width: 22px; height: 22px; border-radius: var(--radius-full); color: var(--text-secondary); }
  @media (hover: hover) { .chip-remove:hover { background: var(--danger-soft); color: var(--danger-text); } }
  .add { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2); }
  .input { min-width: 0; }
</style>
