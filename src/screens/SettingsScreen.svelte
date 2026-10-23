<script lang="ts">
  import { tick, untrack } from 'svelte';
  import Dialog from '../components/Dialog.svelte';
  import AppMaintenance from '../components/AppMaintenance.svelte';
  import Callout from '../components/Callout.svelte';
  import Icon from '../components/Icon.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import SettingsHint from '../components/SettingsHint.svelte';
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
  import CredentialStoreNotice from '../components/CredentialStoreNotice.svelte';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import { formatUsd } from '../lib/format';
  import { RECOMMENDED_MODELS, perMillion } from '../lib/recommended-models';
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
  let importInput: HTMLInputElement | undefined = $state();
  let importingSettings = $state(false);
  let overridesInvalid = $state(false);
  let packInvalid = $state(false);
  let usageSnapshots = $state<ProviderUsage[]>([]);
  let usageError = $state('');
  let modelError = $state('');
  let modelErrorSelection = $state('');
  let lastAutoLookup = '';
  let saveBarHeight = $state(0);
  let autoListing = $state(false);

  // Two parts. "Translation" is what a translation run needs and is committed with the save bar; "App" is the
  // application's own settings, which apply the moment they are changed. The Help menu's update check opens
  // the app part; everything else (the menu, "change model", a credential error) opens translation.
  type SettingsTab = 'translation' | 'app';
  const tabs: { key: SettingsTab; label: MessageKey }[] = [
    { key: 'translation', label: 'settings.tab.translation' },
    { key: 'app', label: 'settings.tab.app' }
  ];
  let tab = $state<SettingsTab>(app.helpSection === 'updates' ? 'app' : 'translation');
  // The part the person asked for while the translation draft has unsaved changes (answered in the dialog).
  let pendingTab = $state<SettingsTab | null>(null);

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

  // The banner's "Enter the key" lands here: open the key field of the Custom provider and focus it.
  $effect(() => {
    if (!app.focusKeyField) return;
    app.focusKeyField = false;
    if (untrack(() => tab) !== 'translation') void showTab('translation', false);
    if (draft.provider !== 'custom') return;
    editingKey = true;
    void tick().then(() => {
      const field = document.getElementById('api-key');
      field?.scrollIntoView({ block: 'center' });
      field?.focus();
    });
  });
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
  // The provider's own price for the chosen model, when the list carries one (per million tokens).
  const modelPrice = $derived.by(() => {
    const input = perMillion(reasoningModel?.pricing_prompt);
    const output = perMillion(reasoningModel?.pricing_completion);
    if (input === null || output === null) return '';
    return t('settings.model.price', { input: formatUsd(input, app.locale), output: formatUsd(output, app.locale) });
  });
  // Without a model list (no key yet, or the lookup failed) a short, dated suggestion beats an empty box.
  const recommended = $derived(RECOMMENDED_MODELS[draft.provider]);
  const selectionKey = $derived(`${draft.provider}:${draft.model.trim()}`);
  const visibleModelError = $derived(modelErrorSelection === selectionKey ? modelError : '');

  // Only public metadata auto-loads. No key/keychain read and no preference write.
  $effect(() => {
    const key = selectionKey;
    if (!app.ready || draft.provider !== 'openrouter' || !draft.model.trim() || app.isBusy || lastAutoLookup === key) return;
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
        app.credentialStoreError = status.error ?? null;
        // A store that cannot be opened is "unknown", never "no key saved".
        credentialState = status.error ? null : (status.stored ?? false);
        if (status.mode) {
          credentialMode = status.mode;
          savedCredentialMode = status.mode;
        }
        // This is only a boolean status. The key itself is never read from the store.
        if (app.settings.provider === provider && !status.error) app.apiKeyStored = status.stored ?? false;
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

  // A key that was just saved is the first moment the provider's model list can be read, so it is read once,
  // without the person having to find the button. Only the saved key is used, and a failure blocks nothing.
  async function saveAndList(): Promise<boolean> {
    const hadKey = !!apiKey.trim();
    const saved = await saveSettings();
    if (saved && hadKey && draft.provider !== 'openrouter') void loadModels(true, true);
    return saved;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    // Nothing to save means no save bar; an Enter key must not write the settings anyway.
    if (!dirty || tab !== 'translation') return;
    if (await saveAndList()) {
      if (app.returnStep) app.returnFromSettings();
      else void focusNav();
    }
  }

  // The save bar disappears with the last change. Focus must not fall to the page, so it goes to the
  // section list, which stays on screen.
  async function focusNav(): Promise<void> {
    await tick();
    const target = navEl?.querySelector<HTMLElement>('a[aria-current="true"]') ?? navEl?.querySelector<HTMLElement>('a');
    target?.focus({ preventScroll: true });
  }

  function discardChanges(): void {
    discardDraft();
    void focusNav();
  }

  // Leaving with unsaved changes asks first (AppState holds the move until it is answered).
  $effect(() => { app.settingsDirty = dirty; });
  // The save bar appears with the first change and covers the bottom of the pane. A field being edited
  // down there is brought back above it.
  $effect(() => {
    if (!dirty) return;
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest('.settings-form')) active.scrollIntoView({ block: 'nearest' });
    }));
    return () => cancelAnimationFrame(frame);
  });
  // "Save and quit" in the exit dialog saves this draft.
  $effect(() => {
    app.saveDraft = saveSettings;
    return () => { app.saveDraft = null; };
  });
  $effect(() => () => {
    app.settingsDirty = false;
    app.pendingLeave = null;
  });

  // One dialog guards both ways out of unsaved translation settings: another page (AppState holds that
  // move) and the "App" part of this page.
  async function saveAndLeave(): Promise<void> {
    const saved = await saveAndList();
    if (pendingTab) { if (saved) void showTab(pendingTab, true); }
    else app.resolveLeave(saved);
  }

  function leaveWithoutSaving(): void {
    discardDraft();
    if (pendingTab) void showTab(pendingTab, true);
    else app.resolveLeave(true);
  }

  function stayHere(): void {
    if (pendingTab) {
      pendingTab = null;
      if (app.helpSection === 'updates') app.helpSection = '';
    } else app.resolveLeave(false);
  }

  function selectTab(next: SettingsTab): void {
    if (next === tab || pendingTab === next) return;
    if (tab === 'translation' && dirty) { pendingTab = next; return; }
    void showTab(next, false);
  }

  async function showTab(next: SettingsTab, focus: boolean): Promise<void> {
    tab = next;
    pendingTab = null;
    current = sections.find((section) => section.tab === next)!.key;
    pinned = null;
    await tick();
    paneEl?.scrollTo({ top: 0 });
    if (focus) document.getElementById(`settings-tab-${next}`)?.focus();
  }

  function tabKeys(event: KeyboardEvent): void {
    const at = tabs.findIndex((item) => item.key === (event.target as HTMLElement).dataset.tab);
    if (at < 0) return;
    const to = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (at + 1) % tabs.length
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (at + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (to < 0) return;
    event.preventDefault();
    const next = tabs[to].key;
    // With changes to answer for, the dialog opens and focus stays on the tab it is returned to.
    if (tab === 'translation' && dirty && next !== tab) pendingTab = next;
    else void showTab(next, true);
  }

  // The Help menu's "Check for Updates…" arrives while this page may already be open.
  $effect(() => {
    if (app.helpSection !== 'updates') return;
    untrack(() => selectTab('app'));
  });

  async function changeLanguage(select: HTMLSelectElement): Promise<void> {
    const locale = select.value as 'ko' | 'en' | 'ja';
    if (await app.setUiLanguage(locale)) {
      draft.ui_language = locale;
      if (snapshot) snapshot.ui_language = locale;
    } else {
      select.value = draft.ui_language ?? 'ko';
    }
  }

  async function loadModels(force = true, auto = false): Promise<void> {
    // A running scan or translation holds the core; the list would only queue behind it.
    if (!snapshot || app.isBusy || app.busy === 'settings' || baseUrlInvalid) return;
    const selection = copySettings(draft);
    const key = selectionKey;
    if (selection.provider !== 'openrouter' && (!stored || apiKey.trim())) {
      modelError = t('settings.model.saveKeyFirst');
      modelErrorSelection = key;
      return;
    }
    modelError = '';
    autoListing = auto;
    try {
      await app.loadModels(selection, force);
    } catch {
      modelError = t('settings.model.failed');
      modelErrorSelection = key;
    } finally { autoListing = false; }
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
      const status = await importCredential(draft.provider, draft.provider === 'custom' ? draft.base_url : undefined);
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

  // The section list: it follows the scroll (aria-current marks where the reader is) and moves the
  // page when used. The ids that menu commands and tests rely on stay on the sections themselves.
  const sections = [
    { key: 'provider', tab: 'translation', id: 'provider-settings', label: 'settings.nav.provider' },
    { key: 'translation', tab: 'translation', id: 'translation-settings', label: 'settings.nav.translation' },
    { key: 'scope', tab: 'translation', id: 'scope-section', label: 'settings.nav.scope' },
    { key: 'speed', tab: 'translation', id: 'speed-settings', label: 'settings.nav.speed' },
    { key: 'manage', tab: 'translation', id: 'manage-section', label: 'settings.nav.manage' },
    { key: 'app', tab: 'app', id: 'application-settings', label: 'settings.nav.app' },
    { key: 'updates', tab: 'app', id: 'updates', label: 'settings.nav.updates' },
    { key: 'data', tab: 'app', id: 'data-settings', label: 'settings.nav.data' },
    { key: 'reset', tab: 'app', id: 'reset-section', label: 'settings.nav.reset' }
  ] as const satisfies readonly { key: string; tab: SettingsTab; id: string; label: MessageKey }[];
  type SectionKey = (typeof sections)[number]['key'];
  // The sections of the part on screen: the list beside the page names only those.
  const tabSections = $derived(sections.filter((section) => section.tab === tab));

  let navEl: HTMLElement | undefined = $state();
  let current = $state<SectionKey>(sections.find((section) => section.tab === tab)!.key);
  let wide = $state(typeof matchMedia === 'function' && matchMedia('(min-width: 900px)').matches);
  let spyLocked = false;
  let spyTimer: ReturnType<typeof setTimeout> | undefined;
  let paneEl: HTMLElement | undefined;
  // Where the last click ended: until the reader scrolls on from there, that entry stays marked, even
  // when it is a short section at the end of the page that can never reach the top.
  let pinned: { key: SectionKey; top: number } | null = null;
  const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Which section the reader is in: the last one whose top has passed a line a little below the top
  // of the pane. At the very bottom the last section wins, since a short one can never reach the line.
  function sectionInView(scroller: HTMLElement): SectionKey {
    const stripHeight = !wide && navEl?.parentElement ? navEl.parentElement.offsetHeight : 0;
    const line = scroller.getBoundingClientRect().top + stripHeight + Math.min(96, scroller.clientHeight * 0.25);
    const list = tabSections;
    let found: SectionKey = list[0].key;
    for (const section of list) {
      const element = document.getElementById(section.id);
      if (element && element.getBoundingClientRect().top <= line) found = section.key;
    }
    if (scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) found = list[list.length - 1].key;
    return found;
  }

  $effect(() => {
    const scroller = navEl?.closest('main') as HTMLElement | null | undefined;
    if (!scroller) return;
    let frame = 0;
    paneEl = scroller;
    const update = () => {
      frame = 0;
      if (spyLocked) return;
      if (pinned && Math.abs(scroller.scrollTop - pinned.top) < 4) { current = pinned.key; return; }
      pinned = null;
      current = sectionInView(scroller);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const media = matchMedia('(min-width: 900px)');
    const onMedia = () => { wide = media.matches; schedule(); };
    scroller.addEventListener('scroll', schedule, { passive: true });
    scroller.addEventListener('scrollend', settleSpy);
    media.addEventListener('change', onMedia);
    window.addEventListener('resize', schedule);
    update();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      clearTimeout(spyTimer);
      scroller.removeEventListener('scroll', schedule);
      scroller.removeEventListener('scrollend', settleSpy);
      paneEl = undefined;
      media.removeEventListener('change', onMedia);
      window.removeEventListener('resize', schedule);
    };
  });

  // In the compact strip the current entry is kept in view, so the strip itself never hides it.
  $effect(() => {
    void current;
    if (wide || !navEl) return;
    const link = navEl.querySelector<HTMLElement>('a[aria-current="true"]');
    if (!link) return;
    const left = link.offsetLeft - (navEl.clientWidth - link.offsetWidth) / 2;
    navEl.scrollTo({ left: Math.max(0, left), behavior: reducedMotion() ? 'auto' : 'smooth' });
  });

  // The move a click started has ended: remember where, and let the scroll position drive the highlight again.
  function settleSpy(): void {
    clearTimeout(spyTimer);
    if (!spyLocked || !paneEl) return;
    spyLocked = false;
    pinned = { key: current, top: paneEl.scrollTop };
  }

  function goToSection(event: MouseEvent, section: (typeof sections)[number]): void {
    event.preventDefault();
    const element = document.getElementById(section.id);
    if (!element) return;
    current = section.key;
    // The scroll that follows must not hand the highlight back to the section it passes.
    spyLocked = true;
    pinned = null;
    clearTimeout(spyTimer);
    spyTimer = setTimeout(settleSpy, reducedMotion() ? 80 : 1000);
    // A collapsed section is opened, since opening it is why it was chosen.
    if (section.key === 'scope' || section.key === 'speed') element.querySelector('details')?.setAttribute('open', '');
    element.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    element.focus({ preventScroll: true });
  }
</script>

<div class="page settings" style:--settings-save-height={`${dirty && tab === 'translation' ? saveBarHeight : 0}px`}>
  <PageHeader title={t('settings.title')} lead={t('settings.lead')}>
    {#snippet actions()}
      {#if app.returnStep && !(dirty && tab === 'translation')}
        <!-- Settings were opened to fix something a step needs: with nothing to save, the way back is the next move. -->
        <button type="button" class="btn btn-secondary" disabled={!!app.busy} onclick={() => app.returnFromSettings()}>
          <Icon name="chevron-left" size={15} /> {t('settings.returnTo', { step: t(`step.${app.returnStep}` as MessageKey) })}
        </button>
      {/if}
      <!-- Always present, so a change of state is announced; the save bar itself only exists while there is something to save. -->
      <span class="state" class:dirty={dirty && tab === 'translation'} role="status" aria-live="polite">
        {#if tab === 'app'}<Icon name="check" size={14} />{t('settings.tab.appStatus')}
        {:else if app.busy === 'settings'}{t('settings.saving')}
        {:else if dirty}<span class="state-dot" aria-hidden="true"></span>{t('settings.dirty')}
        {:else}<Icon name="check" size={14} />{t('settings.savedState')}{/if}
      </span>
    {/snippet}
  </PageHeader>

  <div class="layout">
    <div class="nav-column">
      <!-- Arrow keys move between the two parts and select as they go; with unsaved changes the dialog answers first. -->
      <div class="tabs" role="tablist" aria-label={t('settings.tab.label')} tabindex="-1" onkeydown={tabKeys}>
        {#each tabs as item (item.key)}
          <button type="button" role="tab" class="tab" id={`settings-tab-${item.key}`} data-tab={item.key}
            aria-selected={tab === item.key} aria-controls={tab === item.key ? `settings-panel-${item.key}` : undefined}
            tabindex={tab === item.key ? 0 : -1} onclick={() => selectTab(item.key)}>{t(item.label)}</button>
        {/each}
      </div>
      <nav class="section-nav" aria-label={t('settings.nav.label')} bind:this={navEl}>
        <ul>
          {#each tabSections as section (section.key)}
            <li><a href={`#${section.id}`} aria-current={current === section.key ? 'true' : undefined} onclick={(event) => goToSection(event, section)}>{t(section.label)}</a></li>
          {/each}
        </ul>
      </nav>
    </div>

  <form class="settings-form" id="settings-form" onsubmit={submit} novalidate>
    <fieldset disabled={!!app.busy} aria-busy={app.busy === 'settings'}>
    {#if tab === 'translation'}
    <div class="panel" role="tabpanel" id="settings-panel-translation" aria-labelledby="settings-tab-translation">
    <p class="panel-lead">{t('settings.tab.translationLead')}</p>
    <section class="card settings-section" id="provider-settings" tabindex="-1" aria-labelledby="provider-title">
      <div class="section-head">
        <div class="section-icon" aria-hidden="true"><Icon name="shield" size={18} /></div>
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
            <button type="button" class="btn btn-secondary btn-sm" disabled={!!app.busy || baseUrlInvalid || app.modelsLoading} onclick={() => loadModels(true)}>
              <Icon name="refresh" size={15} /> {t(app.modelsLoading ? 'settings.model.listing' : 'settings.model.refresh')}
            </button>
            {#if draft.provider === 'openrouter'}<span class="hint">{t('settings.model.public')}</span>{/if}
          </div>
          <div class="hint" role="status" aria-live="polite">
            {#if visibleModelError}<span class="field-error">{visibleModelError}</span>
            {:else if app.modelsLoading}{t(autoListing ? 'settings.model.autoListing' : 'settings.model.listing')}
            {:else if reasoningModel?.unsuitable_reason}<span class="model-warning"><Icon name="alert-triangle" size={14} />{t('settings.model.unsuitable')}</span>
            {:else if draft.model.trim() && models.length && !reasoningModel}<span class="model-warning"><Icon name="alert-triangle" size={14} />{t('settings.model.notFound')}</span>
            {:else if reasoningModel}{t('settings.model.verified')}{#if app.modelsCached} · {t('settings.model.cached')}{/if}
            {:else if draft.provider !== 'openrouter' && stored === false && !models.length}{t('settings.model.needKey')}{/if}
          </div>
          {#if modelPrice}<p class="hint num">{modelPrice}</p>{/if}
          {#if !models.length && recommended}
            <div class="recommended">
              <span class="hint">{t('settings.model.recommended', { date: recommended.asOf, source: t(recommended.source) })}</span>
              <span class="chips">
                {#each recommended.models as id (id)}
                  <button type="button" class="btn btn-quiet btn-sm" onclick={() => (draft.model = id)}>{id}</button>
                {/each}
              </span>
            </div>
          {/if}
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
          <!-- A key an older version saved is tied to no address, so it is never sent. The key itself is never shown. -->
          {#if isCustom && app.keyReentry}
            <Callout tone="warning" title={t('settings.apiKey.reenterTitle')} role="status">{t('settings.apiKey.reenterBody')}</Callout>
          {/if}
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
              <SettingsHint text={t('settings.apiKey.help')} />
              {#if stored}<button type="button" class="btn btn-quiet btn-sm key-cancel" onclick={() => { editingKey = false; apiKey = ''; showApiKey = false; }}>{t('settings.apiKey.cancelChange')}</button>{/if}
            </div>
          {/if}
          {#if credentialError}<p class="field-error" role="alert">{credentialError}</p>{/if}
        </div>
        <CredentialStoreNotice />
        <details class="field full key-management" id="key-management">
          <summary>{t('settings.vault.manage')}</summary>
          <div class="field">
          <label class="label" for="credential-mode">{t('settings.vault.mode')}</label>
          <select id="credential-mode" class="select" bind:value={credentialMode}>
            <option value="local">{t('settings.vault.local')}</option>
            <option value="session">{t('settings.vault.session')}</option>
            <option value="keychain">{t('settings.vault.keychain')}</option>
          </select>
          <SettingsHint text={t('settings.vault.help')} />
          </div>
          <!-- In Keychain mode the key already is the keychain entry: there is nothing to copy. -->
          {#if savedCredentialMode !== 'keychain'}
            <div class="field import-key">
              <div><button type="button" class="btn btn-secondary" disabled={importing || !!app.busy} onclick={importExisting}>{importing ? t('common.loading') : t('settings.vault.import')}</button></div>
              <SettingsHint text={t('settings.vault.importHelp')} />
            </div>
          {/if}
        </details>
      </div>
      {#if draft.provider === 'openrouter'}
        <div class="usage-panel">
          <button type="button" class="btn btn-secondary" disabled={!!app.busy || !stored || !!apiKey.trim()} onclick={checkUsage}>{app.busy === 'usage' ? t('common.loading') : t('settings.usage.check')}</button>
          <SettingsHint text={t('settings.usage.help')} />
          {#if usageError}<p class="field-error" role="alert">{usageError}</p>{/if}
          <div role="status" aria-live="polite">
            {#each usageSnapshots as usage}
              <p class="hint">{new Date(usage.checkedAt).toLocaleString()} · {t('settings.usage.total')}: {usage.usage.toFixed(6)}{usage.byokUsage !== null ? ` · BYOK: ${usage.byokUsage.toFixed(6)}` : ''}</p>
            {/each}
          </div>
        </div>
      {/if}
    </section>

    <section class="card settings-section" id="translation-settings" tabindex="-1" aria-labelledby="translation-title">
      <div class="section-head">
        <div class="section-icon" aria-hidden="true"><Icon name="language" size={18} /></div>
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
          <SettingsHint text={t('settings.styleAssist.help')} />
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

    <section class="card settings-section" id="scope-section" tabindex="-1" aria-labelledby="scope-title">
      <details class="advanced" id="scope-settings">
      <summary>
        <span class="section-head compact">
          <span class="section-icon" aria-hidden="true"><Icon name="search" size={18} /></span>
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

    <section class="card settings-section" id="speed-settings" tabindex="-1" aria-labelledby="performance-title">
        <details class="advanced" open={hasRangeError}>
        <summary>
          <span class="section-head compact">
            <span class="section-icon" aria-hidden="true"><Icon name="clock" size={18} /></span>
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

    <section class="card settings-section" id="manage-section" tabindex="-1" aria-labelledby="manage-title">
      <details class="advanced" id="settings-management">
        <summary>
          <span class="section-head compact">
            <span class="section-icon" aria-hidden="true"><Icon name="archive" size={18} /></span>
            <span><strong id="manage-title">{t('settings.manage')}</strong></span>
          </span>
          <Icon name="chevron-down" size={18} />
        </summary>
        <div class="manage-body">
          <div class="actions">
            <input type="file" accept="application/json,.json,.py" bind:this={importInput} onchange={importDraft} hidden />
            <button type="button" class="btn btn-secondary" disabled={!!app.busy || importingSettings} onclick={() => importInput?.click()}>{t('settings.import.action')}</button>
            <button type="button" class="btn btn-secondary" disabled={!!app.busy} onclick={exportDraft}>{t('settings.export')}</button>
            <button type="button" class="btn btn-quiet" disabled={!!app.busy} onclick={resetDraft}>{t('settings.resetDraft')}</button>
          </div>
          <SettingsHint text={t('settings.import.help')} />
        </div>
      </details>
    </section>

    </div>
    {:else}
    <div class="panel" role="tabpanel" id="settings-panel-app" aria-labelledby="settings-tab-app">
    <p class="panel-lead">{t('settings.tab.appLead')}</p>
    <section class="card settings-section" id="application-settings" tabindex="-1" aria-labelledby="app-title">
      <div class="section-head">
        <span class="section-icon" aria-hidden="true"><Icon name="sliders" size={18} /></span>
        <div><h2 id="app-title">{t('settings.app.title')}</h2><p>{t('settings.app.subtitle')}</p></div>
      </div>
      <!-- The mode applies the moment it is picked, like the system's own appearance setting. -->
      <fieldset class="appearance" aria-describedby="theme-help">
        <legend class="label">{t('settings.app.appearance')}</legend>
        <div class="theme-options">
          {#each themes as theme (theme.value)}
            <label class="theme-option" class:selected={app.theme === theme.value}>
              <input type="radio" name="theme" value={theme.value} checked={app.theme === theme.value} onchange={() => app.setTheme(theme.value)} />
              <span class="preview {theme.value}" aria-hidden="true">
                <!-- Fixed colours on purpose: each tile shows its mode whatever the current one is. "System" is split along a diagonal. -->
                {#if theme.value !== 'dark'}<span class="mini light"><span class="side"></span><span class="body"><span class="line accent"></span><span class="line"></span><span class="line short"></span></span></span>{/if}
                {#if theme.value !== 'light'}<span class="mini dark"><span class="side"></span><span class="body"><span class="line accent"></span><span class="line"></span><span class="line short"></span></span></span>{/if}
              </span>
              <span class="name">{#if app.theme === theme.value}<Icon name="check" size={13} />{/if}{t(theme.short)}</span>
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
        {#if app.notificationsSupported}
          <div class="field">
            <label class="check">
              <input type="checkbox" checked={app.prefs.notify_on_finish !== false} onchange={(event) => app.setNotifyOnFinish(event.currentTarget.checked)} />
              <span class="label">{t('settings.notify.label')}</span>
            </label>
            <span class="hint">{t('settings.notify.help')}</span>
          </div>
        {/if}
      </div>
    </section>

    <AppMaintenance />
    </div>
    {/if}
    </fieldset>
  </form>
  </div>

  <!-- Only while there is something to save: a disabled Save button on a clean page says nothing. -->
  {#if dirty && tab === 'translation'}
    <div class="action-bar" bind:clientHeight={saveBarHeight}>
      <div class="note">
        <span>{t('settings.barHint')}</span>
        {#if hasBlockingError}<span class="field-error" role="alert">{t('settings.fixErrors')}</span>{/if}
      </div>
      <div class="buttons">
        <button type="button" class="btn btn-secondary" disabled={!!app.busy} onclick={discardChanges}>{t('settings.discard')}</button>
        <button type="submit" form="settings-form" class="btn btn-primary" disabled={!!app.busy || hasBlockingError}>
          <Icon name="check" size={15} /> {t(app.busy === 'settings' ? 'settings.saving' : app.returnStep ? 'settings.saveReturn' : 'common.save')}
        </button>
      </div>
    </div>
  {/if}
</div>

{#if app.pendingLeave || pendingTab}
  <Dialog showClose={false} title={t('settings.leave.title')} onClose={stayHere}>
    <p>{t('settings.leave.body')}</p>
    {#if hasBlockingError}<p class="field-error" role="alert">{t('settings.fixErrors')}</p>{/if}
    {#snippet actions()}
      <button type="button" class="btn btn-quiet leave-stay" disabled={!!app.busy} onclick={stayHere}>{t('settings.leave.stay')}</button>
      <button type="button" class="btn btn-secondary" disabled={!!app.busy} onclick={leaveWithoutSaving}>{t('settings.leave.discard')}</button>
      <button type="button" class="btn btn-primary" data-autofocus disabled={!!app.busy || hasBlockingError} onclick={saveAndLeave}>
        {t(app.busy === 'settings' ? 'settings.saving' : 'settings.leave.save')}
      </button>
    {/snippet}
  </Dialog>
{/if}

{#if showStyleConfirm}
  <Dialog showClose={false} title={t('settings.styleAssist.title')} onClose={() => (showStyleConfirm = false)}>
    <p>{t('settings.styleAssist.confirm')}</p>
    <p><strong>{providerName(draft.provider)} · {draft.model}</strong></p>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" onclick={() => (showStyleConfirm = false)}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-primary" onclick={enhanceStyle}>{t('settings.styleAssist.action')}</button>
    {/snippet}
  </Dialog>
{/if}

{#if showDeleteConfirm}
  <Dialog showClose={false} title={t('settings.apiKey.deleteTitle', { provider: providerName(draft.provider) })} onClose={() => (showDeleteConfirm = false)}>
    <p>{t('settings.apiKey.deleteBody')}</p>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" onclick={() => (showDeleteConfirm = false)}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-danger-solid" onclick={deleteApiKey}>{t('settings.apiKey.delete')}</button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .recommended { display: grid; gap: var(--space-1); }
  .recommended .chips { display: flex; flex-wrap: wrap; gap: var(--space-1); }

  /* Header status: always there, so a change of state is announced. */
  .state { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; color: var(--text-secondary); font-size: var(--text-sm); }
  .state :global(.icon) { color: var(--success-solid); }
  .state.dirty { color: var(--accent-soft-text); font-weight: 600; }
  .state-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; }

  /* Narrow window: the section list is a strip pinned under the toolbar. Wide: a column beside the sections.
     A sticky box measures from inside the pane's padding, so the pad is taken back out of its offset. */
  .settings { --pad-top: var(--space-5); }
  @media (max-width: 640px) { .settings { --pad-top: var(--space-4); } }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); align-items: start; min-width: 0; }
  /* The two parts and the sections of the one on screen share the pinned strip. */
  .nav-column {
    position: sticky; top: calc(-1 * var(--pad-top)); z-index: 12; min-width: 0; display: flex; align-items: center; gap: var(--space-3);
    margin-inline: calc(-1 * var(--pane-pad-x, 0px)); padding: 6px var(--pane-pad-x, 0px);
    background: var(--bg-toolbar); border-block-end: 1px solid var(--border);
    backdrop-filter: saturate(1.6) blur(16px); -webkit-backdrop-filter: saturate(1.6) blur(16px);
  }
  .tabs { flex: none; display: flex; gap: 2px; padding: 2px; border-radius: var(--radius-lg); background: var(--bg-sunken); border: 1px solid var(--border); }
  .tab {
    display: inline-flex; align-items: center; justify-content: center; flex: 1 1 auto; min-height: 30px; padding: 0 var(--space-3);
    border: 0; border-radius: var(--radius-md); background: transparent; color: var(--text-secondary);
    font-size: var(--text-sm); font-weight: 500; white-space: nowrap;
  }
  /* The chosen part is raised and bold, so it is not colour alone. */
  .tab[aria-selected='true'] { background: var(--bg-surface); color: var(--text); font-weight: 600; box-shadow: var(--shadow-control), 0 0 0 1px var(--border-strong); }
  @media (hover: hover) { .tab[aria-selected='false']:hover { color: var(--text); background: var(--bg-hover); } }
  .section-nav { flex: 1 1 auto; min-width: 0; overflow-x: auto; scrollbar-width: none; }
  .section-nav::-webkit-scrollbar { display: none; }
  .section-nav ul { list-style: none; margin: 0; padding: 0; display: flex; gap: 2px; width: max-content; }
  .section-nav a {
    position: relative; display: flex; align-items: center; min-height: 32px; padding: 0 var(--space-3); border-radius: var(--radius-md);
    color: var(--text-secondary); font-size: var(--text-sm); font-weight: 500; text-decoration: none; white-space: nowrap;
  }
  /* Where you are: a tinted entry plus a bar, so it is not colour alone. */
  .section-nav a[aria-current='true'] { background: var(--accent-soft); color: var(--accent-soft-text); font-weight: 600; }
  .section-nav a[aria-current='true']::after { content: ''; position: absolute; inset-inline: var(--space-3); inset-block-end: 0; height: 2px; border-radius: 2px; background: var(--accent); }
  @media (hover: hover) { .section-nav a:not([aria-current='true']):hover { background: var(--bg-hover); color: var(--text); } }
  @media (forced-colors: active) {
    .section-nav a[aria-current='true'] { text-decoration: underline; text-underline-offset: 4px; }
    .preview { forced-color-adjust: none; }
  }
  /* A window this short has no room to spare for a pinned strip. */
  @media (max-height: 520px) and (max-width: 899.98px) { .nav-column { position: static; margin-inline: 0; padding-inline: 0; } }

  @media (min-width: 900px) {
    .layout { grid-template-columns: clamp(152px, 17vw, 184px) minmax(0, 720px); column-gap: var(--space-6); }
    .nav-column {
      top: calc(var(--space-4) - var(--pad-top)); z-index: auto; flex-direction: column; align-items: stretch; gap: var(--space-3);
      margin: 0; padding: 0; background: none; border: 0; backdrop-filter: none; -webkit-backdrop-filter: none;
    }
    .section-nav { flex: none; overflow: visible; }
    .section-nav ul { flex-direction: column; width: auto; gap: 1px; }
    .section-nav a { padding: 0 var(--space-3); }
    .section-nav a[aria-current='true']::after { inset-inline: auto; inset-inline-start: 0; inset-block: 7px; width: 2px; height: auto; }
  }

  .panel { display: grid; gap: var(--space-4); min-width: 0; }
  .panel-lead { margin: 0; color: var(--text-secondary); font-size: var(--text-sm); line-height: 1.5; max-width: 64ch; }
  .model-warning { display: inline-flex; align-items: flex-start; gap: 6px; color: var(--warning-text); }
  .model-warning :global(.icon) { flex: none; margin-top: 3px; }
  .settings-form { min-width: 0; container-type: inline-size; container-name: settings-pane; }
  .settings-form > fieldset { display: grid; gap: var(--space-4); min-width: 0; margin: 0; padding: 0; border: 0; }
  .settings-form > fieldset :global(input), .settings-form > fieldset :global(select), .settings-form > fieldset :global(textarea), .settings-form > fieldset :global(button), .settings-form > fieldset :global(summary) { scroll-margin-block-end: calc(var(--settings-save-height) + var(--space-4)); }

  /* Section cards, shared with the update, data and reset cards in AppMaintenance. */
  .settings :global(.settings-section) { padding: var(--space-5); display: grid; gap: var(--space-4); min-width: 0; scroll-margin-block-start: 60px; }
  .settings :global(.section-head) { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: var(--space-3); min-width: 0; }
  .settings :global(.section-head.compact) { display: flex; align-items: center; }
  .settings :global(.section-head h2), .settings :global(.section-head strong) { display: block; font-size: var(--text-lg); font-weight: 600; line-height: 1.3; letter-spacing: -0.01em; }
  .settings :global(.section-head p), .settings :global(.section-head small) { display: block; max-width: 64ch; margin-top: 2px; color: var(--text-secondary); font-size: var(--text-sm); font-weight: 400; line-height: 1.5; }
  /* Neutral tiles: the glyph tells sections apart, not a coloured square. Only Reset is tinted. */
  .settings :global(.section-icon) { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: var(--radius-md); background: var(--bg-sunken); border: 1px solid var(--border); color: var(--text-secondary); }
  .settings :global(.section-icon.danger) { background: var(--danger-soft); border-color: var(--danger-border); color: var(--danger-text); }
  @media (min-width: 900px) { .settings :global(.settings-section) { scroll-margin-block-start: var(--space-4); } }

  .fields { display: grid; gap: var(--space-4); min-width: 0; }
  .fields.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .fields.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .field { display: grid; gap: var(--space-2); min-width: 0; align-content: start; }
  .field.full { grid-column: 1 / -1; }
  .label { color: var(--text); font-size: var(--text-md); font-weight: 600; }
  .label-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
  .optional { color: var(--text-secondary); font-size: var(--text-xs); font-weight: 400; }
  .hint { color: var(--text-secondary); line-height: 1.5; }
  .input, .select, .textarea { min-width: 0; }
  .input.invalid { border-color: var(--danger-solid); box-shadow: 0 0 0 2px color-mix(in srgb, var(--danger-solid) 18%, transparent); }
  .field-error { color: var(--danger-text); font-size: var(--text-sm); line-height: 1.4; }
  .secret-input { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2); min-width: 0; }
  .secret-input .btn { min-height: var(--control-height); }
  .key-status { border-block-start: 1px solid var(--border); padding-block-start: var(--space-4); }
  .key-cancel { justify-self: start; }
  .key-management { gap: var(--space-3); }
  .key-management summary { font-size: var(--text-sm); font-weight: 600; padding-block: var(--space-2); }
  .import-key { justify-items: start; }
  .usage-panel { display: grid; justify-items: start; gap: var(--space-2); border-block-start: 1px solid var(--border); padding-block-start: var(--space-4); }
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
  .theme-option .name { display: inline-flex; align-items: center; gap: 4px; font-size: var(--text-sm); font-weight: 500; }
  .theme-option.selected .name { font-weight: 600; color: var(--accent-text); }
  /* Miniature windows. Their colours are fixed on purpose: each tile shows its own mode whatever the current one is. */
  .preview { position: relative; display: block; width: 112px; height: 68px; border-radius: var(--radius-md); border: 1px solid var(--border-strong); overflow: hidden; }
  .mini { position: absolute; inset: 0; display: grid; grid-template-columns: 26px minmax(0, 1fr); background: var(--pv-bg); }
  .mini.light { --pv-bg: var(--neutral-50); --pv-side: var(--neutral-100); --pv-line: var(--neutral-300); --pv-accent: var(--blue-600); }
  .mini.dark { --pv-bg: #17181c; --pv-side: #121316; --pv-line: #3a3d46; --pv-accent: #3d7bff; }
  .mini .side { display: block; background: var(--pv-side); border-inline-end: 1px solid color-mix(in srgb, var(--pv-line) 45%, transparent); }
  .mini .body { display: grid; align-content: start; gap: 6px; padding: 12px 10px; }
  .mini .line { display: block; height: 6px; border-radius: 3px; background: var(--pv-line); }
  .mini .line.accent { width: 55%; background: var(--pv-accent); }
  .mini .line.short { width: 40%; }
  .preview.system .mini.dark { clip-path: polygon(100% 0, 100% 100%, 0 100%); }

  .action-bar > .note { display: grid; gap: 2px; }
  .check { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: var(--space-2); padding: 10px var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-lg); }
  .check input { width: 16px; height: 16px; margin: 1px 0 0; accent-color: var(--accent); }
  .check span { display: grid; gap: var(--space-1); min-width: 0; }
  .check strong { font-size: var(--text-md); font-weight: 600; }
  .check small { color: var(--text-secondary); font-size: var(--text-sm); font-weight: 400; line-height: 1.5; }
  .checks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
  .scope-body, .manage-body { display: grid; gap: var(--space-5); }
  .manage-body { gap: var(--space-3); }
  .advanced { display: grid; gap: var(--space-5); }
  /* A closed section is just its summary line: no gap waiting for content that is not shown. */
  .settings-form details:not([open]) { row-gap: 0; }
  :global(.dialog) .leave-stay { margin-inline-end: auto; }
  .advanced > summary { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); list-style: none; border-radius: var(--radius-md); }
  .advanced > summary::-webkit-details-marker { display: none; }
  .advanced > summary > :global(.icon) { color: var(--text-secondary); }
  .advanced[open] > summary > :global(.icon) { rotate: 180deg; }
  .actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-3); }

  /* The sections follow the width of their own column, not the window. */
  @container settings-pane (max-width: 640px) {
    .fields.three { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @container settings-pane (max-width: 520px) {
    .fields.two, .fields.three, .checks { grid-template-columns: 1fr; }
    .field.full { grid-column: auto; }
  }
  @media (max-width: 420px) {
    .settings :global(.settings-section) { padding: var(--space-4); }
    .settings :global(.section-head) { gap: var(--space-2); }
    .actions { display: grid; grid-template-columns: 1fr; }
    .action-bar > .note { flex-basis: 100%; }
    .action-bar > .buttons { width: 100%; }
    .action-bar > .buttons .btn { flex: 1; }
  }
</style>
