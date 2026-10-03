<script lang="ts">
  import { untrack } from 'svelte';
  import Dialog from '../components/Dialog.svelte';
  import AppMaintenance from '../components/AppMaintenance.svelte';
  import Icon from '../components/Icon.svelte';
  import ScanScopeSettings from '../components/ScanScopeSettings.svelte';
  import ResourcePackSettings from '../components/ResourcePackSettings.svelte';
  import ExternalResourcePacks from '../components/ExternalResourcePacks.svelte';
  import { resourcePackOptions } from '../lib/resource-pack';
  import SourceOverrides from '../components/SourceOverrides.svelte';
  import { normalizedScanOptions, publicSettingsForExport } from '../lib/settings';
  import { isValidCustomEndpoint, parseSettingsImport } from '../lib/settings-import';
  import { exportDocument } from '../lib/document-export';
  import { app, defaultSettings } from '../lib/app.svelte';
  import { callBackend, credentialStatus, importCredential, type CredentialMode, type Settings, type ProviderUsage } from '../lib/api';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import type { ThemeChoice } from '../lib/theme';
  import { REASONING_PROVIDERS, defaultReasoningLabel, effortLabel, reasoningMode, supportedEfforts, supportsReasoning } from '../lib/reasoning';

  const providers = [
    { value: 'openai', label: 'OpenAI' },
    { value: 'gemini', label: 'Gemini' },
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'openrouter', label: 'OpenRouter' },
    { value: 'comet', label: 'Comet API' },
    { value: 'custom', label: 'settings.provider.custom' as MessageKey }
  ];

  const styles = [
    { value: 'neutral', label: 'settings.style.neutral' as MessageKey },
    { value: 'casual', label: 'settings.style.casual' as MessageKey },
    { value: 'formal', label: 'settings.style.formal' as MessageKey },
    { value: 'polite', label: 'settings.style.polite' as MessageKey },
    { value: 'story', label: 'settings.style.story' as MessageKey },
    { value: 'custom', label: 'settings.style.custom' as MessageKey }
  ];

  const themes: { value: ThemeChoice; short: MessageKey }[] = [
    { value: 'system', short: 'settings.theme.systemShort' },
    { value: 'light', short: 'settings.theme.lightShort' },
    { value: 'dark', short: 'settings.theme.darkShort' }
  ];
  // What "system" means right now, so the choice explains itself.
  let systemDark = $state(typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  $effect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(prefers-color-scheme: dark)');
    const listener = () => { systemDark = query.matches; };
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  });

  const providerDefaults: Record<string, { baseUrl: string; wireFormat: string }> = {
    openai: { baseUrl: 'https://api.openai.com/v1', wireFormat: 'openai' },
    gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', wireFormat: 'gemini' },
    anthropic: { baseUrl: 'https://api.anthropic.com/v1', wireFormat: 'anthropic' },
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1', wireFormat: 'openai' },
    comet: { baseUrl: 'https://api.cometapi.com/v1', wireFormat: 'openai' }
  };

  const copySettings = (value: Settings): Settings => ({
    ...value,
    provider: value.provider || 'openai',
    model: value.model ?? '',
    openrouter_reasoning: value.openrouter_reasoning ?? 'default',
    base_url: value.base_url ?? '',
    wire_format: value.wire_format || 'openai',
    target_language: value.target_language || '한국어',
    style_preset: value.style_preset || 'neutral',
    style_prompt: value.style_prompt ?? '',
    custom_system_prompt: value.custom_system_prompt ?? '',
    temperature: Number.isFinite(Number(value.temperature)) ? Number(value.temperature) : 0.3,
    batch_size: Number.isFinite(Number(value.batch_size)) ? Number(value.batch_size) : 40,
    request_timeout: Number.isFinite(Number(value.request_timeout)) ? Number(value.request_timeout) : 120,
    rpm_limit: Number.isFinite(Number(value.rpm_limit)) ? Number(value.rpm_limit) : 0,
    tpm_limit: Number.isFinite(Number(value.tpm_limit)) ? Number(value.tpm_limit) : 0,
    max_batch_retries: Number.isFinite(Number(value.max_batch_retries)) ? Number(value.max_batch_retries) : 3,
    max_file_write_retries: Number.isFinite(Number(value.max_file_write_retries)) ? Number(value.max_file_write_retries) : 2,
    continue_on_file_error: value.continue_on_file_error !== false,
    source_overrides: { ...value.source_overrides },
    concurrency: Number.isFinite(Number(value.concurrency)) ? Number(value.concurrency) : 4,
    resource_pack_enabled: !!value.resource_pack_enabled,
    resource_pack_options: resourcePackOptions(value.resource_pack_options),
    external_resource_pack_paths: [...(value.external_resource_pack_paths ?? [])],
    skip_target_language_text: value.skip_target_language_text !== false,
    scan_options: normalizedScanOptions(value.scan_options),
    ui_language: value.ui_language || 'ko',
    last_world_dir: value.last_world_dir || ''
  });

  let draft = $state<Settings>(copySettings(app.settings));
  let snapshot = $state<Settings | null>(null);
  let apiKey = $state('');
  let showApiKey = $state(false);
  let editingKey = $state(false);
  let showDeleteConfirm = $state(false);
  let credentialProvider = $state('');
  let credentialState = $state<boolean | null>(null);
  let credentialLoading = $state(false);
  let credentialMode = $state<CredentialMode>(app.credentialMode);
  let savedCredentialMode = $state<CredentialMode>(app.credentialMode);
  let credentialError = $state('');
  let importing = $state(false);
  let styleBrief = $state('');
  let showStyleConfirm = $state(false);
  let styleError = $state('');
  let importInput: HTMLInputElement;
  let importingSettings = $state(false);
  let overridesInvalid = $state(false);
  let packInvalid = $state(false);
  let usageSnapshots = $state<ProviderUsage[]>([]);
  let usageError = $state('');
  let modelError = $state('');
  let modelErrorSelection = $state('');
  let lastAutoLookup = '';
  let saveBarHeight = $state(0);

  async function importDraft(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (app.busy) { input.value = ''; return; }
    importingSettings = true;
    app.busy = 'loading';
    try {
      if (file.size > 1024 * 1024) throw new Error('oversized');
      const text = await file.text();
      const contents = file.name.toLowerCase().endsWith('.py')
        ? JSON.stringify((await callBackend<{ config: unknown }>('settings.import_legacy', { source: text })).config)
        : text;
      draft = copySettings(parseSettingsImport(contents, app.settings));
      apiKey = '';
      showApiKey = false;
      editingKey = false;
      await refreshCredential(draft.provider);
      app.notify(t('settings.import.done'), 'info');
    } catch { app.notify(t('settings.import.failed'), 'error'); }
    finally { input.value = ''; importingSettings = false; app.busy = ''; }
  }

  async function checkUsage(): Promise<void> {
    if (app.busy || draft.provider !== 'openrouter' || !stored || apiKey.trim()) return;
    app.busy = 'usage';
    usageError = '';
    try {
      const reply = await callBackend<ProviderUsage>('provider.usage', { provider: 'openrouter' });
      usageSnapshots = [...usageSnapshots, reply].slice(-2);
    } catch { usageError = t('settings.usage.failed'); }
    finally { app.busy = ''; }
  }

  async function enhanceStyle(): Promise<void> {
    showStyleConfirm = false;
    if (app.busy || !styleBrief.trim() || apiKey.trim()) return;
    app.busy = 'prompt';
    styleError = '';
    try {
      const reply = await callBackend<{ enhancedPrompt: string }>('prompt.enhance', {
        provider: draft.provider, model: draft.model,
        ...(draft.provider === 'custom' ? { baseUrl: draft.base_url } : {}), wireFormat: draft.wire_format,
        brief: styleBrief.trim(), targetLanguage: draft.target_language, stylePreset: draft.style_preset,
        stylePrompt: draft.style_prompt ?? '', customSystemPrompt: draft.custom_system_prompt ?? ''
      });
      if (!reply.enhancedPrompt?.trim()) throw new Error(t('settings.styleAssist.empty'));
      draft.style_prompt = [draft.style_prompt?.trim(), reply.enhancedPrompt.trim()].filter(Boolean).join('\n\n');
      app.notify(t('settings.styleAssist.done'), 'success');
    } catch (cause) { styleError = app.describe(cause); }
    finally { app.busy = ''; }
  }

  // AppState is bootstrapped asynchronously. Capture the comparison copy only after that
  // happens, so the first save compares against persisted settings rather than defaults.
  $effect(() => {
    if (!app.ready || snapshot) return;
    draft = copySettings(app.settings);
    snapshot = copySettings(app.settings);
    credentialProvider = app.settings.provider;
    credentialState = app.apiKeyStored;
    credentialMode = app.credentialMode;
    void refreshCredential(app.settings.provider);
  });

  const isCustom = $derived(draft.provider === 'custom');
  const models = $derived(app.modelsFor(draft));
  const reasoningModel = $derived(models.find((model) => model.id === draft.model.trim()));
  const reasoningMetadata = $derived(reasoningModel?.reasoning);
  const reasoningSupported = $derived(supportsReasoning(reasoningModel));
  const reasoningEfforts = $derived(supportedEfforts(reasoningModel));
  const currentReasoning = $derived(draft.openrouter_reasoning ?? 'default');
  const mode = $derived(reasoningMode(currentReasoning));
  const hiddenReasoning = $derived(!['default', 'enabled', 'disabled', ...reasoningEfforts].includes(currentReasoning));
  const reasoningInvalid = $derived(REASONING_PROVIDERS.includes(draft.provider) && currentReasoning !== 'default' &&
    (!reasoningModel || !reasoningSupported || (currentReasoning === 'disabled' && !!reasoningMetadata?.mandatory) || hiddenReasoning));
  const dirty = $derived(!!snapshot && (JSON.stringify(copySettings(draft)) !== JSON.stringify(copySettings(snapshot)) ||
    !!apiKey.trim() || credentialMode !== savedCredentialMode));
  const selectionKey = $derived(`${draft.provider}:${draft.model.trim()}`);
  const visibleModelError = $derived(modelErrorSelection === selectionKey ? modelError : '');

  // Only public metadata auto-loads. No key/keychain read and no preference write.
  $effect(() => {
    const key = selectionKey;
    if (!app.ready || draft.provider !== 'openrouter' || !draft.model.trim() || app.busy || lastAutoLookup === key) return;
    const timer = setTimeout(() => {
      lastAutoLookup = key;
      void untrack(() => loadModels(false));
    }, 350);
    return () => clearTimeout(timer);
  });
  const validBaseUrl = isValidCustomEndpoint;
  const baseUrlInvalid = $derived(isCustom && !validBaseUrl(draft.base_url));
  const rangeInvalid = $derived.by(() => ({
    temperature: !inRange(draft.temperature, 0, 2),
    batch: !inRange(draft.batch_size, 1, 200),
    timeout: !inRange(draft.request_timeout, 5, 600),
    rpm: !inRange(draft.rpm_limit, 0, 10000),
    tpm: !inRange(draft.tpm_limit, 0, 10000000),
    retries: !inRange(draft.max_batch_retries, 0, 10),
    writeRetries: !inRange(draft.max_file_write_retries, 1, 10) || !Number.isInteger(draft.max_file_write_retries),
    concurrency: !inRange(draft.concurrency, 1, 8)
  }));
  const hasRangeError = $derived(Object.values(rangeInvalid).some(Boolean));
  const hasBlockingError = $derived(reasoningInvalid || hasRangeError || overridesInvalid || (draft.resource_pack_enabled && packInvalid) || (isCustom && !validBaseUrl(draft.base_url)));
  const stored = $derived(credentialProvider === draft.provider ? credentialState : null);
  const providerName = (provider: string): string => {
    const item = providers.find((choice) => choice.value === provider);
    if (!item) return provider;
    return provider === 'custom' ? t('settings.provider.custom') : item.label;
  };

  function inRange(value: unknown, minimum: number, maximum: number): boolean {
    const number = Number(value);
    return Number.isFinite(number) && number >= minimum && number <= maximum;
  }

  async function refreshCredential(provider: string): Promise<void> {
    credentialProvider = provider;
    credentialState = null;
    credentialLoading = true;
    credentialError = '';
    try {
      const status = await credentialStatus(provider);
      if (credentialProvider === provider) {
        credentialState = status.stored;
        credentialMode = status.mode;
        savedCredentialMode = status.mode;
        // This is only a boolean status. The key itself is never read from the store.
        if (app.settings.provider === provider) app.apiKeyStored = status.stored;
      }
    } catch (cause) {
      if (credentialProvider === provider) credentialError = app.describe(cause);
    } finally {
      if (credentialProvider === provider) credentialLoading = false;
    }
  }

  function providerChanged(event: Event): void {
    draft.provider = (event.currentTarget as HTMLSelectElement).value;
    const defaults = providerDefaults[draft.provider];
    if (defaults) {
      // A custom endpoint can contain credentials controlled by a different operator. Never
      // carry it into a public provider selection where the field is hidden from the user.
      draft.base_url = defaults.baseUrl;
      draft.wire_format = defaults.wireFormat;
    } else if (draft.provider === 'custom' && providerDefaults[snapshot?.provider || '']) {
      draft.base_url = '';
      draft.wire_format = 'openai';
    }
    apiKey = '';
    showApiKey = false;
    editingKey = false;
    modelError = '';
    usageSnapshots = [];
    usageError = '';
    void refreshCredential(draft.provider);
  }

  function applyDraft(): void {
    app.settings = copySettings(draft);
  }

  async function saveSettings(): Promise<boolean> {
    if (!snapshot || hasBlockingError || app.busy) return false;

    const previous = copySettings(snapshot);
    const previousMode = app.credentialMode;
    applyDraft();
    app.credentialMode = credentialMode;
    const saved = await app.saveSettings(previous, apiKey, previousMode);
    if (!saved) {
      // AppState restores verified preferences or reloads an uncertain write. Keep the
      // user's unsaved draft/key for retry, without replacing the authoritative state.
      snapshot = copySettings(app.settings);
      return false;
    }

    draft = copySettings(app.settings);
    snapshot = copySettings(app.settings);
    apiKey = '';
    showApiKey = false;
    editingKey = false;
    savedCredentialMode = app.credentialMode;
    credentialProvider = app.settings.provider;
    credentialState = app.apiKeyStored;
    return true;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (await saveSettings() && app.returnStep) app.returnFromSettings();
  }

  // Leaving with unsaved changes asks first (AppState holds the move until it is answered).
  $effect(() => { app.settingsDirty = dirty; });
  $effect(() => () => {
    app.settingsDirty = false;
    app.pendingLeave = null;
  });

  async function saveAndLeave(): Promise<void> {
    app.resolveLeave(await saveSettings());
  }

  function leaveWithoutSaving(): void {
    discardDraft();
    app.resolveLeave(true);
  }

  async function changeLanguage(select: HTMLSelectElement): Promise<void> {
    const locale = select.value as 'ko' | 'en' | 'ja';
    if (await app.setUiLanguage(locale)) {
      draft.ui_language = locale;
      if (snapshot) snapshot.ui_language = locale;
    } else {
      select.value = draft.ui_language ?? 'ko';
    }
  }

  async function loadModels(force = true): Promise<void> {
    if (!snapshot || app.busy || baseUrlInvalid) return;
    const selection = copySettings(draft);
    const key = selectionKey;
    if (selection.provider !== 'openrouter' && (!stored || apiKey.trim())) {
      modelError = t('settings.model.saveKeyFirst');
      modelErrorSelection = key;
      return;
    }
    modelError = '';
    try {
      await app.loadModels(selection, force);
    } catch {
      modelError = t('settings.model.failed');
      modelErrorSelection = key;
    }
  }

  function chooseReasoning(next: 'default' | 'disabled' | 'custom'): void {
    draft.openrouter_reasoning = next === 'custom'
      ? (mode === 'custom' ? currentReasoning : reasoningEfforts.includes(reasoningMetadata?.default_effort ?? '')
          ? reasoningMetadata!.default_effort! : reasoningEfforts[0] ?? 'enabled')
      : next;
  }

  function discardDraft(): void {
    draft = copySettings(app.settings);
    snapshot = copySettings(app.settings);
    apiKey = '';
    showApiKey = false;
    editingKey = false;
    modelError = '';
    void refreshCredential(draft.provider);
  }

  async function deleteApiKey(): Promise<void> {
    showDeleteConfirm = false;
    // The singleton method intentionally receives only the provider. It never returns or
    // exposes the stored credential value.
    if (await app.deleteApiKey(draft.provider)) {
      credentialProvider = draft.provider;
      credentialState = false;
      credentialMode = 'local';
      savedCredentialMode = 'local';
      apiKey = '';
      showApiKey = false;
      editingKey = false;
    }
  }

  async function importExisting(): Promise<void> {
    importing = true;
    credentialError = '';
    try {
      const status = await importCredential(draft.provider);
      app.credentialRecovery.delete(draft.provider);
      credentialMode = status.mode;
      savedCredentialMode = status.mode;
      credentialState = status.stored;
      if (app.settings.provider === draft.provider) {
        app.credentialMode = status.mode;
        app.apiKeyStored = status.stored;
      }
      app.notify(t('settings.vault.imported'), 'success');
    } catch (cause) {
      credentialError = app.describe(cause);
    } finally { importing = false; }
  }

  function resetDraft(): void {
    draft = copySettings({ ...defaultSettings(), ui_language: app.locale, last_world_dir: app.worldDir });
    apiKey = '';
    showApiKey = false;
    editingKey = false;
    void refreshCredential(draft.provider);
    app.notify(t('settings.resetDraftDone'), 'info');
  }

  async function exportDraft(): Promise<void> {
    try {
      if (await exportDocument('settings', { schema: 1, settings: publicSettingsForExport(draft) })) app.notify(t('export.saved'), 'success');
    } catch (cause) { app.fail(cause); }
  }

  function rangeText(label: MessageKey, minimum: string, maximum: string): string {
    return `${t(label)}: ${minimum}–${maximum}`;
  }
