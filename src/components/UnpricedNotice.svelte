<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { formatUsd } from '../lib/format';
  import { t } from '../lib/i18n/index.svelte';
  import Callout from './Callout.svelte';

  // A spending limit is set but the model has no price, so the limit cannot be enforced. The core
  // refuses to start unless the person agrees, and agreeing is always this explicit button.
  // The run screen passes its own start so the first-send consent is asked before agreeing.
  // Anywhere else (the review, the result) the notice only exists for a refused request that is waiting
  // for the agreement, and the agreement repeats exactly that request. It never starts a translation.
  let { onConsent }: { onConsent?: () => void } = $props();
  const cap = $derived(app.settings.max_cost_usd ?? 0);
  const visible = $derived(onConsent ? app.unpricedNotice : app.unpricedRetryPending);
</script>

{#if visible}
  <Callout tone="warning" title={t('run.unpriced.title')} role="alert">
    {t('run.unpriced.body', { cap: formatUsd(cap, app.locale) })}
    {#snippet actions()}
      <button type="button" class="btn btn-secondary btn-sm" disabled={!!app.busy} onclick={() => app.openSettingsFor(app.step, 'translate', 'user-model-price')}>{t('run.unpriced.setPrice')}</button>
      <button type="button" class="btn btn-primary btn-sm" disabled={!app.canRun} onclick={() => (onConsent ? onConsent() : void app.consentUnpriced())}>{t(onConsent ? 'run.unpriced.consent' : 'run.unpriced.consentRetry')}</button>
    {/snippet}
  </Callout>
{/if}
