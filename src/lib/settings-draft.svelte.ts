import { untrack } from 'svelte';
import { app, defaultSettings } from './app.svelte';
import { callBackend, credentialStatus, importCredential, type CredentialMode, type ProviderUsage, type Settings } from './api';
import { exportDocument } from './document-export';
import { t, type MessageKey } from './i18n/index.svelte';
import { isSuitable } from './models';
import { PROVIDER_DEFAULTS } from './providers';
import {
  REASONING_PROVIDERS, reasoningMode, supportedEfforts, supportsReasoning
} from './reasoning';
import { copySettings, defaultScanOptions, publicSettingsForExport } from './settings';
import { isValidCustomEndpoint, parseSettingsImport } from './settings-import';
import { SETTINGS_TABS, pendingChanges, type PendingChanges, type SettingsTab } from './settings-tabs';

export type Connection = { status: 'idle' | 'checking' | 'ok' | 'error'; count: number; code: string };
const idle = (): Connection => ({ status: 'idle', count: 0, code: '' });

function inRange(value: unknown, minimum: number, maximum: number): boolean {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum;
}

function hasCatalogPrice(value: unknown): boolean {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return false;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0;
}

/**
 * Everything the settings screen edits before it is saved: the draft copy of the settings, the API
 * key being typed, the connection and credential checks, and every rule that says whether the draft
 * can be saved. The tabs only show and change it; the screen owns the save bar and the dialogs.
 */
export class SettingsDraft {
  draft = $state<Settings>(copySettings(app.settings));
  snapshot = $state<Settings | null>(null);
  apiKey = $state('');
  showApiKey = $state(false);
  editingKey = $state(false);
  showDeleteConfirm = $state(false);
  credentialProvider = $state('');
  credentialState = $state<boolean | null>(null);
  credentialLoading = $state(false);
  credentialMode = $state<CredentialMode>(app.credentialMode);
  savedCredentialMode = $state<CredentialMode>(app.credentialMode);
  credentialError = $state('');
  importing = $state(false);
  styleBrief = $state('');
  showStyleConfirm = $state(false);
  styleError = $state('');
  importingSettings = $state(false);
  overridesInvalid = $state(false);
  glossaryInvalid = $state(false);
  packInvalid = $state(false);
  customPriceInput = $state('');
  customPriceOutput = $state('');
  usageSnapshots = $state<ProviderUsage[]>([]);
  usageError = $state('');
  modelError = $state('');
  modelErrorSelection = $state('');
  connection = $state<Connection>(idle());
  packOpen = $state(app.settings.resource_pack_enabled);
  keyOpen = $state(false);
  /** The collapsed "Advanced" section of the translate tab (reasoning, prices, key storage, style, glossary). */
  advancedOpen = $state(false);
  /** Bumped when the draft is replaced from outside, so an editor holding unfinished input starts over. */
  draftEpoch = $state(0);

  private lastPriceSelection = '';
  private lastAutoLookup = '';

  // --- what the draft means ------------------------------------------------------------------

