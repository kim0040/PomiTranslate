<script lang="ts">
  import { tick, untrack } from 'svelte';
  import Dialog from '../components/Dialog.svelte';
  import AppMaintenance from '../components/AppMaintenance.svelte';
  import Disclosure from '../components/Disclosure.svelte';
  import FileRulesSettings from '../components/FileRulesSettings.svelte';
  import Icon from '../components/Icon.svelte';
  import ModelPicker from '../components/ModelPicker.svelte';
  import ScanScopeSettings from '../components/ScanScopeSettings.svelte';
  import ResourcePackSettings from '../components/ResourcePackSettings.svelte';
  import ExternalResourcePacks from '../components/ExternalResourcePacks.svelte';
  import SourceOverrides from '../components/SourceOverrides.svelte';
  import GlossaryEditor from '../components/GlossaryEditor.svelte';
  import TargetLanguageSelect from '../components/TargetLanguageSelect.svelte';
  import { copySettings, defaultScanOptions, publicSettingsForExport, STYLE_PRESETS } from '../lib/settings';
  import { SETTINGS_TABS, pendingChanges, totalPending, type SettingsTab } from '../lib/settings-tabs';
  import { isValidCustomEndpoint, parseSettingsImport } from '../lib/settings-import';
  import { connectionErrorKey, isSuitable } from '../lib/models';
  import { PROVIDER_DEFAULTS } from '../lib/providers';
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

  const themes: { value: ThemeChoice; short: MessageKey }[] = [
    { value: 'system', short: 'settings.theme.systemShort' },
    { value: 'light', short: 'settings.theme.lightShort' },
    { value: 'dark', short: 'settings.theme.darkShort' }
  ];
  const tabLabels: Record<SettingsTab, MessageKey> = {
    translate: 'settings.tab.translate', scope: 'settings.tab.scope', advanced: 'settings.tab.advanced', app: 'settings.tab.app'
  };
  // What "system" means right now, so the choice explains itself.
  let systemDark = $state(typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  $effect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(prefers-color-scheme: dark)');
    const listener = () => { systemDark = query.matches; };
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
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
  let glossaryInvalid = $state(false);
  let customPriceInput = $state('');
  let customPriceOutput = $state('');
  let lastPriceSelection = '';
  let packInvalid = $state(false);
  let usageSnapshots = $state<ProviderUsage[]>([]);
  let usageError = $state('');
  let modelError = $state('');
  let modelErrorSelection = $state('');
  let lastAutoLookup = '';
  let saveBarHeight = $state(0);
  let connection = $state<{ status: 'idle' | 'checking' | 'ok' | 'error'; count: number; code: string }>({ status: 'idle', count: 0, code: '' });
  let packOpen = $state(app.settings.resource_pack_enabled);
  let keyOpen = $state(false);
  // Bumped when the draft is replaced from outside, so an editor holding unfinished input starts over.
  let draftEpoch = $state(0);

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
      draftEpoch += 1;
      apiKey = '';
      showApiKey = false;
      editingKey = false;
      connection = { status: 'idle', count: 0, code: '' };
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
    packOpen = !!app.settings.resource_pack_enabled;
    void refreshCredential(app.settings.provider);
  });

  const isCustom = $derived(draft.provider === 'custom');
  const models = $derived(app.modelsFor(draft));
  const reasoningModel = $derived(models.find((model) => model.id === draft.model.trim()));
  const selectedPriceKey = $derived(`${draft.provider}/${draft.model.trim()}`);
  const hasCatalogPrice = (value: unknown): boolean => {
    if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return false;
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= 0;
  };
  const catalogPriceAvailable = $derived.by(() => {
    const item = models.find((model) => model.id === draft.model.trim());
    if (!item) return false;
    return hasCatalogPrice(item.pricing_prompt) && hasCatalogPrice(item.pricing_completion);
  });
  const savedSelectedPrice = $derived(snapshot?.custom_prices?.[selectedPriceKey]);
  const customPriceInvalid = $derived([customPriceInput, customPriceOutput].some((value) => {
    if (!value.trim()) return false;
    const amount = Number(value);
    return !Number.isFinite(amount) || amount < 0 || amount > 1000;
  }));
  const customPriceIncomplete = $derived((customPriceInput.trim() === '') !== (customPriceOutput.trim() === ''));
  const customPriceDraftDirty = $derived(!!snapshot && (
    (customPriceInput.trim() ? Number(customPriceInput) : null) !== (savedSelectedPrice?.input ?? null) ||
    (customPriceOutput.trim() ? Number(customPriceOutput) : null) !== (savedSelectedPrice?.output ?? null)
  ));
  const reasoningMetadata = $derived(reasoningModel?.reasoning);
  const reasoningSupported = $derived(supportsReasoning(reasoningModel));
  const reasoningEfforts = $derived(supportedEfforts(reasoningModel));
  const currentReasoning = $derived(draft.openrouter_reasoning ?? 'default');
  const mode = $derived(reasoningMode(currentReasoning));
  const hiddenReasoning = $derived(!['default', 'enabled', 'disabled', ...reasoningEfforts].includes(currentReasoning));
  const reasoningInvalid = $derived(REASONING_PROVIDERS.includes(draft.provider) && currentReasoning !== 'default' &&
    (!reasoningModel || !reasoningSupported || (currentReasoning === 'disabled' && !!reasoningMetadata?.mandatory) || hiddenReasoning));
  const dirty = $derived(!!snapshot && (JSON.stringify(copySettings(draft)) !== JSON.stringify(copySettings(snapshot)) || customPriceDraftDirty ||
    !!apiKey.trim() || credentialMode !== savedCredentialMode));
  const pending = $derived(snapshot
    ? pendingChanges(draft, snapshot, { keyTyped: !!apiKey.trim(), storageModeChanged: credentialMode !== savedCredentialMode })
    : { translate: 0, scope: 0, advanced: 0, app: 0 });
  const pendingTabs = $derived(SETTINGS_TABS.filter((name) => pending[name] > 0));
  const selectionKey = $derived(`${draft.provider}:${draft.model.trim()}`);
  const visibleModelError = $derived(modelErrorSelection === selectionKey ? modelError : '');
  const tab = $derived(app.settingsTab);
  // The update badge and the Help menu's update check both land on the app tab.
  $effect(() => { if (app.helpSection === 'updates') app.settingsTab = 'app'; });

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
    maxCost: !inRange(draft.max_cost_usd, 0, 1000),
    writeRetries: !inRange(draft.max_file_write_retries, 1, 10) || !Number.isInteger(draft.max_file_write_retries),
    concurrency: !inRange(draft.concurrency, 1, 8)
  }));
  const hasRangeError = $derived(Object.values(rangeInvalid).some(Boolean));
  // Input an editor holds but cannot hand to the draft yet (a half-written row): it exists only because someone typed it.
  const incomplete = $derived(overridesInvalid || glossaryInvalid || customPriceIncomplete || (!!draft.resource_pack_enabled && packInvalid));
  const hasBlockingError = $derived(reasoningInvalid || hasRangeError || customPriceInvalid || customPriceIncomplete || overridesInvalid || glossaryInvalid || (draft.resource_pack_enabled && packInvalid) || (isCustom && !validBaseUrl(draft.base_url)));
  // The tabs that hold an error, so a blocked save says where to look.
  const errorTabs = $derived(SETTINGS_TABS.filter((name) =>
    (name === 'translate' && (reasoningInvalid || customPriceInvalid || customPriceIncomplete || glossaryInvalid || rangeInvalid.maxCost)) ||
    (name === 'scope' && (overridesInvalid || (draft.resource_pack_enabled && packInvalid))) ||
    (name === 'advanced' && (hasRangeError || baseUrlInvalid))));
  const showSaveBar = $derived(pending[tab] > 0 || errorTabs.includes(tab) ||
    (tab === 'scope' && incomplete) || (app.returnStep && !dirty && !incomplete));
  const attentionTabs = $derived(SETTINGS_TABS.filter((name) => name !== tab &&
    (pending[name] > 0 || errorTabs.includes(name) || (name === 'scope' && incomplete))));
  const showCrossTabAttention = $derived(attentionTabs.length > 0 && pending[tab] === 0 &&
    !errorTabs.includes(tab) && !(tab === 'scope' && incomplete));
  const stored = $derived(credentialProvider === draft.provider ? credentialState : null);

  $effect(() => {
    const key = selectedPriceKey;
    if (key === lastPriceSelection) return;
    lastPriceSelection = key;
    const price = draft.custom_prices?.[selectedPriceKey];
    customPriceInput = price ? String(price.input) : '';
    customPriceOutput = price ? String(price.output) : '';
  });

  function changeCustomPrice(which: 'input' | 'output', value: string): void {
    if (which === 'input') customPriceInput = value;
    else customPriceOutput = value;
    const input = customPriceInput.trim() ? Number(customPriceInput) : null;
    const output = customPriceOutput.trim() ? Number(customPriceOutput) : null;
    const prices = { ...(draft.custom_prices ?? {}) };
    if (input !== null && output !== null && Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0 && input <= 1000 && output <= 1000) {
      const current = prices[selectedPriceKey];
      if (!current || current.input !== input || current.output !== output) prices[selectedPriceKey] = { input, output };
    } else {
      delete prices[selectedPriceKey];
    }
    draft.custom_prices = prices;
  }
  const providerName = (provider: string): string => {
    const item = providers.find((choice) => choice.value === provider);
    if (!item) return provider;
    return provider === 'custom' ? t('settings.provider.custom') : item.label;
  };
  const tabNames = (names: SettingsTab[]): string => names.map((name) => t(tabLabels[name])).join('·');

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
    const defaults = PROVIDER_DEFAULTS[draft.provider];
    if (defaults) {
      // A custom endpoint can contain credentials controlled by a different operator. Never
      // carry it into a public provider selection where the field is hidden from the user.
      draft.base_url = defaults.baseUrl;
      draft.wire_format = defaults.wireFormat;
    } else if (draft.provider === 'custom' && PROVIDER_DEFAULTS[snapshot?.provider || '']) {
      draft.base_url = '';
      draft.wire_format = 'openai';
    }
    apiKey = '';
    showApiKey = false;
    editingKey = false;
    modelError = '';
    connection = { status: 'idle', count: 0, code: '' };
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
  // Unfinished input that cannot be saved yet (a half-written row) is also worth a question before leaving.
  $effect(() => { app.settingsDirty = dirty || incomplete; });
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
    const typed = apiKey.trim();
    if (selection.provider !== 'openrouter' && !stored && !typed) {
      modelError = t('settings.model.needKey');
      modelErrorSelection = key;
      return;
    }
    modelError = '';
    try {
      // A typed key that is not saved yet is sent once with this request and never kept.
      if (typed && force) await app.checkConnection(selection, typed);
      else await app.loadModels(selection, force);
    } catch {
      modelError = t('settings.model.failed');
      modelErrorSelection = key;
    }
  }

  async function checkKey(): Promise<void> {
    if (!snapshot || app.busy || baseUrlInvalid) return;
    const selection = copySettings(draft);
    connection = { status: 'checking', count: 0, code: '' };
    const result = await app.testConnection(selection, apiKey.trim());
    connection = result.ok
      ? { status: 'ok', count: app.modelsFor(selection).filter(isSuitable).length, code: '' }
      : { status: 'error', count: 0, code: result.code };
  }

  function chooseReasoning(next: 'default' | 'disabled' | 'custom'): void {
    draft.openrouter_reasoning = next === 'custom'
      ? (mode === 'custom' ? currentReasoning : reasoningEfforts.includes(reasoningMetadata?.default_effort ?? '')
          ? reasoningMetadata!.default_effort! : reasoningEfforts[0] ?? 'enabled')
      : next;
  }

  function discardDraft(): void {
    draftEpoch += 1;
    lastPriceSelection = '';
    draft = copySettings(app.settings);
    snapshot = copySettings(app.settings);
    apiKey = '';
    showApiKey = false;
    editingKey = false;
    modelError = '';
    connection = { status: 'idle', count: 0, code: '' };
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
      connection = { status: 'idle', count: 0, code: '' };
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
    draftEpoch += 1;
    lastPriceSelection = '';
    draft = copySettings({ ...defaultSettings(), ui_language: app.locale, last_world_dir: app.worldDir });
    apiKey = '';
    showApiKey = false;
    editingKey = false;
    connection = { status: 'idle', count: 0, code: '' };
    void refreshCredential(draft.provider);
    app.notify(t('settings.resetDraftDone'), 'info');
  }

  /** Put one section's fields back to the shipped values. Like all edits, it is saved with the save button. */
  function resetSpeed(): void {
    const defaults = defaultSettings();
    Object.assign(draft, {
      concurrency: defaults.concurrency, batch_size: defaults.batch_size, temperature: defaults.temperature,
      request_timeout: defaults.request_timeout, rpm_limit: defaults.rpm_limit, tpm_limit: defaults.tpm_limit,
      max_batch_retries: defaults.max_batch_retries, max_file_write_retries: defaults.max_file_write_retries,
      continue_on_file_error: defaults.continue_on_file_error
    });
  }
  function resetRules(): void {
    const defaults = defaultScanOptions();
    draft.scan_options = {
      ...draft.scan_options!,
      region_dirs: defaults.region_dirs, skip_patterns: defaults.skip_patterns, component_translate_key_prefixes: defaults.component_translate_key_prefixes
    };
  }

  async function exportDraft(): Promise<void> {
    try {
      if (await exportDocument('settings', { schema: 1, settings: publicSettingsForExport(draft) })) app.notify(t('export.saved'), 'success');
    } catch (cause) { app.fail(cause); }
  }

  function rangeText(label: MessageKey, minimum: string, maximum: string): string {
    return `${t(label)}: ${minimum}–${maximum}`;
  }

  function selectTab(next: SettingsTab, focus = false): void {
    app.settingsTab = next;
    if (focus) void tick().then(() => document.getElementById(`settings-tab-${next}`)?.focus());
  }
  function onTabKeydown(event: KeyboardEvent): void {
    const index = SETTINGS_TABS.indexOf(tab);
    const last = SETTINGS_TABS.length - 1;
    const target = event.key === 'ArrowRight' ? (index + 1) % SETTINGS_TABS.length
      : event.key === 'ArrowLeft' ? (index + last) % SETTINGS_TABS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? last : -1;
    if (target < 0) return;
    event.preventDefault();
    selectTab(SETTINGS_TABS[target], true);
  }
