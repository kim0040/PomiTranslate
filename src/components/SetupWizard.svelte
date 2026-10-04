<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { app } from '../lib/app.svelte';
  import type { Settings } from '../lib/api';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import { connectionErrorKey, defaultModel, isSuitable } from '../lib/models';
  import { PROVIDER_CARDS, PROVIDER_DEFAULTS, type ProviderId } from '../lib/providers';
  import { copySettings } from '../lib/settings';
  import { isValidCustomEndpoint } from '../lib/settings-import';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';
  import SetupKey from './SetupKey.svelte';
  import SetupLanguage from './SetupLanguage.svelte';
  import SetupModel from './SetupModel.svelte';
  import SetupProvider from './SetupProvider.svelte';
  import SetupWelcome from './SetupWelcome.svelte';

  // A guided first run: legal notice, provider, key (checked as it is pasted), model, language.
  // Everything is held here and saved together by the last step; leaving early saves nothing.
  type StepName = 'welcome' | 'provider' | 'key' | 'model' | 'language' | 'done';
  const STEPS: StepName[] = ['welcome', 'provider', 'key', 'model', 'language'];
  const TITLES: Record<StepName, MessageKey> = {
    welcome: 'setup.step.welcome', provider: 'setup.step.provider', key: 'setup.step.key',
    model: 'setup.step.model', language: 'setup.step.language', done: 'setup.step.done'
  };

  const known = (id: string): id is ProviderId => PROVIDER_CARDS.some((card) => card.id === id);
  const configured = app.hasModel || app.apiKeyStored;
  let step = $state<StepName>('welcome');
  const initialProvider: ProviderId = configured && known(app.settings.provider) ? app.settings.provider : 'openrouter';
  let provider = $state<ProviderId>(initialProvider);
  let baseUrl = $state(app.settings.provider === 'custom' ? app.settings.base_url : '');
  let wireFormat = $state(app.settings.wire_format || 'openai');
  let apiKey = $state('');
  let model = $state(app.settings.provider === initialProvider ? app.settings.model : '');
  let language = $state(app.settings.target_language || '한국어');
  let style = $state(app.settings.style_preset && app.settings.style_preset !== 'custom' ? app.settings.style_preset : 'neutral');

  let status = $state<'idle' | 'checking' | 'ok' | 'error'>('idle');
  let errorCode = $state('');
  let count = $state(0);
  let checkedWith: string | null = null;
  let saving = $state(false);
  let saveError = $state('');
  let body: HTMLElement | undefined = $state();

  // A key already saved for this provider is used when none is typed.
  const storedKey = $derived(app.apiKeyStored && provider === app.settings.provider);
  const customUrlValid = $derived(provider !== 'custom' || isValidCustomEndpoint(baseUrl));
  const typed = $derived(apiKey.trim());
  const providerName = $derived(provider === 'custom' ? t('settings.provider.custom') : PROVIDER_CARDS.find((card) => card.id === provider)?.label ?? provider);
  const selection = $derived<Settings>(copySettings({
    ...app.settings, provider, model,
    base_url: provider === 'custom' ? baseUrl.trim() : PROVIDER_DEFAULTS[provider]?.baseUrl ?? '',
    wire_format: provider === 'custom' ? wireFormat : PROVIDER_DEFAULTS[provider]?.wireFormat ?? 'openai'
  }));
  const models = $derived(app.modelsFor(selection));
  const index = $derived(STEPS.indexOf(step));
  const accepting = $derived(app.showNotice);
  const dismissible = $derived(!accepting);

  const canAdvance = $derived.by(() => {
    if (step === 'provider') return customUrlValid && (provider !== 'custom' || !!baseUrl.trim());
    if (step === 'key') return (!!typed || storedKey) && !(status === 'error' && ['AUTH_FAILED', 'KEY_MISSING'].includes(errorCode));
    if (step === 'model') return !!model.trim();
    if (step === 'language') return !!language.trim();
    return true;
  });

  function changeProvider(next: ProviderId): void {
    // Whatever was typed or checked belongs to the previous provider.
    apiKey = '';
    status = 'idle';
    errorCode = '';
    checkedWith = null;
    model = next === app.settings.provider ? app.settings.model : '';
  }
  let lastProvider = initialProvider;
  $effect(() => {
    const current = provider;
    if (current !== lastProvider) { lastProvider = current; untrack(() => changeProvider(current)); }
  });

  let inflight: Promise<void> | null = null;

  /** Check the typed key (or the stored one). Calls made while a check runs wait for it and then re-judge. */
  async function check(): Promise<void> {
    while (inflight) await inflight;
    const key = apiKey.trim();
    if ((!key && !storedKey) || checkedWith === key) return;
    if (provider === 'custom' && !customUrlValid) return;
    inflight = ask(key);
    try { await inflight; } finally { inflight = null; }
    // The key may have been edited while the provider was answering.
    if (apiKey.trim() !== key && (apiKey.trim() || storedKey)) await check();
  }

  async function ask(key: string): Promise<void> {
    status = 'checking';
    errorCode = '';
    const asked = provider;
    const result = await app.testConnection(selection, key);
    if (provider !== asked) return;
    checkedWith = key;
    if (result.ok) {
      status = 'ok';
      const listed = app.modelsFor(selection);
      count = listed.filter(isSuitable).length;
      // Start from the cheapest sensible model, unless a model that is on offer is already chosen.
      if (!listed.some((item) => item.id === model.trim())) model = defaultModel(listed)?.id ?? model;
    } else {
      status = 'error';
      errorCode = result.code;
    }
  }

  function retry(): void {
    checkedWith = null;
    void check();
  }

  async function focusStep(): Promise<void> {
    await tick();
    const target = body?.querySelector<HTMLElement>('[data-step-focus]') ?? body?.querySelector<HTMLElement>('input:not([type="radio"]), select, textarea, button:not([disabled])');
    target?.focus();
  }

  function go(next: StepName): void {
    step = next;
    saveError = '';
    void focusStep();
    if (next === 'model' && !models.length && (typed || storedKey) && status !== 'error') void check();
  }

  async function next(): Promise<void> {
    // Leaving the key field starts its check; moving on waits for the answer, which may refuse the key.
    if (step === 'key' && typed) { await check(); if (!canAdvance) return; }
    if (step === 'welcome') {
      if (app.showNotice) app.acceptNotice();
      go('provider');
    } else if (step === 'language') {
      void finish();
    } else {
      go(STEPS[index + 1]);
    }
  }
  function back(): void {
    if (index > 0) go(STEPS[index - 1]);
  }

  async function finish(): Promise<void> {
    if (saving || app.busy) return;
    saving = true;
    saveError = '';
    const changes: Partial<Settings> = {
      provider, model: model.trim(), target_language: language.trim(), style_preset: style,
      base_url: provider === 'custom' ? baseUrl.trim() : PROVIDER_DEFAULTS[provider]?.baseUrl ?? '',
      wire_format: provider === 'custom' ? wireFormat : PROVIDER_DEFAULTS[provider]?.wireFormat ?? 'openai'
    };
    const saved = await app.saveSetup(changes, typed);
    saving = false;
    if (saved) {
      apiKey = '';
      step = 'done';
      void focusStep();
    } else {
      // The settings screen's banner sits behind this dialog, so the reason is shown here instead.
      saveError = app.banner?.message ?? t('settings.saveError');
      app.banner = null;
    }
  }

  function later(): void {
    apiKey = '';
    if (step === 'done') app.finishSetup(false);
    else app.dismissWizard();
  }

  function openSettings(): void {
    apiKey = '';
    app.showWizard = false;
    app.openSettingsFor('world', 'translate');
  }