  isCustom = $derived(this.draft.provider === 'custom');
  models = $derived(app.modelsFor(this.draft));
  reasoningModel = $derived(this.models.find((model) => model.id === this.draft.model.trim()));
  selectedPriceKey = $derived(`${this.draft.provider}/${this.draft.model.trim()}`);
  catalogPriceAvailable = $derived.by(() => {
    const item = this.models.find((model) => model.id === this.draft.model.trim());
    if (!item) return false;
    return hasCatalogPrice(item.pricing_prompt) && hasCatalogPrice(item.pricing_completion);
  });
  savedSelectedPrice = $derived(this.snapshot?.custom_prices?.[this.selectedPriceKey]);
  customPriceInvalid = $derived([this.customPriceInput, this.customPriceOutput].some((value) => {
    if (!value.trim()) return false;
    const amount = Number(value);
    return !Number.isFinite(amount) || amount < 0 || amount > 1000;
  }));
  customPriceIncomplete = $derived((this.customPriceInput.trim() === '') !== (this.customPriceOutput.trim() === ''));
  customPriceDraftDirty = $derived(!!this.snapshot && (
    (this.customPriceInput.trim() ? Number(this.customPriceInput) : null) !== (this.savedSelectedPrice?.input ?? null) ||
    (this.customPriceOutput.trim() ? Number(this.customPriceOutput) : null) !== (this.savedSelectedPrice?.output ?? null)
  ));
  reasoningMetadata = $derived(this.reasoningModel?.reasoning);
  reasoningSupported = $derived(supportsReasoning(this.reasoningModel));
  reasoningEfforts = $derived(supportedEfforts(this.reasoningModel));
  currentReasoning = $derived(this.draft.openrouter_reasoning ?? 'default');
  mode = $derived(reasoningMode(this.currentReasoning));
  hiddenReasoning = $derived(!['default', 'enabled', 'disabled', ...this.reasoningEfforts].includes(this.currentReasoning));
  reasoningInvalid = $derived(REASONING_PROVIDERS.includes(this.draft.provider) && this.currentReasoning !== 'default' &&
    (!this.reasoningModel || !this.reasoningSupported || (this.currentReasoning === 'disabled' && !!this.reasoningMetadata?.mandatory) || this.hiddenReasoning));
  dirty = $derived(!!this.snapshot && (JSON.stringify(copySettings(this.draft)) !== JSON.stringify(copySettings(this.snapshot)) || this.customPriceDraftDirty ||
    !!this.apiKey.trim() || this.credentialMode !== this.savedCredentialMode));
  pending: PendingChanges = $derived(this.snapshot
    ? pendingChanges(this.draft, this.snapshot, { keyTyped: !!this.apiKey.trim(), storageModeChanged: this.credentialMode !== this.savedCredentialMode })
    : { translate: 0, scope: 0, advanced: 0, app: 0 });
  pendingTabs = $derived(SETTINGS_TABS.filter((name) => this.pending[name] > 0));
  selectionKey = $derived(`${this.draft.provider}:${this.draft.model.trim()}`);
  visibleModelError = $derived(this.modelErrorSelection === this.selectionKey ? this.modelError : '');
  tab: SettingsTab = $derived(app.settingsTab);
  baseUrlInvalid = $derived(this.isCustom && !isValidCustomEndpoint(this.draft.base_url));
  rangeInvalid = $derived.by(() => ({
    temperature: !inRange(this.draft.temperature, 0, 2),
    batch: !inRange(this.draft.batch_size, 1, 200),
    timeout: !inRange(this.draft.request_timeout, 5, 600),
    rpm: !inRange(this.draft.rpm_limit, 0, 10000),
    tpm: !inRange(this.draft.tpm_limit, 0, 10000000),
    retries: !inRange(this.draft.max_batch_retries, 0, 10),
    maxCost: !inRange(this.draft.max_cost_usd, 0, 1000),
    writeRetries: !inRange(this.draft.max_file_write_retries, 1, 10) || !Number.isInteger(this.draft.max_file_write_retries),
    concurrency: !inRange(this.draft.concurrency, 1, 8)
  }));
  hasRangeError = $derived(Object.values(this.rangeInvalid).some(Boolean));
  /** Input an editor holds but cannot hand to the draft yet (a half-written row): it exists only because someone typed it. */
  incomplete = $derived(this.overridesInvalid || this.glossaryInvalid || this.customPriceIncomplete || (!!this.draft.resource_pack_enabled && this.packInvalid));
  hasBlockingError = $derived(this.reasoningInvalid || this.hasRangeError || this.customPriceInvalid || this.customPriceIncomplete || this.overridesInvalid ||
    this.glossaryInvalid || (!!this.draft.resource_pack_enabled && this.packInvalid) || (this.isCustom && !isValidCustomEndpoint(this.draft.base_url)));
  /** The tabs that hold an error, so a blocked save says where to look. */
  errorTabs = $derived(SETTINGS_TABS.filter((name) =>
    (name === 'translate' && (this.reasoningInvalid || this.customPriceInvalid || this.customPriceIncomplete || this.glossaryInvalid || this.rangeInvalid.maxCost)) ||
    (name === 'scope' && (this.overridesInvalid || (!!this.draft.resource_pack_enabled && this.packInvalid))) ||
    (name === 'advanced' && (this.hasRangeError || this.baseUrlInvalid))));
  showSaveBar = $derived(this.pending[this.tab] > 0 || this.errorTabs.includes(this.tab) ||
    (this.tab === 'scope' && this.incomplete) || (!!app.returnStep && !this.dirty && !this.incomplete));
  attentionTabs = $derived(SETTINGS_TABS.filter((name) => name !== this.tab &&
    (this.pending[name] > 0 || this.errorTabs.includes(name) || (name === 'scope' && this.incomplete))));
  showCrossTabAttention = $derived(this.attentionTabs.length > 0 && this.pending[this.tab] === 0 &&
    !this.errorTabs.includes(this.tab) && !(this.tab === 'scope' && this.incomplete));
  stored = $derived(this.credentialProvider === this.draft.provider ? this.credentialState : null);

