<script lang="ts">
  import type { ScanFlag, ScanOptions } from '../lib/api';
  import { applyScanPreset, defaultScanOptions } from '../lib/settings';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';

  let { options = $bindable(defaultScanOptions()) }: { options?: ScanOptions } = $props();
  const flags: { key: ScanFlag; label: MessageKey }[] = [
    { key: 'translate_signs', label: 'kind.sign' }, { key: 'translate_books', label: 'kind.book_page' },
    { key: 'translate_custom_names', label: 'kind.entity_name' }, { key: 'translate_item_names', label: 'kind.item_name' },
    { key: 'translate_lore', label: 'kind.item_lore' }, { key: 'translate_titles', label: 'settings.scope.bookTitles' },
    { key: 'translate_filtered_titles', label: 'settings.scope.filteredTitles' },
    { key: 'translate_command_output', label: 'kind.command' }, { key: 'translate_text_displays', label: 'kind.text_display' }
  ];
  function setAll(value: boolean) {
    options = { ...options, ...Object.fromEntries(flags.map(({ key }) => [key, value])) };
  }
</script>

<fieldset class="scope">
  <legend>{t('settings.scope.categories')}</legend>
  <p class="hint">{t('settings.scope.categoriesHelp')}</p>
  <div class="presets">
    <button type="button" class="btn btn-secondary btn-sm" onclick={() => options = applyScanPreset(options, 'recommended')}>{t('settings.scope.recommended')}</button>
    <button type="button" class="btn btn-secondary btn-sm" onclick={() => options = applyScanPreset(options, 'story')}>{t('settings.scope.story')}</button>
    <button type="button" class="btn btn-secondary btn-sm" onclick={() => setAll(true)}>{t('settings.scope.selectAll')}</button>
    <button type="button" class="btn btn-secondary btn-sm" onclick={() => setAll(false)}>{t('settings.scope.selectNone')}</button>
  </div>
  <div class="flags">
    {#each flags as { key, label } (key)}
      <label class="check"><input type="checkbox" bind:checked={options[key]} /><span>{t(label)}</span></label>
    {/each}
  </div>
  <label class="check"><input type="checkbox" bind:checked={options.skip_command_like_text} /><span>{t('settings.scope.skipCommands')}</span></label>
</fieldset>

<style>
  .scope { margin: 0; padding: 0; min-width: 0; border: 0; display: grid; gap: var(--space-3); }
  legend { font-size: var(--text-md); font-weight: 700; margin-bottom: var(--space-2); }
  .flags { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-3); }
  .presets { display: flex; gap: var(--space-2); flex-wrap: wrap; }
</style>
