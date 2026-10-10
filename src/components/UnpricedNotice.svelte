<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { formatUsd } from '../lib/format';
  import { t } from '../lib/i18n/index.svelte';
  import Callout from './Callout.svelte';

  // A spending limit is set but the model has no price, so the limit cannot be enforced. The core
  // refuses to start unless the person agrees, and agreeing is always this explicit button.
  const cap = $derived(app.settings.max_cost_usd ?? 0);
</script>

{#if app.unpricedNotice}
  <Callout tone="warning" title={t('run.unpriced.title')} role="alert">
    {t('run.unpriced.body', { cap: formatUsd(cap, app.locale) })}
    {#snippet actions()}
      <button type="button" class="btn btn-secondary btn-sm" disabled={!!app.busy} onclick={() => app.openSettingsFor(app.step, 'translate', 'user-model-price')}>{t('run.unpriced.setPrice')}</button>
      <button type="button" class="btn btn-primary btn-sm" disabled={!app.canRun} onclick={() => void app.consentUnpriced()}>{t('run.unpriced.consent')}</button>
    {/snippet}
  </Callout>
{/if}
