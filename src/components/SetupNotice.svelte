<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { t } from '../lib/i18n/index.svelte';
  import { providerLabel } from '../lib/providers';
  import Callout from './Callout.svelte';
  import Icon from './Icon.svelte';

  // Early steps only point it out; the run step is where it blocks.
  let { blocking = false }: { blocking?: boolean } = $props();

  const provider = $derived(providerLabel(app.settings.provider));
  const needs = $derived(app.setupNeeds);
</script>

{#if needs.length}
  <Callout tone={blocking ? 'warning' : 'info'} title={t(blocking ? 'setup.titleBlocking' : 'setup.title')} role={blocking ? 'alert' : undefined}>
    <ul class="needs">
      {#if needs.includes('model')}<li>{t('setup.model')}</li>{/if}
      {#if needs.includes('key')}<li>{t('setup.key', { provider })}</li>{/if}
    </ul>
    <p>{t(blocking ? 'setup.manualHint' : 'setup.later')}</p>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary btn-sm" disabled={app.busy === 'settings'} onclick={() => app.openSettingsFor()}>
        <Icon name="sliders" size={14} /> {t('setup.open')}
      </button>
      <button type="button" class="btn btn-secondary btn-sm" disabled={app.busy === 'settings'} onclick={() => app.openWizard()}>
        <Icon name="play" size={12} /> {t('help.wizardButton')}
      </button>
    {/snippet}
  </Callout>
{/if}

<style>
  .needs { margin: 0 0 var(--space-1); padding-inline-start: 18px; }
</style>
