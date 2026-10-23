<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import { app } from '../lib/app.svelte';
  import type { Settings } from '../lib/api';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import { connectionErrorKey, defaultModel, isSuitable } from '../lib/models';
  import { setupConnectionIdentity } from '../lib/setup-connection';
  import { PROVIDER_CARDS, PROVIDER_DEFAULTS, RECOMMENDED_PROVIDER, providerLabel, type ProviderId } from '../lib/providers';
  import { SUGGESTED_CAP_USD } from '../lib/cost-safety';
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
  const initialProvider: ProviderId = configured && known(app.settings.provider) ? app.settings.provider : RECOMMENDED_PROVIDER;
  let provider = $state<ProviderId>(initialProvider);
  let baseUrl = $state(app.settings.provider === 'custom' ? app.settings.base_url : '');
  let wireFormat = $state(app.settings.wire_format || 'openai');
  let apiKey = $state('');
  let model = $state(app.settings.provider === initialProvider ? app.settings.model : '');
  let language = $state(app.settings.target_language || '한국어');
  let style = $state(app.settings.style_preset && app.settings.style_preset !== 'custom' ? app.settings.style_preset : 'neutral');
  // A first run starts with a small limit; someone who set up before and chose none keeps that choice.
  const savedCap = app.settings.max_cost_usd ?? 0;
  let noLimit = $state(configured && savedCap <= 0);
  let costText = $state(String(savedCap > 0 ? savedCap : SUGGESTED_CAP_USD));
  const costValue = $derived(Number(costText.replace(',', '.')));
  const costValid = $derived(noLimit || (costText.trim() !== '' && Number.isFinite(costValue) && costValue > 0 && costValue <= 1000));

  function wizardDraftSignature(): string {
    // Keep the dirty-state snapshot free of credential text. SetupKey reports key edits directly.
    return JSON.stringify([provider, baseUrl, wireFormat, model, language, style, noLimit, costText]);
  }
  let initialDraftSignature = wizardDraftSignature();
  let keyDraftDirty = $state(false);

  let status = $state<'idle' | 'checking' | 'ok' | 'error'>('idle');
  let errorCode = $state('');
  let count = $state(0);
  let saving = $state(false);
  let saveError = $state('');
  let body: HTMLElement | undefined = $state();

  // A key already saved for this provider is used when none is typed.
  const storedKey = $derived(app.apiKeyStored && provider === app.settings.provider);
  const customUrlValid = $derived(provider !== 'custom' || isValidCustomEndpoint(baseUrl));
  const typed = $derived(apiKey.trim());
  const providerName = $derived(providerLabel(provider));
  const selection = $derived<Settings>(copySettings({
    ...app.settings, provider, model,
    base_url: provider === 'custom' ? baseUrl.trim() : PROVIDER_DEFAULTS[provider]?.baseUrl ?? '',
    wire_format: provider === 'custom' ? wireFormat : PROVIDER_DEFAULTS[provider]?.wireFormat ?? 'openai'
  }));
  const checkIdentity = $derived(setupConnectionIdentity({
    provider, endpoint: selection.base_url, wireFormat: selection.wire_format, key: apiKey.trim(), storedKey: !apiKey.trim() && storedKey
  }));
  const models = $derived(app.modelsFor(selection));
  const index = $derived(STEPS.indexOf(step));
  const accepting = $derived(app.showNotice);
  const dismissible = $derived(!accepting);
  const canSaveSetup = $derived(customUrlValid && (provider !== 'custom' || !!baseUrl.trim()) &&
    (!!typed || storedKey) && !(status === 'error' && ['AUTH_FAILED', 'KEY_MISSING'].includes(errorCode)) &&
    status !== 'checking' && !!model.trim() && !!language.trim() && costValid);

  const canAdvance = $derived.by(() => {
    if (step === 'provider') return customUrlValid && (provider !== 'custom' || !!baseUrl.trim());
    if (step === 'key') return (!!typed || storedKey) && !(status === 'error' && ['AUTH_FAILED', 'KEY_MISSING'].includes(errorCode));
    if (step === 'model') return !!model.trim();
    if (step === 'language') return !!language.trim() && costValid;
    return true;
  });

  function changeProvider(next: ProviderId): void {
    // Whatever was typed or checked belongs to the previous provider.
    apiKey = '';
    status = 'idle';
    errorCode = '';
    model = next === app.settings.provider ? app.settings.model : '';
  }
  let lastProvider = initialProvider;
  $effect(() => {
    const current = provider;
    if (current !== lastProvider) { lastProvider = current; untrack(() => changeProvider(current)); }
  });

  let inflight: Promise<void> | null = null;
  let connectionRevision = 0;
  let active = true;
  let currentIdentity = $state('');
  const successfulChecks = new Set<string>();

  $effect(() => {
    const current = checkIdentity;
    if (current === currentIdentity) return;
    currentIdentity = current;
    connectionRevision += 1;
    status = 'idle';
    errorCode = '';
    count = 0;
  });

  $effect(() => {
    app.wizardDirty = keyDraftDirty || wizardDraftSignature() !== initialDraftSignature;
  });
  onDestroy(() => {
    active = false;
    app.wizardDirty = false;
    connectionRevision += 1;
    successfulChecks.clear();
  });

  /** Check this exact provider/endpoint/wire/key identity. A visible retry always forces a request. */
  async function check(force = false): Promise<void> {
    while (inflight) await inflight;
    if (!active) return;
    const key = apiKey.trim();
    const identity = currentIdentity;
    if ((!key && !storedKey) || (!force && !!key && successfulChecks.has(identity))) return;
    if (provider === 'custom' && !customUrlValid) return;
    if (force) successfulChecks.delete(identity);
    const revision = ++connectionRevision;
    const request = ask(key, identity, revision);
    inflight = request;
    try { await request; } finally { if (inflight === request) inflight = null; }
    // Inputs may have changed while the provider was answering; check only the new identity.
    if (active && currentIdentity !== identity && (apiKey.trim() || storedKey)) await check();
  }

  async function ask(key: string, identity: string, revision: number): Promise<void> {
    status = 'checking';
    errorCode = '';
    const result = await app.testConnection(selection, key, () => active && identity === currentIdentity && revision === connectionRevision);
    if (!active || identity !== currentIdentity || revision !== connectionRevision) return;
    if (result.ok) {
      if (key) successfulChecks.add(identity);
      else successfulChecks.delete(identity);
      status = 'ok';
      const listed = app.modelsFor(selection);
      count = listed.filter(isSuitable).length;
      // Start from the cheapest sensible model, unless a model that is on offer is already chosen.
      if (!listed.some((item) => item.id === model.trim())) model = defaultModel(listed)?.id ?? model;
    } else {
      successfulChecks.delete(identity);
      status = 'error';
      errorCode = result.code;
    }
  }

  function retry(): void {
    void check(true);
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

  async function saveSetupDraft(): Promise<boolean> {
    saving = true;
    saveError = '';
    const changes: Partial<Settings> = {
      provider, model: model.trim(), target_language: language.trim(), style_preset: style,
      max_cost_usd: noLimit ? 0 : Math.round(costValue * 10000) / 10000,
      base_url: provider === 'custom' ? baseUrl.trim() : PROVIDER_DEFAULTS[provider]?.baseUrl ?? '',
      wire_format: provider === 'custom' ? wireFormat : PROVIDER_DEFAULTS[provider]?.wireFormat ?? 'openai'
    };
    const saved = await app.saveSetup(changes, typed);
    saving = false;
    if (saved) {
      apiKey = '';
      keyDraftDirty = false;
      successfulChecks.clear();
      initialDraftSignature = wizardDraftSignature();
      app.wizardDirty = false;
      return true;
    } else {
      // The settings screen's banner sits behind this dialog, so the reason is shown here instead.
      saveError = app.settingsSaveError || t('settings.saveError');
      app.clearSettingsSaveError();
      return false;
    }
  }

  async function finish(): Promise<void> {
    if (saving || app.busy) return;
    if (await saveSetupDraft()) {
      step = 'done';
      void focusStep();
    }
  }

  async function saveAndClose(): Promise<void> {
    if (!canSaveSetup || saving || app.busy || app.pendingCloseContext !== 'wizard') return;
    if (await saveSetupDraft()) app.finishWizardAndClose();
  }

  function later(): void {
    apiKey = '';
    successfulChecks.clear();
    if (step === 'done') app.finishSetup(false);
    else app.dismissWizard();
  }

  function openSettings(): void {
    apiKey = '';
    successfulChecks.clear();
    app.wizardDirty = false;
    app.showWizard = false;
    app.openSettingsFor('world', 'translate');
  }

  function markKeyDraftDirty(): void {
    keyDraftDirty = true;
    app.wizardDirty = true;
  }
</script>

<Dialog title={t(TITLES[step])} size="fit" dismissible={dismissible || step === 'done'} onClose={later}>
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
      <SetupKey {provider} bind:apiKey {storedKey} storageMode={app.credentialMode} {status} {count} {errorCode} onDraftChange={markKeyDraftDirty} onCheck={() => void check()} onRetry={() => void check(true)} onSettings={openSettings} />
    {:else if step === 'model'}
      <SetupModel bind:model {models} onReload={retry} reloading={status === 'checking'} />
      {#if status === 'error'}<p class="field-error" role="alert">{t(connectionErrorKey(errorCode))}</p>{/if}
    {:else if step === 'language'}
      <SetupLanguage bind:language bind:style bind:costText bind:noLimit costInvalid={!costValid} {providerName} {model} />
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

{#if app.pendingCloseContext === 'wizard' && app.pendingCloseSource}
  <Dialog title={t('setup.close.title')} hideClose onClose={() => app.continueWizardClose()}>
    <p>{t('setup.close.body')}</p>
    {#if saveError}<p class="field-error" role="alert">{saveError}</p>{/if}
    {#snippet actions()}
      <button type="button" class="btn btn-quiet" disabled={saving} onclick={() => app.continueWizardClose()}>{t('setup.close.continue')}</button>
      <button type="button" class="btn btn-secondary" disabled={saving} onclick={() => app.discardWizardAndClose()}>{t('setup.close.discard')}</button>
      {#if canSaveSetup}
        <button type="button" class="btn btn-primary" data-autofocus disabled={saving || !!app.busy} onclick={saveAndClose}>{t(saving ? 'settings.saving' : 'setup.close.save')}</button>
      {/if}
    {/snippet}
  </Dialog>
{/if}

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