  tabNames(names: SettingsTab[]): string {
    return names.map((name) => t(TAB_LABELS[name])).join('·');
  }

  // --- life cycle (called from the screen's effects) -----------------------------------------

  /** AppState is bootstrapped asynchronously: the comparison copy is taken after that, from the saved settings. */
  initWhenReady(): void {
    if (!app.ready || this.snapshot) return;
    this.draft = copySettings(app.settings);
    this.snapshot = copySettings(app.settings);
    this.credentialProvider = app.settings.provider;
    this.credentialState = app.apiKeyStored;
    this.credentialMode = app.credentialMode;
    this.packOpen = !!app.settings.resource_pack_enabled;
    void this.refreshCredential(app.settings.provider);
  }

  /** Only public metadata auto-loads. No key/keychain read and no preference write. Returns the timer's cleanup. */
  scheduleAutoLookup(): (() => void) | void {
    const key = this.selectionKey;
    if (!app.ready || this.draft.provider !== 'openrouter' || !this.draft.model.trim() || app.busy || this.lastAutoLookup === key) return;
    const timer = setTimeout(() => {
      this.lastAutoLookup = key;
      void untrack(() => this.loadModels(false));
    }, 350);
    return () => clearTimeout(timer);
  }

  /** Switching the model brings along the custom price saved for it. */
  syncPriceInputs(): void {
    const key = this.selectedPriceKey;
    if (key === this.lastPriceSelection) return;
    this.lastPriceSelection = key;
    const price = this.draft.custom_prices?.[this.selectedPriceKey];
    this.customPriceInput = price ? String(price.input) : '';
    this.customPriceOutput = price ? String(price.output) : '';
  }

  // --- editing -------------------------------------------------------------------------------

  changeCustomPrice(which: 'input' | 'output', value: string): void {
    if (which === 'input') this.customPriceInput = value;
    else this.customPriceOutput = value;
    const input = this.customPriceInput.trim() ? Number(this.customPriceInput) : null;
    const output = this.customPriceOutput.trim() ? Number(this.customPriceOutput) : null;
    const prices = { ...(this.draft.custom_prices ?? {}) };
    if (input !== null && output !== null && Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0 && input <= 1000 && output <= 1000) {
      const current = prices[this.selectedPriceKey];
      if (!current || current.input !== input || current.output !== output) prices[this.selectedPriceKey] = { input, output };
    } else {
      delete prices[this.selectedPriceKey];
    }
    this.draft.custom_prices = prices;
  }

  chooseReasoning(next: 'default' | 'disabled' | 'custom'): void {
    this.draft.openrouter_reasoning = next === 'custom'
      ? (this.mode === 'custom' ? this.currentReasoning : this.reasoningEfforts.includes(this.reasoningMetadata?.default_effort ?? '')
          ? this.reasoningMetadata!.default_effort! : this.reasoningEfforts[0] ?? 'enabled')
      : next;
  }

  providerChanged(value: string): void {
    this.draft.provider = value;
    const defaults = PROVIDER_DEFAULTS[this.draft.provider];
    if (defaults) {
      // A custom endpoint can contain credentials controlled by a different operator. Never
      // carry it into a public provider selection where the field is hidden from the user.
      this.draft.base_url = defaults.baseUrl;
      this.draft.wire_format = defaults.wireFormat;
    } else if (this.draft.provider === 'custom' && PROVIDER_DEFAULTS[this.snapshot?.provider || '']) {
      this.draft.base_url = '';
      this.draft.wire_format = 'openai';
    }
    this.forgetTypedKey();
    this.modelError = '';
    this.usageSnapshots = [];
    this.usageError = '';
    void this.refreshCredential(this.draft.provider);
  }

  /** Whatever key was typed or checked belongs to a different choice now. */
  forgetTypedKey(): void {
    this.apiKey = '';
    this.showApiKey = false;
    this.editingKey = false;
    this.connection = idle();
  }

  cancelKeyChange(): void {
    this.editingKey = false;
    this.apiKey = '';
    this.showApiKey = false;
    this.connection = idle();
  }

