<script lang="ts">
  import { isValidCustomEndpoint } from '../lib/settings-import';
  import { t } from '../lib/i18n/index.svelte';
  import { PROVIDER_CARDS, keyPageFor, type ProviderId } from '../lib/providers';
  import { openExternal } from '../lib/native';
  import { app } from '../lib/app.svelte';
  import Disclosure from './Disclosure.svelte';
  import Icon from './Icon.svelte';

  let {
    provider = $bindable<ProviderId>('openrouter'), baseUrl = $bindable(''), wireFormat = $bindable('openai')
  }: { provider?: ProviderId; baseUrl?: string; wireFormat?: string } = $props();

  const publicCards = PROVIDER_CARDS.filter((card) => card.id !== 'custom');
  const custom = PROVIDER_CARDS.find((card) => card.id === 'custom')!;
  let advancedOpen = $state(provider === 'custom');
  const urlInvalid = $derived(provider === 'custom' && !!baseUrl.trim() && !isValidCustomEndpoint(baseUrl));

  function openKeyPage(id: ProviderId): void {
    const url = keyPageFor(id);
    if (url) void openExternal(url).catch((cause) => app.fail(cause));
  }
</script>

<div class="providers">
  <p class="lead">{t('setup.provider.lead')}</p>
  <div class="grid" role="radiogroup" aria-label={t('setup.step.provider')}>
    {#each publicCards as card (card.id)}
      <div class="option" class:selected={provider === card.id}>
        <label class="pick">
          <input type="radio" name="setup-provider" value={card.id} checked={provider === card.id} data-step-focus={provider === card.id ? '' : undefined}
            onchange={() => (provider = card.id)} />
          <span class="text">
            <span class="name"><strong>{card.label}</strong>{#if card.badge}<span class="pill pill-accent">{t(card.badge)}</span>{/if}</span>
            <span class="desc">{t(card.description)}</span>
          </span>
        </label>
        <button type="button" class="btn btn-quiet btn-sm keypage" onclick={() => openKeyPage(card.id)}>
          {t('setup.provider.keyPage')} <Icon name="chevron-right" size={13} />
        </button>
      </div>
    {/each}
  </div>

  <Disclosure variant="inline" level={3} title={t('setup.provider.advanced')} bind:open={advancedOpen}>
    <div class="option" class:selected={provider === 'custom'}>
      <label class="pick">
        <input type="radio" name="setup-provider" value="custom" checked={provider === 'custom'} onchange={() => (provider = 'custom')} />
        <span class="text">
          <span class="name"><strong>{t('settings.provider.custom')}</strong></span>
          <span class="desc">{t(custom.description)}</span>
        </span>
      </label>
    </div>
    {#if provider === 'custom'}
      <div class="custom-fields">
        <div class="field">
          <label class="label" for="setup-base-url">{t('settings.baseUrl.label')}</label>
          <input id="setup-base-url" class="input" class:invalid={urlInvalid} type="url" bind:value={baseUrl} placeholder="https://example.com/v1"
            autocomplete="url" aria-invalid={urlInvalid} aria-describedby={urlInvalid ? 'setup-base-url-error' : undefined} />
          {#if urlInvalid}<span id="setup-base-url-error" class="field-error" role="alert">{t('settings.baseUrl.invalid')}</span>{/if}
        </div>
        <div class="field">
          <label class="label" for="setup-wire">{t('settings.wire.label')}</label>
          <select id="setup-wire" class="select" bind:value={wireFormat}>
            <option value="openai">OpenAI Chat</option>
            <option value="anthropic">Anthropic Messages</option>
          </select>
        </div>
      </div>
    {/if}
  </Disclosure>
</div>

<style>
  .providers { display: grid; gap: var(--space-4); min-width: 0; }
  .lead { margin: 0; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
  .option { position: relative; display: grid; gap: var(--space-2); align-content: space-between; padding: var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-lg); background: var(--bg-surface); min-width: 0; }
  .option.selected { border-color: var(--accent); background: var(--accent-soft); }
  .option:has(input:focus-visible) { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  .pick { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: var(--space-2); cursor: pointer; }
  .pick input { margin: 3px 0 0; accent-color: var(--accent); }
  .text { display: grid; gap: var(--space-1); min-width: 0; }
  .name { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); color: var(--text); }
  .name strong { font-size: var(--text-md); }
  .desc { color: var(--text-secondary); font-size: var(--text-sm); line-height: 1.45; }
  .option.selected .desc { color: var(--accent-soft-text); }
  .keypage { justify-self: start; margin-inline-start: 22px; }
  .custom-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
  .field { display: grid; gap: var(--space-2); min-width: 0; align-content: start; }
  .label { color: var(--text); font-size: var(--text-md); font-weight: 600; }
  .input.invalid { border-color: var(--danger-solid); }
  .field-error { color: var(--danger-text); font-size: var(--text-xs); }
  @media (max-width: 640px) { .grid, .custom-fields { grid-template-columns: 1fr; } }
</style>
