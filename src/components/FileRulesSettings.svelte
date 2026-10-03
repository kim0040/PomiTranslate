<script lang="ts">
  import type { ScanOptions } from '../lib/api';
  import { defaultScanOptions } from '../lib/settings';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import ChipListEditor from './ChipListEditor.svelte';

  // Where to look inside a world and which files or translation keys to leave alone. These are
  // saved scan options; the category switches stay with the scan scope tab.
  let { options = $bindable(defaultScanOptions()) }: { options?: ScanOptions } = $props();

  const lists: { key: 'region_dirs' | 'skip_patterns' | 'component_translate_key_prefixes'; label: MessageKey; help: MessageKey; placeholder: string }[] = [
    { key: 'region_dirs', label: 'settings.scope.regionDirs', help: 'settings.scope.regionDirsHelp', placeholder: 'DIM1/region' },
    { key: 'skip_patterns', label: 'settings.scope.skipPatterns', help: 'settings.scope.skipPatternsHelp', placeholder: '*.bak_translate' },
    { key: 'component_translate_key_prefixes', label: 'settings.scope.prefixes', help: 'settings.scope.prefixesHelp', placeholder: 'quest.' }
  ];
</script>

<div class="rules">
  {#each lists as { key, label, help, placeholder } (key)}
    <ChipListEditor id={`scope-${key}`} label={t(label)} help={t(help)} {placeholder} bind:items={options[key]} />
  {/each}
</div>

<style>
  .rules { display: grid; gap: var(--space-5); min-width: 0; }
</style>
