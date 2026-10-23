<script lang="ts">
  import { t } from '../lib/i18n/index.svelte';
  import { STYLE_PRESETS } from '../lib/settings';
  import TargetLanguageSelect from './TargetLanguageSelect.svelte';

  let { language = $bindable(''), style = $bindable('neutral'), costText = $bindable('5'), noLimit = $bindable(false), costInvalid = false, providerName, model }: {
    language?: string; style?: string; costText?: string; noLimit?: boolean; costInvalid?: boolean; providerName: string; model: string;
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
  <!-- A small limit is the safe start; "no limit" is a visible, deliberate choice. -->
  <div class="field">
    <label class="label" for="setup-cost">{t('setup.cost.label')}</label>
    <div class="cost-row">
      <span class="unit">$</span>
      <input id="setup-cost" class="input num" type="text" inputmode="decimal" autocomplete="off" bind:value={costText} disabled={noLimit}
        aria-invalid={costInvalid ? 'true' : undefined} aria-describedby="setup-cost-help" />
      <span class="unit">USD</span>
    </div>
    <label class="check"><input id="setup-no-limit" type="checkbox" bind:checked={noLimit} /><span>{t('setup.cost.none')}</span></label>
    <span id="setup-cost-help" class="hint" class:bad={costInvalid}>{costInvalid ? t('setup.cost.invalid') : noLimit ? t('setup.cost.noneNote') : t('setup.cost.help')}</span>
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
  .cost-row { display: flex; align-items: center; gap: var(--space-2); }
  .cost-row .input { width: 110px; text-align: end; }
  .unit { color: var(--text-secondary); font-size: var(--text-sm); }
  .check { display: flex; align-items: center; gap: var(--space-2); color: var(--text); font-size: var(--text-md); }
  .hint.bad { color: var(--danger-text); }
  .hint { color: var(--text-secondary); font-size: var(--text-xs); }
  .summary { margin: 0; display: grid; gap: var(--space-2); padding: var(--space-3); border-radius: var(--radius-lg); background: var(--bg-page); border: 1px solid var(--border); }
  .summary > div { display: grid; grid-template-columns: minmax(110px, 0.4fr) minmax(0, 1fr); gap: var(--space-3); align-items: baseline; }
  .summary dt { color: var(--text-secondary); font-size: var(--text-sm); }
  .summary dd { margin: 0; color: var(--text); font-size: var(--text-sm); font-weight: 600; overflow-wrap: anywhere; }
</style>
