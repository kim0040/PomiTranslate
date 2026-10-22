<script lang="ts">
  import { app, type RunBlocker } from '../lib/app.svelte';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import Callout from './Callout.svelte';
  import Icon from './Icon.svelte';

  // Early steps only point out what is missing; the run step (and review, which leads there)
  // explains every reason Start is unavailable and links to where each is fixed.
  let { blocking = false }: { blocking?: boolean } = $props();

  const providerLabels: Record<string, string> = { openai: 'OpenAI', gemini: 'Gemini', anthropic: 'Anthropic', openrouter: 'OpenRouter', comet: 'Comet API' };
  const provider = $derived(providerLabels[app.settings.provider] ?? t('settings.provider.custom'));
  const reasons = $derived<RunBlocker[]>(blocking ? app.runBlockers : app.setupNeeds);
  const text: Record<RunBlocker, MessageKey> = {
    recovery: 'setup.recovery',
    credential: 'setup.credential',
    interrupted: 'setup.interrupted',
    model: 'setup.model',
    key: 'setup.key'
  };
  const needsSettings = $derived(reasons.some((reason) => reason !== 'interrupted'));
</script>

{#if reasons.length}
  <Callout tone={blocking ? 'warning' : 'info'} title={t(blocking ? 'setup.titleBlocking' : 'setup.title')} role={blocking ? 'alert' : undefined}>
    <ul class="needs">
      {#each reasons as reason (reason)}<li>{t(text[reason], { provider })}</li>{/each}
    </ul>
    {#if reasons.includes('model') || reasons.includes('key')}<p>{t(blocking ? 'setup.manualHint' : 'setup.later')}</p>{/if}
    {#snippet actions()}
      {#if needsSettings}
        <button type="button" class="btn btn-secondary btn-sm" disabled={app.busy === 'settings'} onclick={() => app.openSettingsFor()}>
          <Icon name="sliders" size={14} /> {t('setup.open')}
        </button>
      {/if}
      {#if reasons.includes('interrupted')}
        <button type="button" class="btn btn-secondary btn-sm" onclick={() => app.goStep('world')}>{t('setup.openInterrupted')}</button>
      {/if}
    {/snippet}
  </Callout>
{/if}

<style>
  .needs { margin: 0 0 var(--space-1); padding-inline-start: 18px; }
</style>