</script>

<div class="page settings" style:--settings-save-height={`${showSaveBar ? saveBarHeight : 0}px`}>
  <header class="page-head">
    <h1>{t('settings.title')}</h1>
    <p class="lead">{t('settings.lead')}</p>
  </header>

  <form class="settings-form" onsubmit={submit} novalidate>
    <div class="tabs" role="tablist" aria-label={t('settings.tabs')} tabindex="-1" onkeydown={onTabKeydown}>
      {#each SETTINGS_TABS as name (name)}
        <button type="button" role="tab" id="settings-tab-{name}" class="tab" class:invalid={errorTabs.includes(name)} aria-selected={tab === name} aria-controls="settings-panel-{name}"
          tabindex={tab === name ? 0 : -1} onclick={() => selectTab(name)}>
          {t(tabLabels[name])}
          {#if pending[name] > 0}<span class="dot num" title={t('settings.pendingTab', { count: pending[name] })}>{pending[name]}</span>{/if}
        </button>
      {/each}
    </div>
    {#if showCrossTabAttention}<p class="cross-tab-pending" role="status">{t('settings.otherTabsAttention', { tabs: tabNames(attentionTabs) })}</p>{/if}
    <fieldset disabled={!!app.busy && app.busy !== 'models'} aria-busy={app.busy === 'settings'}>

    <!-- 번역: provider, model, key, language -->
    <div class="panel" role="tabpanel" id="settings-panel-translate" aria-labelledby="settings-tab-translate" hidden={tab !== 'translate'}>
      <Disclosure id="provider-settings" icon="key" title={t('settings.provider.title')} subtitle={t('settings.provider.help')} open>
        <div class="fields two">
          <div class="field">
            <label class="label" for="provider">{t('settings.provider.label')}</label>
            <select id="provider" class="select" value={draft.provider} onchange={providerChanged}>
              {#each providers as provider (provider.value)}<option value={provider.value}>{providerName(provider.value)}</option>{/each}
            </select>
          </div>
          <div class="field">
            <label class="label" for="model">{t('settings.model.label')}</label>
            <ModelPicker id="model" bind:value={draft.model} {models} placeholder={t('settings.model.placeholder')} describedby="model-hint" />
            <div class="model-actions">
              <button type="button" class="btn btn-secondary btn-sm" disabled={!!app.busy || baseUrlInvalid} onclick={() => loadModels(true)}>
                <Icon name="refresh" size={15} /> {t(app.busy === 'models' ? 'settings.model.listing' : 'settings.model.refresh')}
              </button>
              {#if draft.provider === 'openrouter'}<span class="hint">{t('settings.model.public')}</span>{/if}
            </div>
            <div id="model-hint" class="hint" role="status" aria-live="polite">
              {#if visibleModelError}<span class="field-error">{visibleModelError}</span>
              {:else if app.busy === 'models'}{t('settings.model.listing')}
              {:else if draft.model.trim() && models.length && !reasoningModel}{t('settings.model.notFound')}
              {:else if reasoningModel}{t('settings.model.verified')}{#if app.modelsCached} · {t('settings.model.cached')}{/if}{/if}
            </div>
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
            <p class="hint full">
              {t('settings.endpoint.pointer')}
              <button type="button" class="linklike" onclick={() => selectTab('advanced')}>{t('settings.endpoint.open')}</button>
              {#if baseUrlInvalid}<span class="field-error" role="alert"> {t('settings.baseUrl.invalid')}</span>{/if}
            </p>
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
                  <input id="api-key" class="input" type={showApiKey ? 'text' : 'password'} bind:value={apiKey} autocomplete="new-password" placeholder={t('settings.apiKey.placeholder')} spellcheck="false"
                    oninput={() => { connection = { status: 'idle', count: 0, code: '' }; }} />
                  <button type="button" class="btn btn-secondary btn-icon" aria-label={showApiKey ? t('settings.apiKey.hide') : t('settings.apiKey.show')} title={showApiKey ? t('settings.apiKey.hide') : t('settings.apiKey.show')} onclick={() => (showApiKey = !showApiKey)}><Icon name={showApiKey ? 'eye-off' : 'eye'} size={18} /></button>
                </div>
                <span class="hint">{t('settings.apiKey.help')}</span>
                {#if stored}<button type="button" class="btn btn-quiet btn-sm key-cancel" onclick={() => { editingKey = false; apiKey = ''; showApiKey = false; connection = { status: 'idle', count: 0, code: '' }; }}>{t('settings.apiKey.cancelChange')}</button>{/if}
              </div>
            {/if}
            <div class="model-actions">
              <button type="button" class="btn btn-secondary btn-sm" disabled={!!app.busy || baseUrlInvalid || (!stored && !apiKey.trim())} onclick={checkKey}>
                <Icon name="check-circle" size={15} /> {t(connection.status === 'checking' ? 'setup.key.checking' : 'settings.apiKey.check')}
              </button>
              <span class="hint" role="status" aria-live="polite">
                {#if connection.status === 'ok'}<span class="ok"><Icon name="check" size={13} /> {t('setup.key.connected', { count: connection.count })}</span>
                {:else if connection.status === 'error'}<span class="field-error">{t(connectionErrorKey(connection.code))}</span>{/if}
              </span>
            </div>
            {#if credentialError}<p class="field-error" role="alert">{credentialError}</p>{/if}
          </div>
          <div class="full">
            <Disclosure id="key-management" variant="inline" level={3} title={t('settings.vault.manage')} bind:open={keyOpen}>
              <div class="field">
                <label class="label" for="credential-mode">{t('settings.vault.mode')}</label>
                <select id="credential-mode" class="select" bind:value={credentialMode}>
                  <option value="local">{t('settings.vault.local')}</option>
                  <option value="session">{t('settings.vault.session')}</option>
                  <option value="keychain">{t('settings.vault.keychain')}</option>
                </select>
                <span class="hint">{t('settings.vault.help')}</span>
              </div>
              <div class="field">
                <div><button type="button" class="btn btn-secondary" disabled={importing || !!app.busy} onclick={importExisting}>{importing ? t('common.loading') : t('settings.vault.import')}</button></div>
                <span class="hint">{t('settings.vault.importHelp')}</span>
              </div>
            </Disclosure>
          </div>
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
      </Disclosure>

      {#if draft.model.trim() && !catalogPriceAvailable}
        <Disclosure id="user-model-price" icon="dollar" title={t('settings.price.title')} subtitle={t('settings.price.subtitle')} forceOpen={customPriceInvalid || customPriceIncomplete}>
          <p id="custom-price-help" class="hint">{t('settings.price.help')}</p>
          <div class="fields two">
            <div class="field">
              <label class="label" for="custom-price-input">{t('settings.price.input')}</label>
              <input id="custom-price-input" class="input" type="number" min="0" max="1000" step="any" value={customPriceInput}
                aria-invalid={customPriceInvalid} aria-describedby="custom-price-help custom-price-input-error"
                oninput={(event) => changeCustomPrice('input', event.currentTarget.value)} />
              {#if customPriceInvalid && customPriceInput}<span id="custom-price-input-error" class="field-error" role="alert">{t('settings.price.range')}</span>{/if}
            </div>
            <div class="field">
              <label class="label" for="custom-price-output">{t('settings.price.output')}</label>
              <input id="custom-price-output" class="input" type="number" min="0" max="1000" step="any" value={customPriceOutput}
                aria-invalid={customPriceInvalid} aria-describedby="custom-price-help custom-price-output-error"
                oninput={(event) => changeCustomPrice('output', event.currentTarget.value)} />
              {#if customPriceInvalid && customPriceOutput}<span id="custom-price-output-error" class="field-error" role="alert">{t('settings.price.range')}</span>{/if}
              {#if customPriceIncomplete}<span class="field-error" role="alert">{t('settings.price.bothRequired')}</span>{/if}
            </div>
          </div>
          {#if draft.custom_prices?.[selectedPriceKey]}<p class="hint">{t('settings.price.userBasis')}</p>{/if}
        </Disclosure>
      {/if}

      <Disclosure id="translation-settings" icon="language" title={t('settings.language.title')} subtitle={t('settings.language.subtitle')} open>
        <div class="fields two">
          <div class="field">
            <label class="label" for="target-language">{t('settings.language.target')}</label>
            <TargetLanguageSelect id="target-language" bind:value={draft.target_language} describedby="target-language-help" />
            <span id="target-language-help" class="hint">{t('settings.language.targetHelp')}</span>
          </div>
          <div class="field">
            <label class="label" for="style-preset">{t('settings.style.label')}</label>
            <select id="style-preset" class="select" bind:value={draft.style_preset}>
              {#each STYLE_PRESETS as style (style.value)}<option value={style.value}>{t(style.label)}</option>{/each}
            </select>
          </div>
          <div class="field full">
            <label class="label" for="style-prompt">{t('settings.style.extra')} <span class="optional">{t('common.optional')}</span></label>
            <textarea id="style-prompt" class="textarea" rows="3" bind:value={draft.style_prompt} placeholder={t('settings.style.extraPlaceholder')}></textarea>
          </div>
          <div class="full">
            <Disclosure id="style-assist" variant="inline" level={3} title={t('settings.styleAssist.title')}>
              <div class="field">
                <label class="label" for="style-brief">{t('settings.styleAssist.brief')}</label>
                <textarea id="style-brief" class="textarea" rows="2" maxlength="4000" bind:value={styleBrief}></textarea>
                <p class="hint">{t('settings.styleAssist.help')}</p>
                {#if styleError}<p class="field-error" role="alert">{styleError}</p>{/if}
                <div><button type="button" class="btn btn-secondary" disabled={!!app.busy || !styleBrief.trim() || !draft.model.trim() || !!apiKey.trim() || !credentialState || hasBlockingError} onclick={() => (showStyleConfirm = true)}>{t('settings.styleAssist.action')}</button></div>
              </div>
            </Disclosure>
          </div>
          {#if draft.style_preset === 'custom'}
            <div class="field full">
              <label class="label" for="custom-prompt">{t('settings.style.system')}</label>
              <textarea id="custom-prompt" class="textarea" rows="5" bind:value={draft.custom_system_prompt} placeholder={t('settings.style.system')}></textarea>
            </div>
          {/if}
        </div>
      </Disclosure>

      <Disclosure id="cost-protection" icon="shield" title={t('settings.costProtection.title')} subtitle={t('settings.costProtection.subtitle')} open forceOpen={rangeInvalid.maxCost}>
        <div class="fields two">
          <label class="check">
            <input type="checkbox" bind:checked={draft.review_before_apply} />
            <span><strong>{t('settings.costProtection.review')}</strong><small>{t('settings.costProtection.reviewHelp')}</small></span>
          </label>
          <div class="field">
            <label class="label" for="max-cost-usd">{t('settings.costProtection.cap')}</label>
            <input id="max-cost-usd" class="input" type="number" min="0" max="1000" step="0.01" bind:value={draft.max_cost_usd}
              aria-invalid={rangeInvalid.maxCost} aria-describedby="max-cost-help max-cost-error" />
            <span id="max-cost-help" class="hint">{t('settings.costProtection.capHelp')}</span>
            {#if rangeInvalid.maxCost}<span id="max-cost-error" class="field-error" role="alert">{t('settings.costProtection.capError')}</span>{/if}
          </div>
        </div>
      </Disclosure>

      <Disclosure id="global-glossary" icon="book" title={t('glossary.title')} subtitle={t('glossary.count', { count: draft.glossary?.length ?? 0 })} forceOpen={glossaryInvalid}>
        <GlossaryEditor bind:entries={draft.glossary} bind:invalid={glossaryInvalid} resetKey={draftEpoch} />
      </Disclosure>
    </div>

    <!-- 스캔 범위: what text is found, ZIP resource packs, saved manual translations -->
    <div class="panel" role="tabpanel" id="settings-panel-scope" aria-labelledby="settings-tab-scope" hidden={tab !== 'scope'}>
      <Disclosure id="scope-settings" icon="search" title={t('settings.scope.title')} open>
        <div class="checks">
          <label class="check">
            <input type="checkbox" bind:checked={draft.skip_target_language_text} />
            <span><strong>{t('settings.scope.skipTarget')}</strong><small>{t('settings.scope.skipTargetHelp')}</small></span>
          </label>
        </div>
        <ScanScopeSettings bind:options={draft.scan_options} />
      </Disclosure>

      <Disclosure id="resource-pack-settings" icon="archive" title={t('settings.scope.packTitle')} bind:open={packOpen} forceOpen={draft.resource_pack_enabled && packInvalid}>
        <label class="check">
          <input type="checkbox" bind:checked={draft.resource_pack_enabled} />
          <span><strong>{t('settings.scope.pack')}</strong><small>{t('settings.scope.packHelp')}</small></span>
        </label>
        {#if draft.resource_pack_enabled}
          <ResourcePackSettings bind:options={draft.resource_pack_options} bind:invalid={packInvalid} />
          <ExternalResourcePacks bind:paths={draft.external_resource_pack_paths} />
        {/if}
      </Disclosure>

      <Disclosure id="manual-translations" icon="pencil" title={t('settings.overrides.title')} subtitle={t('overrides.count', { count: Object.keys(draft.source_overrides ?? {}).length })} forceOpen={overridesInvalid}>
        <SourceOverrides bind:overrides={draft.source_overrides} bind:invalid={overridesInvalid} resetKey={draftEpoch} />
      </Disclosure>
    </div>

    <!-- 고급: performance, file and key rules, custom endpoint, import / export -->
    <div class="panel" role="tabpanel" id="settings-panel-advanced" aria-labelledby="settings-tab-advanced" hidden={tab !== 'advanced'}>
      <Disclosure id="performance-settings" icon="gauge" title={t('settings.speed.title')} subtitle={t('settings.speed.subtitle')} open forceOpen={hasRangeError}>
        <div class="fields three">
          <div class="field">
            <label class="label" for="concurrency">{t('settings.speed.concurrency')}</label>
            <input id="concurrency" class="input" class:invalid={rangeInvalid.concurrency} type="number" min="1" max="8" step="1" bind:value={draft.concurrency} aria-invalid={rangeInvalid.concurrency} aria-describedby={rangeInvalid.concurrency ? 'concurrency-error' : 'concurrency-help'} />
            <span id="concurrency-help" class="hint">{t('settings.speed.concurrencyHelp')}</span>
            {#if rangeInvalid.concurrency}<span id="concurrency-error" class="field-error" role="alert">{rangeText('settings.speed.concurrency', '1', '8')}</span>{/if}
          </div>
          <div class="field">
            <label class="label" for="batch-size">{t('settings.speed.batch')}</label>
            <input id="batch-size" class="input" class:invalid={rangeInvalid.batch} type="number" min="1" max="200" step="1" bind:value={draft.batch_size} aria-invalid={rangeInvalid.batch} aria-describedby={rangeInvalid.batch ? 'batch-error' : 'batch-help'} />
            <span id="batch-help" class="hint">{t('settings.speed.batchHelp')}</span>
            {#if rangeInvalid.batch}<span id="batch-error" class="field-error" role="alert">{rangeText('settings.speed.batch', '1', '200')}</span>{/if}
          </div>
          <div class="field">
            <label class="label" for="temperature">{t('settings.speed.temperature')}</label>
            <input id="temperature" class="input" class:invalid={rangeInvalid.temperature} type="number" min="0" max="2" step="0.1" bind:value={draft.temperature} aria-invalid={rangeInvalid.temperature} aria-describedby={rangeInvalid.temperature ? 'temperature-error' : 'temperature-help'} />
            <span id="temperature-help" class="hint">{t('settings.speed.temperatureHelp')}</span>
            {#if rangeInvalid.temperature}<span id="temperature-error" class="field-error" role="alert">{rangeText('settings.speed.temperature', '0', '2')}</span>{/if}
          </div>
          <div class="field">
            <label class="label" for="timeout">{t('settings.speed.timeout')}</label>
            <input id="timeout" class="input" class:invalid={rangeInvalid.timeout} type="number" min="5" max="600" step="1" bind:value={draft.request_timeout} aria-invalid={rangeInvalid.timeout} aria-describedby={rangeInvalid.timeout ? 'timeout-error' : 'timeout-help'} />
            <span id="timeout-help" class="hint">{t('settings.speed.timeoutHelp')}</span>
            {#if rangeInvalid.timeout}<span id="timeout-error" class="field-error" role="alert">{rangeText('settings.speed.timeout', '5', '600')}</span>{/if}
          </div>
          <div class="field">
            <label class="label" for="retries">{t('settings.speed.retries')}</label>
            <input id="retries" class="input" class:invalid={rangeInvalid.retries} type="number" min="0" max="10" step="1" bind:value={draft.max_batch_retries} aria-invalid={rangeInvalid.retries} aria-describedby={rangeInvalid.retries ? 'retries-error' : 'retries-help'} />
            <span id="retries-help" class="hint">{t('settings.speed.retriesHelp')}</span>
            {#if rangeInvalid.retries}<span id="retries-error" class="field-error" role="alert">{rangeText('settings.speed.retries', '0', '10')}</span>{/if}
          </div>
          <div class="field">
            <label class="label" for="write-retries">{t('settings.speed.writeRetries')}</label>
            <input id="write-retries" class="input" type="number" min="1" max="10" step="1" bind:value={draft.max_file_write_retries} aria-invalid={rangeInvalid.writeRetries} aria-describedby="write-retries-help" />
            <span id="write-retries-help" class="hint">{t('settings.speed.writeRetriesHelp')}</span>
            {#if rangeInvalid.writeRetries}<span class="field-error" role="alert">{rangeText('settings.speed.writeRetries', '1', '10')}</span>{/if}
          </div>
          <div class="field">
            <label class="label" for="rpm">{t('settings.speed.rpm')}</label>
            <input id="rpm" class="input" class:invalid={rangeInvalid.rpm} type="number" min="0" max="10000" step="1" bind:value={draft.rpm_limit} aria-invalid={rangeInvalid.rpm} aria-describedby={rangeInvalid.rpm ? 'rpm-error' : 'rpm-help'} />
            <span id="rpm-help" class="hint">{t('settings.speed.rpmHelp')}</span>
            {#if rangeInvalid.rpm}<span id="rpm-error" class="field-error" role="alert">{rangeText('settings.speed.rpm', '0', '10,000')}</span>{/if}
          </div>
          <div class="field">
            <label class="label" for="tpm">{t('settings.speed.tpm')}</label>
            <input id="tpm" class="input" class:invalid={rangeInvalid.tpm} type="number" min="0" max="10000000" step="100" bind:value={draft.tpm_limit} aria-invalid={rangeInvalid.tpm} aria-describedby={rangeInvalid.tpm ? 'tpm-error' : 'tpm-help'} />
            <span id="tpm-help" class="hint">{t('settings.speed.tpmHelp')}</span>
            {#if rangeInvalid.tpm}<span id="tpm-error" class="field-error" role="alert">{rangeText('settings.speed.tpm', '0', '10,000,000')}</span>{/if}
          </div>
          <label class="check field full"><input type="checkbox" bind:checked={draft.continue_on_file_error} aria-describedby="continue-help" /><span><strong>{t('settings.speed.continueFiles')}</strong><small id="continue-help">{t('settings.speed.continueHelp')}</small></span></label>
        </div>
        <div><button type="button" class="btn btn-quiet btn-sm" onclick={resetSpeed}><Icon name="undo" size={14} /> {t('settings.sectionDefaults')}</button></div>
      </Disclosure>

      <Disclosure id="file-rules" icon="list" title={t('settings.scope.fileRules')} subtitle={t('settings.scope.fileRulesHelp')}>
        <FileRulesSettings bind:options={draft.scan_options} />
        <div><button type="button" class="btn btn-quiet btn-sm" onclick={resetRules}><Icon name="undo" size={14} /> {t('settings.sectionDefaults')}</button></div>
      </Disclosure>

      {#if isCustom}
        <Disclosure id="custom-endpoint" icon="sliders" title={t('settings.endpoint.title')} subtitle={t('settings.endpoint.help')} open forceOpen={baseUrlInvalid}>
          <div class="fields two">
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
          </div>
        </Disclosure>
      {/if}

      <Disclosure id="settings-management" icon="upload" title={t('settings.manage')} subtitle={t('settings.manageHelp')}>
        <div class="actions">
          <input type="file" accept="application/json,.json,.py" bind:this={importInput} onchange={importDraft} hidden />
          <button type="button" class="btn btn-secondary" disabled={!!app.busy || importingSettings} onclick={() => importInput.click()}>{t('settings.import.action')}</button>
          <button type="button" class="btn btn-secondary" disabled={!!app.busy} onclick={exportDraft}>{t('settings.export')}</button>
          <button type="button" class="btn btn-quiet" disabled={!!app.busy} onclick={resetDraft}>{t('settings.resetDraft')}</button>
        </div>
        <p class="hint">{t('settings.import.help')}</p>
      </Disclosure>
    </div>

    <!-- 앱: instant-apply items, updates, data, reset. Nothing here goes through the save bar. -->
    <div class="panel" role="tabpanel" id="settings-panel-app" aria-labelledby="settings-tab-app" hidden={tab !== 'app'}>
      <Disclosure id="application-settings" icon="monitor" title={t('settings.app.title')} subtitle={t('settings.app.subtitle')} open>
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
              <option value="zh">{t('lang.zh')}</option>
            </select>
            <span id="ui-language-help" class="hint">{t('settings.app.languageHelp')}</span>
          </div>
        </div>
        <label class="check">
          <input type="checkbox" checked={app.prefs.notify_on_finish} onchange={(event) => app.setPrefs({ notify_on_finish: event.currentTarget.checked })} />
          <span><strong>{t('settings.app.notifyOnFinish')}</strong><small>{t('settings.app.notifyOnFinishHelp')}</small></span>
        </label>
      </Disclosure>

      <AppMaintenance />
    </div>
    </fieldset>

    {#if showSaveBar}
      <footer class="save-bar" class:dirty={dirty || incomplete} bind:clientHeight={saveBarHeight}>
        <div class="save-status" role="status" aria-live="polite">
          <strong>{#if app.busy === 'settings'}{t('settings.saving')}
            {:else if dirty && pendingTabs.length}{t('settings.pending', { tabs: tabNames(pendingTabs), count: pendingTabs.reduce((sum, name) => sum + pending[name], 0) })}
            {:else if dirty}{t('settings.dirty')}
            {:else if incomplete}{t('settings.incomplete')}
            {:else}{t('settings.savedState')}{/if}</strong>
          {#if (dirty || incomplete) && hasBlockingError}<span class="field-error">{errorTabs.length ? t('settings.fixErrorsIn', { tabs: tabNames(errorTabs) }) : t('settings.fixErrors')}</span>{/if}
        </div>
        <div class="save-buttons">
        {#if app.returnStep && !dirty && !incomplete}
          <!-- Settings were opened to fix something a step needs: once saved, the way back is the next move. -->
          <button type="button" class="btn btn-primary" disabled={!!app.busy} onclick={() => app.returnFromSettings()}>
            <Icon name="chevron-left" size={15} /> {t('settings.returnTo', { step: t(`step.${app.returnStep}` as MessageKey) })}
          </button>
        {:else}
        <button type="button" class="btn btn-secondary" disabled={!!app.busy || (!dirty && !incomplete)} onclick={discardDraft}>{t('settings.discard')}</button>
        <button type="submit" class="btn btn-primary" disabled={!!app.busy || hasBlockingError || !dirty}>
          <Icon name="check" size={15} /> {t(app.busy === 'settings' ? 'settings.saving' : app.returnStep ? 'settings.saveReturn' : 'common.save')}
        </button>
        {/if}
        </div>
      </footer>
    {/if}
  </form>
</div>

{#if app.pendingLeave}
  <Dialog
    title={t(app.pendingCloseSource ? 'settings.close.title' : 'settings.leave.title')}
    hideClose
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
  .settings-form > fieldset { display: grid; min-width: 0; margin: 0; padding: 0; border: 0; max-width: 920px; }
  .settings-form > fieldset :global(input), .settings-form > fieldset :global(select), .settings-form > fieldset :global(textarea), .settings-form > fieldset :global(button), .settings-form > fieldset :global(summary) { scroll-margin-block-end: calc(var(--settings-save-height) + var(--space-4)); }
  .tabs { display: flex; gap: var(--space-1); max-width: 920px; overflow-x: auto; border-block-end: 1px solid var(--border); }
  .tab { background: none; border: 0; position: relative; display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 var(--space-4); border-radius: var(--radius-md) var(--radius-md) 0 0; color: var(--text-secondary); font-size: var(--text-md); font-weight: 600; white-space: nowrap; }
  .tab[aria-selected='true'] { color: var(--accent-text); }
  .tab[aria-selected='true']::after { content: ''; position: absolute; inset-inline: var(--space-2); inset-block-end: -1px; height: 2px; border-radius: 2px; background: var(--accent); }
  .tab.invalid:not([aria-selected='true']) { color: var(--danger-text); }
  .tab:focus-visible { outline-offset: -2px; }
  @media (hover: hover) { .tab:hover { color: var(--text); background: var(--bg-hover); } }
  .dot { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: var(--radius-full); background: var(--accent); color: var(--text-on-accent); font-size: var(--text-xs); font-weight: 700; }
  .panel { display: grid; gap: var(--space-4); min-width: 0; }
  .panel[hidden] { display: none; }
  .fields { display: grid; gap: var(--space-4); min-width: 0; }
  .fields.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .fields.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .field { display: grid; gap: var(--space-2); min-width: 0; align-content: start; }
  .field.full, .full { grid-column: 1 / -1; }
  .label { color: var(--text); font-size: var(--text-md); font-weight: 600; }
  .label-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
  .optional { color: var(--text-secondary); font-size: var(--text-xs); font-weight: 400; }
  .hint { color: var(--text-secondary); font-size: var(--text-xs); line-height: 1.45; margin: 0; }
  .ok { display: inline-flex; align-items: center; gap: 4px; color: var(--success-text); font-weight: 600; }
  .linklike { background: none; border: 0; padding: 0; min-height: 0; cursor: pointer; color: var(--accent-text); text-decoration: underline; font-size: inherit; }
  .input, .select, .textarea { min-width: 0; }
  .input.invalid { border-color: var(--danger-solid); box-shadow: 0 0 0 2px color-mix(in srgb, var(--danger-solid) 18%, transparent); }
  .field-error { color: var(--danger-text); font-size: var(--text-xs); line-height: 1.4; margin: 0; }
  .secret-input { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2); min-width: 0; }
  .secret-input .btn { min-height: var(--control-height); }
  .key-status { border-block-start: 1px solid var(--border); padding-block-start: var(--space-4); }
  .key-cancel { justify-self: start; }
  .model-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  .usage-panel { display: grid; gap: var(--space-2); justify-items: start; }
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
  /* A window footer, only there while there is something to save (or a way back to the step that needs it). */
  .save-bar { position: sticky; inset-block-end: calc(-1 * var(--pane-pad-bottom, 0px)); z-index: 15; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-3);
    margin: 0 calc(-1 * var(--pane-pad-x, 0px)) calc(-1 * var(--pane-pad-bottom, 0px)); padding: 10px var(--pane-pad-x, var(--space-4));
    border-top: 1px solid var(--border); background: var(--bg-toolbar); backdrop-filter: saturate(1.6) blur(16px); -webkit-backdrop-filter: saturate(1.6) blur(16px); }
  .save-bar.dirty { background: color-mix(in srgb, var(--accent-soft) 85%, transparent); border-top-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
  .save-status { display: grid; gap: var(--space-1); font-size: var(--text-sm); color: var(--text-secondary); }
  .save-bar.dirty .save-status { color: var(--accent-soft-text); }
  .cross-tab-pending { margin: -4px 0 0; color: var(--text-secondary); font-size: var(--text-xs); }
  .save-buttons { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .check { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: var(--space-2); padding: 10px var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-lg); }
  .check input { width: 16px; height: 16px; margin: 1px 0 0; accent-color: var(--accent); }
  .check span { display: grid; gap: var(--space-1); min-width: 0; }
  .check strong { font-size: var(--text-sm); }
  .check small { color: var(--text-secondary); font-size: var(--text-xs); font-weight: 400; }
  .checks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
  :global(.dialog) .leave-stay { margin-inline-end: auto; }
  .actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-3); }
  @media (max-width: 760px) {
    .fields.two, .fields.three, .checks { grid-template-columns: 1fr; }
    .field.full, .full { grid-column: auto; }
  }
  @media (max-width: 420px) {
    .actions { display: grid; grid-template-columns: 1fr; }
    .save-bar { padding: var(--space-3); }
    .save-buttons { width: 100%; }
    .save-buttons .btn { flex: 1; }
  }
</style>