</script>

<div class="page settings" style:--settings-save-height={`${saveBarHeight}px`}>
  <header class="page-head">
    <h1>{t('settings.title')}</h1>
    <p class="lead">{t('settings.lead')}</p>
  </header>

  <form class="settings-form" onsubmit={submit} novalidate>
    <fieldset disabled={!!app.busy && app.busy !== 'models'} aria-busy={app.busy === 'settings'}>
    <section class="card settings-section" aria-labelledby="provider-title">
      <div class="section-head">
        <div class="section-icon" aria-hidden="true"><Icon name="shield" size={20} /></div>
        <div><h2 id="provider-title">{t('settings.provider.title')}</h2><p>{t('settings.provider.help')}</p></div>
      </div>
      <div class="fields two">
        <div class="field">
          <label class="label" for="provider">{t('settings.provider.label')}</label>
          <select id="provider" class="select" value={draft.provider} onchange={providerChanged}>
            {#each providers as provider (provider.value)}<option value={provider.value}>{providerName(provider.value)}</option>{/each}
          </select>
        </div>
        <div class="field">
          <label class="label" for="model">{t('settings.model.label')}</label>
          <input
            id="model"
            class="input"
            type="text"
            bind:value={draft.model}
            list="model-list"
            autocomplete="off"
            placeholder={t('settings.model.placeholder')}
          />
          <div class="model-actions">
            <button type="button" class="btn btn-secondary btn-sm" disabled={!!app.busy || baseUrlInvalid} onclick={() => loadModels(true)}>
              <Icon name="refresh" size={15} /> {t(app.busy === 'models' ? 'settings.model.listing' : 'settings.model.refresh')}
            </button>
            {#if draft.provider === 'openrouter'}<span class="hint">{t('settings.model.public')}</span>{/if}
          </div>
          <div class="hint" role="status" aria-live="polite">
            {#if visibleModelError}<span class="field-error">{visibleModelError}</span>
            {:else if app.busy === 'models'}{t('settings.model.listing')}
            {:else if draft.model.trim() && models.length && !reasoningModel}{t('settings.model.notFound')}
            {:else if reasoningModel}{t('settings.model.verified')}{#if app.modelsCached} · {t('settings.model.cached')}{/if}{/if}
          </div>
          <datalist id="model-list">{#each models as model (model.id)}<option value={model.id}>{model.display_name || model.id}</option>{/each}</datalist>
        </div>
        {#if REASONING_PROVIDERS.includes(draft.provider)}
          <div class="field full reasoning">
            <fieldset class="reasoning-modes" aria-describedby="reasoning-help reasoning-default">
              <legend class="label">{t('settings.reasoning.label')}</legend>
              <div class="mode-options">
                {#each ['default', 'disabled', 'custom'] as choice}
                  <label class="mode-option" class:selected={mode === choice}>
                    <input type="radio" name="reasoning-mode" value={choice} checked={mode === choice}
                      disabled={choice !== 'default' && (!reasoningSupported || (choice === 'disabled' && !!reasoningMetadata?.mandatory))}
                      onchange={() => chooseReasoning(choice as 'default' | 'disabled' | 'custom')} />
                    <span>{t(choice === 'default' ? 'settings.reasoning.default' : choice === 'disabled' ? 'settings.reasoning.disabled' : 'settings.reasoning.custom')}</span>
                  </label>
                {/each}
              </div>
            </fieldset>
            <span id="reasoning-default" class="hint">{defaultReasoningLabel(reasoningModel)}</span>
            {#if mode === 'custom'}
              <div class="field strength">
                <label class="label" for="openrouter-reasoning">{t('settings.reasoning.strength')}</label>
                <select id="openrouter-reasoning" class="select" bind:value={draft.openrouter_reasoning}
                  aria-describedby="reasoning-help" aria-invalid={reasoningInvalid}>
                  {#if currentReasoning === 'enabled' || !reasoningEfforts.length}<option value="enabled">{t('settings.reasoning.unspecified')}</option>{/if}
                  {#each reasoningEfforts as effort}<option value={effort}>{effortLabel(effort)}</option>{/each}
                  {#if hiddenReasoning}<option value={currentReasoning}>{effortLabel(currentReasoning)}</option>{/if}
                </select>
              </div>
            {/if}
            <span id="reasoning-help" class="hint">{t('settings.reasoning.help')}</span>
            {#if reasoningMetadata?.mandatory}<span class="hint">{t('settings.reasoning.mandatory')}</span>{/if}
            {#if reasoningInvalid}<span class="field-error" role="alert">{t('settings.reasoning.unsupported')}</span>{/if}
          </div>
        {/if}
        {#if isCustom}
          <div class="field full">
            <label class="label" for="base-url">{t('settings.baseUrl.label')}</label>
            <input
              id="base-url"
              class="input"
              class:invalid={baseUrlInvalid}
              type="url"
              bind:value={draft.base_url}
              placeholder="https://example.com/v1"
              autocomplete="url"
              aria-invalid={baseUrlInvalid}
              aria-describedby={baseUrlInvalid ? 'base-url-error' : undefined}
            />
            {#if baseUrlInvalid}<span id="base-url-error" class="field-error" role="alert">{t('settings.baseUrl.invalid')}</span>{/if}
          </div>
          <div class="field">
            <label class="label" for="wire-format">{t('settings.wire.label')}</label>
            <select id="wire-format" class="select" bind:value={draft.wire_format}>
              <option value="openai">OpenAI Chat</option>
              <option value="anthropic">Anthropic Messages</option>
            </select>
          </div>
        {/if}
        <div class="field full key-status">
          <div class="label-row">
            <span class="label">{t('settings.apiKey.label')}</span>
            {#if credentialLoading}<span class="hint" role="status">{t('common.loading')}</span>
            {:else if stored === true}<span class="pill pill-success"><Icon name="check" size={13} /> {t('settings.apiKey.stored')}</span>
            {:else if stored === false}<span class="pill">{t('settings.apiKey.missing')}</span>{/if}
          </div>
          {#if stored}<span class="hint">{t(savedCredentialMode === 'local' ? 'settings.vault.local' : savedCredentialMode === 'session' ? 'settings.vault.session' : 'settings.vault.keychain')}</span>{/if}
          {#if stored && !editingKey}
            <div class="model-actions">
              <button type="button" class="btn btn-secondary btn-sm" onclick={() => (editingKey = true)}>{t('settings.apiKey.change')}</button>
              <button type="button" class="btn btn-danger btn-sm" disabled={!!app.busy} onclick={() => (showDeleteConfirm = true)}>{t('settings.apiKey.delete')}</button>
            </div>
          {/if}
          {#if stored === false || editingKey || apiKey}
            <div class="field">
              <label class="label" for="api-key">{t('settings.apiKey.new')}</label>
              <div class="secret-input">
                <input id="api-key" class="input" type={showApiKey ? 'text' : 'password'} bind:value={apiKey} autocomplete="new-password" placeholder={t('settings.apiKey.placeholder')} spellcheck="false" />
                <button type="button" class="btn btn-secondary btn-icon" aria-label={showApiKey ? t('settings.apiKey.hide') : t('settings.apiKey.show')} title={showApiKey ? t('settings.apiKey.hide') : t('settings.apiKey.show')} onclick={() => (showApiKey = !showApiKey)}><Icon name={showApiKey ? 'eye-off' : 'eye'} size={18} /></button>
              </div>
              <span class="hint">{t('settings.apiKey.help')}</span>
              {#if stored}<button type="button" class="btn btn-quiet btn-sm key-cancel" onclick={() => { editingKey = false; apiKey = ''; showApiKey = false; }}>{t('settings.apiKey.cancelChange')}</button>{/if}
            </div>
          {/if}
          {#if credentialError}<p class="field-error" role="alert">{credentialError}</p>{/if}
        </div>
        <details class="field full key-management" id="key-management">
          <summary>{t('settings.vault.manage')}</summary>
          <div class="field">
          <label class="label" for="credential-mode">{t('settings.vault.mode')}</label>
          <select id="credential-mode" class="select" bind:value={credentialMode}>
            <option value="local">{t('settings.vault.local')}</option>
            <option value="session">{t('settings.vault.session')}</option>
            <option value="keychain">{t('settings.vault.keychain')}</option>
          </select>
          <span class="hint">{t('settings.vault.help')}</span>
          </div>
          <button type="button" class="btn btn-secondary" disabled={importing || !!app.busy} onclick={importExisting}>{importing ? t('common.loading') : t('settings.vault.import')}</button>
          <span class="hint">{t('settings.vault.importHelp')}</span>
        </details>
      </div>
      {#if draft.provider === 'openrouter'}
        <div class="usage-panel">
          <button type="button" class="btn btn-secondary" disabled={!!app.busy || !stored || !!apiKey.trim()} onclick={checkUsage}>{app.busy === 'usage' ? t('common.loading') : t('settings.usage.check')}</button>
          <p class="hint">{t('settings.usage.help')}</p>
          {#if usageError}<p class="field-error" role="alert">{usageError}</p>{/if}
          <div role="status" aria-live="polite">
            {#each usageSnapshots as usage}
              <p class="hint">{new Date(usage.checkedAt).toLocaleString()} · {t('settings.usage.total')}: {usage.usage.toFixed(6)}{usage.byokUsage !== null ? ` · BYOK: ${usage.byokUsage.toFixed(6)}` : ''}</p>
            {/each}
          </div>
        </div>
      {/if}
    </section>

    <section class="card settings-section" aria-labelledby="translation-title">
      <div class="section-head">
        <div class="section-icon" aria-hidden="true"><Icon name="language" size={20} /></div>
        <div><h2 id="translation-title">{t('settings.language.title')}</h2><p>{t('settings.language.subtitle')}</p></div>
      </div>
      <div class="fields two">
        <div class="field">
          <label class="label" for="target-language">{t('settings.language.target')}</label>
          <input id="target-language" class="input" type="text" bind:value={draft.target_language} autocomplete="off" aria-describedby="target-language-help" />
          <span id="target-language-help" class="hint">{t('settings.language.targetHelp')}</span>
        </div>
        <div class="field">
          <label class="label" for="style-preset">{t('settings.style.label')}</label>
          <select id="style-preset" class="select" bind:value={draft.style_preset}>
            {#each styles as style (style.value)}<option value={style.value}>{t(style.label)}</option>{/each}
          </select>
        </div>
        <div class="field full">
          <label class="label" for="style-prompt">{t('settings.style.extra')} <span class="optional">{t('common.optional')}</span></label>
          <textarea id="style-prompt" class="textarea" rows="3" bind:value={draft.style_prompt} placeholder={t('settings.style.extraPlaceholder')}></textarea>
        </div>
        <details class="field full">
          <summary>{t('settings.styleAssist.title')}</summary>
          <label class="label" for="style-brief">{t('settings.styleAssist.brief')}</label>
          <textarea id="style-brief" class="textarea" rows="2" maxlength="4000" bind:value={styleBrief}></textarea>
          <p class="hint">{t('settings.styleAssist.help')}</p>
          {#if styleError}<p class="field-error" role="alert">{styleError}</p>{/if}
          <button type="button" class="btn btn-secondary" disabled={!!app.busy || !styleBrief.trim() || !draft.model.trim() || !!apiKey.trim() || !credentialState || hasBlockingError} onclick={() => (showStyleConfirm = true)}>{t('settings.styleAssist.action')}</button>
        </details>
        {#if draft.style_preset === 'custom'}
          <div class="field full">
            <label class="label" for="custom-prompt">{t('settings.style.system')}</label>
            <textarea id="custom-prompt" class="textarea" rows="5" bind:value={draft.custom_system_prompt} placeholder={t('settings.style.system')}></textarea>
          </div>
        {/if}
      </div>
    </section>

    <section class="card settings-section" aria-labelledby="scope-title">
      <details class="advanced" id="scope-settings">
      <summary>
        <span class="section-head compact">
          <span class="section-icon" aria-hidden="true"><Icon name="search" size={20} /></span>
          <span><strong id="scope-title">{t('settings.scope.title')}</strong><small>{t('settings.scope.categoriesHelp')}</small></span>
        </span>
        <Icon name="chevron-down" size={18} />
      </summary>
      <div class="scope-body">
      <div class="checks">
        <label class="check">
          <input type="checkbox" bind:checked={draft.resource_pack_enabled} />
          <span><strong>{t('settings.scope.pack')}</strong><small>{t('settings.scope.packHelp')}</small></span>
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={draft.skip_target_language_text} />
          <span><strong>{t('settings.scope.skipTarget')}</strong><small>{t('settings.scope.skipTargetHelp')}</small></span>
        </label>
      </div>
      {#if draft.resource_pack_enabled}
        <ResourcePackSettings bind:options={draft.resource_pack_options} bind:invalid={packInvalid} />
        <ExternalResourcePacks bind:paths={draft.external_resource_pack_paths} />
      {/if}
      <ScanScopeSettings bind:options={draft.scan_options} />
      <SourceOverrides bind:overrides={draft.source_overrides} bind:invalid={overridesInvalid} />
      </div>
      </details>
    </section>

    <section class="card settings-section" aria-labelledby="performance-title">
        <details class="advanced" open={hasRangeError}>
        <summary>
          <span class="section-head compact">
            <span class="section-icon" aria-hidden="true"><Icon name="sliders" size={20} /></span>
            <span><strong id="performance-title">{t('settings.speed.title')}</strong><small>{t('settings.advanced')}</small></span>
          </span>
          <Icon name="chevron-down" size={18} />
        </summary>
        <div class="fields three">
          <div class="field">
            <label class="label" for="concurrency">{t('settings.speed.concurrency')}</label>
            <input id="concurrency" class="input" class:invalid={rangeInvalid.concurrency} type="number" min="1" max="8" step="1" bind:value={draft.concurrency} aria-invalid={rangeInvalid.concurrency} aria-describedby={rangeInvalid.concurrency ? 'concurrency-error' : 'concurrency-help'} />
            <span id="concurrency-help" class="hint">{t('settings.speed.concurrencyHelp')}</span>
            {#if rangeInvalid.concurrency}<span id="concurrency-error" class="field-error" role="alert">{rangeText('settings.speed.concurrency', '1', '8')}</span>{/if}
          </div>
          <div class="field">
            <label class="label" for="batch-size">{t('settings.speed.batch')}</label>
            <input id="batch-size" class="input" class:invalid={rangeInvalid.batch} type="number" min="1" max="200" step="1" bind:value={draft.batch_size} aria-invalid={rangeInvalid.batch} aria-describedby={rangeInvalid.batch ? 'batch-error' : undefined} />
            {#if rangeInvalid.batch}<span id="batch-error" class="field-error" role="alert">{rangeText('settings.speed.batch', '1', '200')}</span>{/if}
          </div>
          <div class="field">
            <label class="label" for="temperature">{t('settings.speed.temperature')}</label>
            <input id="temperature" class="input" class:invalid={rangeInvalid.temperature} type="number" min="0" max="2" step="0.1" bind:value={draft.temperature} aria-invalid={rangeInvalid.temperature} aria-describedby={rangeInvalid.temperature ? 'temperature-error' : undefined} />
            {#if rangeInvalid.temperature}<span id="temperature-error" class="field-error" role="alert">{rangeText('settings.speed.temperature', '0', '2')}</span>{/if}
          </div>
          <div class="field">
            <label class="label" for="timeout">{t('settings.speed.timeout')}</label>
            <input id="timeout" class="input" class:invalid={rangeInvalid.timeout} type="number" min="5" max="600" step="1" bind:value={draft.request_timeout} aria-invalid={rangeInvalid.timeout} aria-describedby={rangeInvalid.timeout ? 'timeout-error' : undefined} />
            {#if rangeInvalid.timeout}<span id="timeout-error" class="field-error" role="alert">{rangeText('settings.speed.timeout', '5', '600')}</span>{/if}
          </div>
          <div class="field">
            <label class="label" for="retries">{t('settings.speed.retries')}</label>
            <input id="retries" class="input" class:invalid={rangeInvalid.retries} type="number" min="0" max="10" step="1" bind:value={draft.max_batch_retries} aria-invalid={rangeInvalid.retries} aria-describedby={rangeInvalid.retries ? 'retries-error' : undefined} />
            {#if rangeInvalid.retries}<span id="retries-error" class="field-error" role="alert">{rangeText('settings.speed.retries', '0', '10')}</span>{/if}
          </div>
          <div class="field">
            <label class="label" for="write-retries">{t('settings.speed.writeRetries')}</label>
            <input id="write-retries" class="input" type="number" min="1" max="10" step="1" bind:value={draft.max_file_write_retries} aria-invalid={rangeInvalid.writeRetries} aria-describedby="write-retries-help" />
            <span id="write-retries-help" class="hint">{t('settings.speed.writeRetriesHelp')}</span>
            {#if rangeInvalid.writeRetries}<span class="field-error" role="alert">{rangeText('settings.speed.writeRetries', '1', '10')}</span>{/if}
          </div>
          <label class="check field full"><input type="checkbox" bind:checked={draft.continue_on_file_error} /><span>{t('settings.speed.continueFiles')}</span></label>
          <div class="field">
            <label class="label" for="rpm">{t('settings.speed.rpm')}</label>
            <input id="rpm" class="input" class:invalid={rangeInvalid.rpm} type="number" min="0" max="10000" step="1" bind:value={draft.rpm_limit} aria-invalid={rangeInvalid.rpm} aria-describedby={rangeInvalid.rpm ? 'rpm-error' : 'rpm-help'} />
            <span id="rpm-help" class="hint">{t('settings.speed.limitHelp')}</span>
            {#if rangeInvalid.rpm}<span id="rpm-error" class="field-error" role="alert">{rangeText('settings.speed.rpm', '0', '10,000')}</span>{/if}
          </div>
          <div class="field">
            <label class="label" for="tpm">{t('settings.speed.tpm')}</label>
            <input id="tpm" class="input" class:invalid={rangeInvalid.tpm} type="number" min="0" max="10000000" step="100" bind:value={draft.tpm_limit} aria-invalid={rangeInvalid.tpm} aria-describedby={rangeInvalid.tpm ? 'tpm-error' : 'tpm-help'} />
            <span id="tpm-help" class="hint">{t('settings.speed.limitHelp')}</span>
            {#if rangeInvalid.tpm}<span id="tpm-error" class="field-error" role="alert">{rangeText('settings.speed.tpm', '0', '10,000,000')}</span>{/if}
          </div>
        </div>
      </details>
    </section>

    <section class="card settings-section" id="application-settings" aria-labelledby="app-title">
      <div class="section-head">
        <span class="section-icon" aria-hidden="true"><Icon name="sliders" size={20} /></span>
        <div><h2 id="app-title">{t('settings.app.title')}</h2><p>{t('settings.app.subtitle')}</p></div>
      </div>
      <!-- The mode applies the moment it is picked, like the system's own appearance setting. -->
      <fieldset class="appearance" aria-describedby="theme-help">
        <legend class="label">{t('settings.app.appearance')}</legend>
        <div class="theme-options">
          {#each themes as theme (theme.value)}
            <label class="theme-option" class:selected={app.theme === theme.value}>
              <input type="radio" name="theme" value={theme.value} checked={app.theme === theme.value} onchange={() => app.setTheme(theme.value)} />
              <span class="preview {theme.value}" aria-hidden="true"><span class="bar"></span><span class="line"></span><span class="line short"></span></span>
              <span class="name">{t(theme.short)}</span>
            </label>
          {/each}
        </div>
        <span id="theme-help" class="hint">{app.theme === 'system' ? t('settings.theme.following', { mode: t(systemDark ? 'settings.theme.darkShort' : 'settings.theme.lightShort') }) : t('settings.theme.instant')}</span>
      </fieldset>
      <div class="fields two">
        <div class="field">
          <label class="label" for="ui-language">{t('settings.app.language')}</label>
          <select id="ui-language" class="select" value={draft.ui_language} aria-describedby="ui-language-help" onchange={(event) => changeLanguage(event.currentTarget)}>
            <option value="ko">{t('lang.ko')}</option>
            <option value="en">{t('lang.en')}</option>
            <option value="ja">{t('lang.ja')}</option>
          </select>
          <span id="ui-language-help" class="hint">{t('settings.app.languageHelp')}</span>
        </div>
      </div>
    </section>

    <section class="card settings-section">
      <details class="field" id="settings-management">
        <summary>{t('settings.manage')}</summary>
        <div class="actions">
      <input type="file" accept="application/json,.json,.py" bind:this={importInput} onchange={importDraft} hidden />
      <button type="button" class="btn btn-secondary" disabled={!!app.busy || importingSettings} onclick={() => importInput.click()}>{t('settings.import.action')}</button>
      <button type="button" class="btn btn-secondary" disabled={!!app.busy} onclick={exportDraft}>{t('settings.export')}</button>
      <button type="button" class="btn btn-quiet" disabled={!!app.busy} onclick={resetDraft}>{t('settings.resetDraft')}</button>
        </div>
        <p class="hint">{t('settings.import.help')}</p>
      </details>
    </section>

    <AppMaintenance />
    </fieldset>
    <footer class="save-bar" class:dirty bind:clientHeight={saveBarHeight}>
      <div class="save-status" role="status" aria-live="polite">
        <strong>{t(app.busy === 'settings' ? 'settings.saving' : dirty ? 'settings.dirty' : 'settings.savedState')}</strong>
        {#if dirty && hasBlockingError}<span class="field-error">{t('settings.fixErrors')}</span>{/if}
      </div>
      <div class="save-buttons">
      {#if app.returnStep && !dirty}
        <!-- Settings were opened to fix something a step needs: once saved, the way back is the next move. -->
        <button type="button" class="btn btn-primary" disabled={!!app.busy} onclick={() => app.returnFromSettings()}>
          <Icon name="chevron-left" size={15} /> {t('settings.returnTo', { step: t(`step.${app.returnStep}` as MessageKey) })}
        </button>
      {:else}
      <button type="button" class="btn btn-secondary" disabled={!!app.busy || !dirty} onclick={discardDraft}>{t('settings.discard')}</button>
      <button type="submit" class="btn btn-primary" disabled={!!app.busy || hasBlockingError || !dirty}>
        <Icon name="check" size={15} /> {t(app.busy === 'settings' ? 'settings.saving' : app.returnStep ? 'settings.saveReturn' : 'common.save')}
      </button>
      {/if}
      </div>
    </footer>
  </form>
</div>

{#if app.pendingLeave}
  <Dialog
    title={t(app.pendingCloseSource ? 'settings.close.title' : 'settings.leave.title')}
    hideClose={!!app.pendingCloseSource}
    onClose={() => app.resolveLeave(false)}
  >
    <p>{t(app.pendingCloseSource ? 'settings.close.body' : 'settings.leave.body')}</p>
    {#if hasBlockingError}<p class="field-error" role="alert">{t('settings.fixErrors')}</p>{/if}
    {#snippet actions()}
      <button type="button" class="btn btn-quiet leave-stay" disabled={!!app.busy} onclick={() => app.resolveLeave(false)}>{t(app.pendingCloseSource ? 'settings.close.stay' : 'settings.leave.stay')}</button>
      <button type="button" class="btn btn-secondary" disabled={!!app.busy} onclick={leaveWithoutSaving}>{t(app.pendingCloseSource ? 'settings.close.discard' : 'settings.leave.discard')}</button>
      <button type="button" class="btn btn-primary" data-autofocus disabled={!!app.busy || hasBlockingError} onclick={saveAndLeave}>
        {t(app.busy === 'settings' ? 'settings.saving' : app.pendingCloseSource ? 'settings.close.save' : 'settings.leave.save')}
      </button>
    {/snippet}
  </Dialog>
{/if}

{#if showStyleConfirm}
  <Dialog title={t('settings.styleAssist.title')} onClose={() => (showStyleConfirm = false)}>
    <p>{t('settings.styleAssist.confirm')}</p>
    <p><strong>{providerName(draft.provider)} · {draft.model}</strong></p>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" onclick={() => (showStyleConfirm = false)}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-primary" onclick={enhanceStyle}>{t('settings.styleAssist.action')}</button>
    {/snippet}
  </Dialog>
{/if}

{#if showDeleteConfirm}
  <Dialog title={t('settings.apiKey.deleteTitle', { provider: providerName(draft.provider) })} onClose={() => (showDeleteConfirm = false)}>
    <p>{t('settings.apiKey.deleteBody')}</p>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" onclick={() => (showDeleteConfirm = false)}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-danger-solid" onclick={deleteApiKey}>{t('settings.apiKey.delete')}</button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .settings > :global(*), .settings-form > fieldset { max-width: 920px; }
  .settings > .settings-form { max-width: none; }
  .settings-form { display: grid; gap: var(--space-4); }
  .settings-form > fieldset { display: grid; gap: var(--space-4); min-width: 0; margin: 0; padding: 0; border: 0; }
  .settings-form > fieldset :global(input), .settings-form > fieldset :global(select), .settings-form > fieldset :global(textarea), .settings-form > fieldset :global(button), .settings-form > fieldset :global(summary) { scroll-margin-block-end: calc(var(--settings-save-height) + var(--space-4)); }
  .scope-body { display: grid; gap: var(--space-5); }
  .settings-section { padding: var(--space-4) var(--space-5); display: grid; gap: var(--space-4); }
  .section-head { display: flex; align-items: flex-start; gap: var(--space-3); min-width: 0; }
  .section-head h2 { font-size: var(--text-lg); font-weight: 600; }
  .section-head p { color: var(--text-secondary); font-size: var(--text-sm); margin-top: var(--space-1); }
  .section-icon { display: grid; place-items: center; flex: none; width: 28px; height: 28px; border-radius: var(--radius-md); background: var(--accent); color: var(--text-on-accent); }
  .section-icon :global(.icon) { width: 16px; height: 16px; }
  .fields { display: grid; gap: var(--space-4); min-width: 0; }
  .fields.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .fields.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .field { display: grid; gap: var(--space-2); min-width: 0; align-content: start; }
  .field.full { grid-column: 1 / -1; }
  .label { color: var(--text); font-size: var(--text-md); font-weight: 600; }
  .label-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
  .optional { color: var(--text-secondary); font-size: var(--text-xs); font-weight: 400; }
  .hint { color: var(--text-secondary); font-size: var(--text-xs); line-height: 1.45; }
  .input, .select, .textarea { min-width: 0; }
  .input.invalid { border-color: var(--danger-solid); box-shadow: 0 0 0 2px color-mix(in srgb, var(--danger-solid) 18%, transparent); }
  .field-error { color: var(--danger-text); font-size: var(--text-xs); line-height: 1.4; }
  .secret-input { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2); min-width: 0; }
  .secret-input .btn { min-height: var(--control-height); }
  .key-status { border-block-start: 1px solid var(--border); padding-block-start: var(--space-4); }
  .key-cancel { justify-self: start; }
  .key-management summary, #settings-management summary { font-size: var(--text-sm); font-weight: 600; padding-block: var(--space-2); }
  .model-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  .reasoning-modes { border: 0; padding: 0; margin: 0; min-width: 0; }
  .reasoning-modes legend { margin-block-end: var(--space-2); }
  .mode-options { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .mode-option { display: flex; align-items: center; gap: var(--space-2); padding: 0 var(--space-3); min-height: var(--control-height); border: 1px solid var(--border-strong); border-radius: var(--radius-md); background: var(--bg-surface); font-size: var(--text-sm); }
  .mode-option.selected { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-soft-text); }
  .mode-option:has(input:disabled) { opacity: 0.6; cursor: default; }
  .mode-option input { accent-color: var(--accent); margin: 0; }
  .strength { max-width: 320px; }
  .appearance { border: 0; margin: 0; padding: 0; min-width: 0; display: grid; gap: var(--space-2); }
  .appearance legend { margin-bottom: var(--space-2); }
  .theme-options { display: flex; flex-wrap: wrap; gap: var(--space-3); }
  .theme-option { position: relative; display: grid; justify-items: center; gap: 6px; padding: 6px; border-radius: var(--radius-lg); border: 2px solid transparent; }
  /* The real radio covers the tile, so a click anywhere on it chooses, and the keyboard still works. */
  .theme-option input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; z-index: 1; }
  .theme-option.selected { border-color: var(--accent); }
  .theme-option:has(input:focus-visible) { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  .theme-option .name { font-size: var(--text-sm); font-weight: 500; }
  .theme-option.selected .name { font-weight: 600; color: var(--accent-text); }
  /* Miniature windows: fixed colours on purpose, they show each mode whatever the current one is. */
  .preview { width: 96px; height: 60px; border-radius: var(--radius-md); border: 1px solid var(--border-strong); overflow: hidden; display: grid; grid-template-rows: 12px 1fr; align-content: start; gap: 6px; padding-bottom: 6px; }
  .preview .bar { display: block; }
  .preview .line { display: block; height: 6px; margin-inline: 10px; border-radius: 3px; }
  .preview .line.short { width: 40%; }
  .preview.light { background: #f9f8f7; }
  .preview.light .bar { background: #e6e2dd; }
  .preview.light .line { background: #d6d0c8; }
  .preview.dark { background: #1d1914; }
  .preview.dark .bar { background: #37322c; }
  .preview.dark .line { background: #4a443d; }
  .preview.system { background: linear-gradient(135deg, #f9f8f7 0 50%, #1d1914 50% 100%); }
  .preview.system .bar { background: linear-gradient(135deg, #e6e2dd 0 50%, #37322c 50% 100%); }
  .preview.system .line { background: #867b6f; }
  .preview .bar + .line { background-color: #2c6cec; }
  /* A window footer, quiet until there is something to save. */
  .save-bar { position: sticky; inset-block-end: calc(-1 * var(--pane-pad-bottom, 0px)); z-index: 15; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-3);
    margin: 0 calc(-1 * var(--pane-pad-x, 0px)) calc(-1 * var(--pane-pad-bottom, 0px)); padding: 10px var(--pane-pad-x, var(--space-4));
    border-top: 1px solid var(--border); background: var(--bg-toolbar); backdrop-filter: saturate(1.6) blur(16px); -webkit-backdrop-filter: saturate(1.6) blur(16px); }
  .save-bar.dirty { background: color-mix(in srgb, var(--accent-soft) 85%, transparent); border-top-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
  .save-status { display: grid; gap: var(--space-1); font-size: var(--text-sm); color: var(--text-secondary); }
  .save-bar.dirty .save-status { color: var(--accent-soft-text); }
  .save-buttons { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .check { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: var(--space-2); padding: 10px var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-lg); }
  .check input { width: 16px; height: 16px; margin: 1px 0 0; accent-color: var(--accent); }
  .check span { display: grid; gap: var(--space-1); min-width: 0; }
  .check strong { font-size: var(--text-sm); }
  .check small { color: var(--text-secondary); font-size: var(--text-xs); font-weight: 400; }
  .checks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
  .advanced { display: grid; gap: var(--space-5); }
  /* A closed section is just its summary line: no gap waiting for content that is not shown. */
  .settings-form details:not([open]) { row-gap: 0; }
  :global(.dialog) .leave-stay { margin-inline-end: auto; }
  .advanced summary { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); list-style: none; }
  .advanced summary::-webkit-details-marker { display: none; }
  .advanced summary > .section-head { align-items: center; }
  .advanced summary strong { display: block; font-size: var(--text-lg); }
  .advanced summary small { display: block; color: var(--text-secondary); font-size: var(--text-sm); margin-top: 2px; }
  .advanced[open] summary > :global(.icon) { rotate: 180deg; }
  .actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-3); padding-top: var(--space-2); }
  @media (max-width: 760px) {
    .fields.two, .fields.three, .checks { grid-template-columns: 1fr; }
    .field.full { grid-column: auto; }
    .settings-section { padding: var(--space-4); }
  }
  @media (max-width: 420px) {
    .settings-section { padding-inline: var(--space-3); }
    .section-head { gap: var(--space-2); }
    .section-icon { width: 32px; height: 32px; }
    .actions { display: grid; grid-template-columns: 1fr; }
    .save-bar { padding: var(--space-3); }
    .save-buttons { width: 100%; }
    .save-buttons .btn { flex: 1; }
  }
  @media (min-width: 1500px) {
    .settings-form > fieldset { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; }
    .settings-form > fieldset > .settings-section:first-child, .settings-form > fieldset > .settings-section:nth-child(2) { grid-column: span 1; }
    .settings-form > fieldset > .settings-section:nth-child(n+3) { grid-column: 1 / -1; }
  }
</style>