  resetSpeed(): void {
    const defaults = defaultSettings();
    Object.assign(this.draft, {
      concurrency: defaults.concurrency, batch_size: defaults.batch_size, temperature: defaults.temperature,
      request_timeout: defaults.request_timeout, rpm_limit: defaults.rpm_limit, tpm_limit: defaults.tpm_limit,
      max_batch_retries: defaults.max_batch_retries, max_file_write_retries: defaults.max_file_write_retries,
      continue_on_file_error: defaults.continue_on_file_error
    });
  }

  resetRules(): void {
    const defaults = defaultScanOptions();
    this.draft.scan_options = {
      ...this.draft.scan_options!,
      region_dirs: defaults.region_dirs, skip_patterns: defaults.skip_patterns, component_translate_key_prefixes: defaults.component_translate_key_prefixes
    };
  }

  // --- credentials -----------------------------------------------------------------------------

  async refreshCredential(provider: string): Promise<void> {
    this.credentialProvider = provider;
    this.credentialState = null;
    this.credentialLoading = true;
    this.credentialError = '';
    try {
      const status = await credentialStatus(provider);
      if (this.credentialProvider === provider) {
        this.credentialState = status.stored;
        this.credentialMode = status.mode;
        this.savedCredentialMode = status.mode;
        // This is only a boolean status. The key itself is never read from the store.
        if (app.settings.provider === provider) app.apiKeyStored = status.stored;
      }
    } catch (cause) {
      if (this.credentialProvider === provider) this.credentialError = app.describe(cause);
    } finally {
      if (this.credentialProvider === provider) this.credentialLoading = false;
    }
  }

  async deleteApiKey(): Promise<void> {
    this.showDeleteConfirm = false;
    // The singleton method intentionally receives only the provider. It never returns or
    // exposes the stored credential value.
    if (await app.deleteApiKey(this.draft.provider)) {
      this.credentialProvider = this.draft.provider;
      this.credentialState = false;
      this.credentialMode = 'local';
      this.savedCredentialMode = 'local';
      this.forgetTypedKey();
    }
  }

  async importExisting(): Promise<void> {
    this.importing = true;
    this.credentialError = '';
    try {
      const status = await importCredential(this.draft.provider);
      app.credentialRecovery.delete(this.draft.provider);
      this.credentialMode = status.mode;
      this.savedCredentialMode = status.mode;
      this.credentialState = status.stored;
      if (app.settings.provider === this.draft.provider) {
        app.credentialMode = status.mode;
        app.apiKeyStored = status.stored;
      }
      app.notify(t('settings.vault.imported'), 'success');
    } catch (cause) {
      this.credentialError = app.describe(cause);
    } finally { this.importing = false; }
  }

  // --- provider requests -----------------------------------------------------------------------

  async loadModels(force = true): Promise<void> {
    if (!this.snapshot || app.busy || this.baseUrlInvalid) return;
    const selection = copySettings(this.draft);
    const key = this.selectionKey;
    const typed = this.apiKey.trim();
    if (selection.provider !== 'openrouter' && !this.stored && !typed) {
      this.modelError = t('settings.model.needKey');
      this.modelErrorSelection = key;
      return;
    }
    this.modelError = '';
    try {
      // A typed key that is not saved yet is sent once with this request and never kept.
      if (typed && force) await app.checkConnection(selection, typed);
      else await app.loadModels(selection, force);
    } catch {
      this.modelError = t('settings.model.failed');
      this.modelErrorSelection = key;
    }
  }

  async checkKey(): Promise<void> {
    if (!this.snapshot || app.busy || this.baseUrlInvalid) return;
    const selection = copySettings(this.draft);
    this.connection = { status: 'checking', count: 0, code: '' };
    const result = await app.testConnection(selection, this.apiKey.trim());
    this.connection = result.ok
      ? { status: 'ok', count: app.modelsFor(selection).filter(isSuitable).length, code: '' }
      : { status: 'error', count: 0, code: result.code };
  }

  async checkUsage(): Promise<void> {
    if (app.busy || this.draft.provider !== 'openrouter' || !this.stored || this.apiKey.trim()) return;
    app.busy = 'usage';
    this.usageError = '';
    try {
      const reply = await callBackend<ProviderUsage>('provider.usage', { provider: 'openrouter' });
      this.usageSnapshots = [...this.usageSnapshots, reply].slice(-2);
    } catch { this.usageError = t('settings.usage.failed'); }
    finally { app.busy = ''; }
  }

