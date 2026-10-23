import { SvelteSet } from 'svelte/reactivity';
import { BackendError, callBackend, type CredentialMode, type Settings } from '../api';
import { setLocale, t, type Locale } from '../i18n/index.svelte';
import { RECOMMENDED_PROVIDER } from '../providers';
import { resourcePackOptions } from '../resource-pack';
import { normalizedScanOptions, scanOptionsSignature } from '../settings';
import type { AppState } from '../app.svelte';

export const defaultSettings = (): Settings => ({
  provider: RECOMMENDED_PROVIDER, model: '', base_url: '', wire_format: 'openai', target_language: '한국어', style_preset: 'neutral',
  openrouter_reasoning: 'default', style_prompt: '', custom_system_prompt: '', temperature: 0.3, batch_size: 40, request_timeout: 120, rpm_limit: 0,
  tpm_limit: 0, max_batch_retries: 3, concurrency: 4, resource_pack_enabled: false, resource_pack_options: resourcePackOptions(), external_resource_pack_paths: [], skip_target_language_text: true,
  max_file_write_retries: 2, continue_on_file_error: true, review_before_apply: true, max_cost_usd: 0, source_overrides: {}, glossary: [], custom_prices: {},
  ui_language: 'ko', last_world_dir: '', scan_options: normalizedScanOptions()
});

/** Settings that change which text a scan finds. Changing one makes a reviewed scan stale. */
const SCOPE_KEYS: (keyof Settings)[] = ['target_language', 'resource_pack_enabled', 'skip_target_language_text'];

type SavedSettings = { settings: Settings; apiKeyStored: boolean; credentialMode: CredentialMode };

/** The saved settings, where the API key lives, and every way of writing them. */
export class SettingsStore {
  settings = $state<Settings>(defaultSettings());
  apiKeyStored = $state(false);
  credentialMode = $state<CredentialMode>('local');
  settingsRecoveryRequired = $state(false);
  /** Why the last save failed. The settings save bar and the setup wizard show it where the user pressed save. */
  saveError = $state('');
  credentialRecovery = new SvelteSet<string>();
  private recoveryRevision = 0;

  constructor(private readonly app: AppState) {}

  /** Write the current settings, and a new API key when one was typed. Never keeps the key. */
  async persist(apiKey = ''): Promise<void> {
    const s = this.settings;
    if (this.credentialRecovery.has(s.provider) && !apiKey) throw new BackendError('', 'CREDENTIAL_SAVE_UNCERTAIN');
    let saved: SavedSettings;
    try {
      saved = await callBackend('settings.set', {
        worldDir: this.app.worldDir,
        provider: s.provider,
        credentialMode: this.credentialMode,
        model: s.model,
        // Public providers use their canonical endpoint. Only Custom exposes and persists a URL.
        ...(s.provider === 'custom' ? { baseUrl: s.base_url } : {}),
        wireFormat: s.wire_format,
        targetLanguage: s.target_language,
        stylePreset: s.style_preset,
        stylePrompt: s.style_prompt,
        customSystemPrompt: s.custom_system_prompt,
        uiLanguage: s.ui_language,
        openrouterReasoning: s.openrouter_reasoning ?? 'default',
        temperature: s.temperature,
        batchSize: s.batch_size,
        requestTimeout: s.request_timeout,
        rpmLimit: s.rpm_limit,
        tpmLimit: s.tpm_limit,
        maxBatchRetries: s.max_batch_retries,
        maxFileWriteRetries: s.max_file_write_retries,
        continueOnFileError: s.continue_on_file_error,
        reviewBeforeApply: s.review_before_apply !== false,
        maxCostUsd: s.max_cost_usd ?? 0,
        glossary: s.glossary ?? [],
        customPrices: s.custom_prices ?? {},
        sourceOverrides: s.source_overrides ?? {},
        concurrency: s.concurrency,
        resourcePackEnabled: s.resource_pack_enabled,
        resourcePackOptions: resourcePackOptions(s.resource_pack_options),
        externalResourcePackPaths: s.external_resource_pack_paths ?? [],
        skipTargetLanguageText: s.skip_target_language_text,
        scanOptions: normalizedScanOptions(s.scan_options),
        ...(apiKey ? { apiKey } : {})
      });
    } catch (cause) {
      if (cause instanceof BackendError && cause.code === 'CREDENTIAL_SAVE_UNCERTAIN') this.credentialRecovery.add(s.provider);
      if (cause instanceof BackendError && ['SETTINGS_RECONCILIATION_REQUIRED', 'CREDENTIAL_SAVE_UNCERTAIN'].includes(cause.code)) await this.recover();
      throw cause;
    }
    this.settings = { ...defaultSettings(), ...saved.settings };
    this.settings.scan_options = normalizedScanOptions(saved.settings.scan_options);
    this.apiKeyStored = saved.apiKeyStored;
    this.credentialMode = saved.credentialMode ?? this.credentialMode;
    this.settingsRecoveryRequired = false;
    this.credentialRecovery.delete(s.provider);
  }