</script>

<Dialog title={t(TITLES[step])} size="wide" dismissible={dismissible || step === 'done'} onClose={later}>
  <div class="wizard" bind:this={body}>
    {#if step !== 'done'}
      <ol class="dots" aria-label={t('setup.progress', { index: index + 1, total: STEPS.length })}>
        {#each STEPS as name, i (name)}<li class:on={i === index} class:past={i < index} aria-current={i === index ? 'step' : undefined}></li>{/each}
      </ol>
    {/if}

    {#if step === 'welcome'}
      <SetupWelcome />
    {:else if step === 'provider'}
      <SetupProvider bind:provider bind:baseUrl bind:wireFormat />
    {:else if step === 'key'}
      <SetupKey {provider} bind:apiKey {storedKey} {status} {count} {errorCode} onCheck={check} onSettings={openSettings} />
    {:else if step === 'model'}
      <SetupModel bind:model {models} onReload={retry} reloading={status === 'checking'} />
      {#if status === 'error'}<p class="field-error" role="alert">{t(connectionErrorKey(errorCode))}</p>{/if}
    {:else if step === 'language'}
      <SetupLanguage bind:language bind:style {providerName} {model} />
      {#if saveError}<p class="field-error" role="alert">{saveError}</p>{/if}
    {:else}
      <div class="done" role="status">
        <span class="done-icon" aria-hidden="true"><Icon name="check-circle" size={32} /></span>
        <p class="done-title">{t('setup.done.title')}</p>
        <p>{t('setup.done.body', { provider: providerName, model: model.trim() })}</p>
      </div>
    {/if}
  </div>

  {#snippet actions()}
    {#if step === 'done'}
      <button type="button" class="btn btn-secondary" onclick={() => app.finishSetup(true)}>{t('setup.done.tour')}</button>
      <button type="button" class="btn btn-primary" data-autofocus onclick={() => app.finishSetup(false)}>{t('setup.done.world')}</button>
    {:else}
      {#if dismissible}<button type="button" class="btn btn-quiet later" onclick={later}>{t('setup.later.button')}</button>{/if}
      {#if index > 0}<button type="button" class="btn btn-secondary" disabled={saving} onclick={back}><Icon name="chevron-left" size={15} /> {t('setup.back')}</button>{/if}
      <button type="button" class="btn btn-primary" data-autofocus={step === 'welcome' ? '' : undefined} disabled={!canAdvance || saving || (step === 'language' && !!app.busy)} onclick={next}>
        {#if step === 'welcome'}{t(accepting ? 'notice.accept' : 'setup.next')}
        {:else if step === 'language'}{t(saving ? 'settings.saving' : 'setup.finish')}
        {:else}{t('setup.next')} <Icon name="chevron-right" size={15} />{/if}
      </button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .wizard { display: grid; gap: var(--space-4); align-content: start; min-width: 0; color: var(--text-secondary); }
  .dots { display: flex; gap: 6px; list-style: none; margin: 0; padding: 0; }
  .dots li { width: 6px; height: 6px; border-radius: 50%; background: var(--border-strong); transition: background-color var(--dur-fast) var(--ease), width var(--dur-base) var(--ease-out); }
  .dots li.past { background: var(--accent-soft-text); }
  .dots li.on { width: 18px; border-radius: 3px; background: var(--accent); }
  .field-error { margin: 0; color: var(--danger-text); font-size: var(--text-sm); }
  .done { display: grid; justify-items: center; text-align: center; gap: var(--space-2); padding-block: var(--space-4); }
  .done-icon { color: var(--success-solid); }
  .done-title { margin: 0; color: var(--text); font-size: var(--text-xl); font-weight: 700; }
  .done p { margin: 0; max-width: 46ch; }
  :global(.dialog) .later { margin-inline-end: auto; }
</style>