  async enhanceStyle(): Promise<void> {
    this.showStyleConfirm = false;
    if (app.busy || !this.styleBrief.trim() || this.apiKey.trim()) return;
    app.busy = 'prompt';
    this.styleError = '';
    const draft = this.draft;
    try {
      const reply = await callBackend<{ enhancedPrompt: string }>('prompt.enhance', {
        provider: draft.provider, model: draft.model,
        ...(draft.provider === 'custom' ? { baseUrl: draft.base_url } : {}), wireFormat: draft.wire_format,
        brief: this.styleBrief.trim(), targetLanguage: draft.target_language, stylePreset: draft.style_preset,
        stylePrompt: draft.style_prompt ?? '', customSystemPrompt: draft.custom_system_prompt ?? ''
      });
      if (!reply.enhancedPrompt?.trim()) throw new Error(t('settings.styleAssist.empty'));
      draft.style_prompt = [draft.style_prompt?.trim(), reply.enhancedPrompt.trim()].filter(Boolean).join('\n\n');
      app.notify(t('settings.styleAssist.done'), 'success');
    } catch (cause) { this.styleError = app.describe(cause); }
    finally { app.busy = ''; }
  }

  async changeLanguage(select: HTMLSelectElement): Promise<void> {
    const locale = select.value as 'ko' | 'en' | 'ja' | 'zh';
    if (await app.setUiLanguage(locale)) {
      this.draft.ui_language = locale;
      if (this.snapshot) this.snapshot.ui_language = locale;
    } else {
      select.value = this.draft.ui_language ?? 'ko';
    }
  }

  // --- saving, discarding, importing -----------------------------------------------------------

  async save(): Promise<boolean> {
    if (!this.snapshot || this.hasBlockingError || app.busy) return false;

    const previous = copySettings(this.snapshot);
    const previousMode = app.credentialMode;
    app.settings = copySettings(this.draft);
    app.credentialMode = this.credentialMode;
    const saved = await app.saveSettings(previous, this.apiKey, previousMode);
    if (!saved) {
      // AppState restores verified preferences or reloads an uncertain write. Keep the
      // user's unsaved draft/key for retry, without replacing the authoritative state.
      this.snapshot = copySettings(app.settings);
      return false;
    }

    this.draft = copySettings(app.settings);
    this.snapshot = copySettings(app.settings);
    this.apiKey = '';
    this.showApiKey = false;
    this.editingKey = false;
    this.savedCredentialMode = app.credentialMode;
    this.credentialProvider = app.settings.provider;
    this.credentialState = app.apiKeyStored;
    return true;
  }

  discard(): void {
    this.draftEpoch += 1;
    this.lastPriceSelection = '';
    this.draft = copySettings(app.settings);
    this.snapshot = copySettings(app.settings);
    this.forgetTypedKey();
    this.modelError = '';
    void this.refreshCredential(this.draft.provider);
  }

  resetToDefaults(): void {
    this.draftEpoch += 1;
    this.lastPriceSelection = '';
    this.draft = copySettings({ ...defaultSettings(), ui_language: app.locale, last_world_dir: app.worldDir });
    this.forgetTypedKey();
    void this.refreshCredential(this.draft.provider);
    app.notify(t('settings.resetDraftDone'), 'info');
  }

  async importFrom(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (!file) return;
    if (app.busy) { input.value = ''; return; }
    this.importingSettings = true;
    app.busy = 'loading';
    try {
      if (file.size > 1024 * 1024) throw new Error('oversized');
      const text = await file.text();
      const contents = file.name.toLowerCase().endsWith('.py')
        ? JSON.stringify((await callBackend<{ config: unknown }>('settings.import_legacy', { source: text })).config)
        : text;
      this.draft = copySettings(parseSettingsImport(contents, app.settings));
      this.draftEpoch += 1;
      this.forgetTypedKey();
      await this.refreshCredential(this.draft.provider);
      app.notify(t('settings.import.done'), 'info');
    } catch { app.notify(t('settings.import.failed'), 'error'); }
    finally { input.value = ''; this.importingSettings = false; app.busy = ''; }
  }

  async exportDraft(): Promise<void> {
    try {
      if (await exportDocument('settings', { schema: 1, settings: publicSettingsForExport(this.draft) })) app.notify(t('export.saved'), 'success');
    } catch (cause) { app.fail(cause); }
  }
}

export const TAB_LABELS: Record<SettingsTab, MessageKey> = {
  translate: 'settings.tab.translate', scope: 'settings.tab.scope', advanced: 'settings.tab.advanced', app: 'settings.tab.app'
};