  /** Reload authoritative preferences after a write whose rollback could not be verified. */
  private async recover(): Promise<void> {
    this.settingsRecoveryRequired = true;
    this.recoveryRevision += 1;
    this.app.job.reset();
    if (this.app.worldDir) this.app.step = 'scan';
    try {
      const saved = await callBackend<SavedSettings>('settings.get');
      this.settings = { ...defaultSettings(), ...saved.settings };
      this.settings.scan_options = normalizedScanOptions(saved.settings.scan_options);
      this.apiKeyStored = saved.apiKeyStored;
      this.credentialMode = saved.credentialMode ?? 'local';
      setLocale(this.app.locale);
      this.settingsRecoveryRequired = false;
    } catch {
      // Unknown state remains blocked until a subsequent successful settings save/reload.
    }
  }

  /** Save from the settings screen. A change that alters what a scan finds makes the scan stale. */
  async save(before: Settings, apiKey = '', beforeMode: CredentialMode = this.credentialMode): Promise<boolean> {
    const app = this.app;
    if (app.busy) return false;
    app.busy = 'settings';
    this.saveError = '';
    const recoveryRevision = this.recoveryRevision;
    try {
      await this.persist(apiKey);
      const scopeChanged = SCOPE_KEYS.some((key) => before[key] !== this.settings[key]) ||
        JSON.stringify(before.external_resource_pack_paths ?? []) !== JSON.stringify(this.settings.external_resource_pack_paths ?? []) ||
        scanOptionsSignature(before.scan_options) !== scanOptionsSignature(this.settings.scan_options) ||
        JSON.stringify(resourcePackOptions(before.resource_pack_options)) !== JSON.stringify(resourcePackOptions(this.settings.resource_pack_options));
      if (scopeChanged && app.scan) {
        app.job.reset();
        if (app.step !== 'world') app.step = 'scan';
        app.notify(t('settings.changedScan'), 'info', 8000);
      }
      if (before.ui_language !== this.settings.ui_language) setLocale(app.locale);
      if (JSON.stringify(before.source_overrides) !== JSON.stringify(this.settings.source_overrides)) app.candidates.refetchSoon(0);
      if (JSON.stringify(before.glossary ?? []) !== JSON.stringify(this.settings.glossary ?? [])) app.translationReview.reset();
      if (app.scan) void app.loadEstimate();
      app.notify(t('settings.saved'), 'success', 2600);
      return true;
    } catch (cause) {
      if (this.recoveryRevision === recoveryRevision) {
        this.settings = { ...before };
        this.credentialMode = beforeMode;
      }
      this.saveError = `${t('settings.saveError')}: ${app.describe(cause)}`;
      return false;
    } finally {
      app.busy = '';
    }
  }

  /** Save one of the options on the run screen without touching anything else the settings screen holds. */
  async setRunOption(changes: Partial<Pick<Settings, 'review_before_apply' | 'max_cost_usd'>>): Promise<boolean> {
    const app = this.app;
    if (app.busy) return false;
    const before = { review_before_apply: this.settings.review_before_apply, max_cost_usd: this.settings.max_cost_usd };
    app.busy = 'settings';
    this.settings = { ...this.settings, ...changes };
    try {
      await this.persist();
      if (app.scan) void app.loadEstimate();
      return true;
    } catch (cause) {
      this.settings = { ...this.settings, ...before };
      app.fail(cause);
      return false;
    } finally {
      app.busy = '';
    }
  }

  /**
   * The display language applies the moment it is picked, like the appearance next to it. Only the
   * language is written; other edits waiting on the settings screen stay unsaved there.
   */
  async setUiLanguage(locale: Locale): Promise<boolean> {
    const app = this.app;
    const before = this.settings.ui_language;
    if (before === locale) return true;
    if (app.busy) return false;
    app.busy = 'settings';
    this.settings = { ...this.settings, ui_language: locale };
    setLocale(locale);
    try {
      await this.persist();
      return true;
    } catch (cause) {
      this.settings = { ...this.settings, ui_language: before };
      setLocale(app.locale);
      app.fail(cause);
      return false;
    } finally {
      app.busy = '';
    }
  }

  async deleteApiKey(provider = this.settings.provider): Promise<boolean> {
    try {
      await callBackend<{ deleted: boolean }>('credentials.delete', { provider });
      if (provider === this.settings.provider) {
        this.apiKeyStored = false;
        this.credentialMode = 'local';
      }
      this.credentialRecovery.delete(provider);
      this.app.notify(t('settings.apiKey.deleted'), 'success');
      return true;
    } catch (cause) {
      this.app.fail(cause);
      return false;
    }
  }
}
