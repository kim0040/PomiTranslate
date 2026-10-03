<script lang="ts">
  import { t } from '../lib/i18n/index.svelte';
  import { STYLE_PRESETS } from '../lib/settings';
  import TargetLanguageSelect from './TargetLanguageSelect.svelte';

  let { language = $bindable(''), style = $bindable('neutral'), providerName, model }: {
    language?: string; style?: string; providerName: string; model: string;
  } = $props();
</script>

<div class="lang-step">
  <p class="lead">{t('setup.language.lead')}</p>
  <div class="field">
    <label class="label" for="setup-language">{t('settings.language.target')}</label>
    <TargetLanguageSelect id="setup-language" bind:value={language} describedby="setup-language-help" />
    <span id="setup-language-help" class="hint">{t('setup.language.help')}</span>
  </div>
  <div class="field">
    <label class="label" for="setup-style">{t('settings.style.label')}</label>
    <select id="setup-style" class="select" bind:value={style}>
      {#each STYLE_PRESETS.filter((preset) => preset.value !== 'custom') as preset (preset.value)}<option value={preset.value}>{t(preset.label)}</option>{/each}
    </select>
  </div>
  <dl class="summary">
    <div><dt>{t('settings.provider.label')}</dt><dd>{providerName}</dd></div>
    <div><dt>{t('settings.model.label')}</dt><dd class="mono">{model || '—'}</dd></div>
  </dl>
</div>

<style>
  .lang-step { display: grid; gap: var(--space-4); min-width: 0; }
  .lead { margin: 0; }
  .field { display: grid; gap: var(--space-2); min-width: 0; }
  .label { color: var(--text); font-size: var(--text-md); font-weight: 600; }
  .hint { color: var(--text-secondary); font-size: var(--text-xs); }
  .summary { margin: 0; display: grid; gap: var(--space-2); padding: var(--space-3); border-radius: var(--radius-lg); background: var(--bg-page); border: 1px solid var(--border); }
  .summary > div { display: grid; grid-template-columns: minmax(110px, 0.4fr) minmax(0, 1fr); gap: var(--space-3); align-items: baseline; }
  .summary dt { color: var(--text-secondary); font-size: var(--text-sm); }
  .summary dd { margin: 0; color: var(--text); font-size: var(--text-sm); font-weight: 600; overflow-wrap: anywhere; }
</style>
