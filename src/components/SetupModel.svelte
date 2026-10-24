<script lang="ts">
  import type { ModelInfo } from '../lib/api';
  import { app } from '../lib/app.svelte';
  import { formatUsd } from '../lib/format';
  import { t } from '../lib/i18n/index.svelte';
  import { modelPrices } from '../lib/models';
  import ModelPicker from './ModelPicker.svelte';

  let { model = $bindable(''), models, onReload, reloading = false }: { model?: string; models: ModelInfo[]; onReload: () => void; reloading?: boolean } = $props();

  const picked = $derived(models.find((item) => item.id === model.trim()));
  const prices = $derived(picked ? modelPrices(picked) : null);
</script>

<div class="model-step">
  <p class="lead">{t('setup.model.lead')}</p>
  <!-- One picker for both cases, so it keeps the focus when the list arrives: the list is shown in the page once there is one. -->
  <div class="field">
    <label class="label" for="setup-model">{t('settings.model.label')}</label>
    <ModelPicker id="setup-model" bind:value={model} {models} inline={models.length > 0} placeholder={t('settings.model.placeholder')} describedby={models.length ? 'setup-model-price' : 'setup-model-empty'} />
    {#if !models.length}
      <p id="setup-model-empty" class="hint">{t('setup.model.empty')}</p>
      <div><button type="button" class="btn btn-secondary btn-sm" disabled={reloading} onclick={onReload}>{t('settings.model.refresh')}</button></div>
    {/if}
  </div>
  <p id="setup-model-price" class="price" role="status" aria-live="polite">
    {#if prices && prices.input !== null && prices.output !== null}
      {t('settings.model.price', { input: formatUsd(prices.input, app.locale), output: formatUsd(prices.output, app.locale) })}
    {:else if picked}{t('settings.model.priceUnknown')}{/if}
  </p>
</div>

<style>
  .model-step { display: grid; gap: var(--space-3); min-width: 0; }
  .lead { margin: 0; }
  .field { display: grid; gap: var(--space-2); }
  .label { color: var(--text); font-size: var(--text-md); font-weight: 600; }
  .hint { margin: 0; color: var(--text-secondary); font-size: var(--text-xs); }
  .price { margin: 0; min-height: 1.4em; color: var(--text); font-size: var(--text-sm); font-weight: 600; }
</style>
