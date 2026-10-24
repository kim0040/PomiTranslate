import { SvelteSet } from 'svelte/reactivity';
import {
  BackendError, callBackend, resetCredentialStorage,
  type CredentialMode, type CredentialState, type CredentialStoreError, type Settings
} from '../api';
import { setLocale, t, type Locale } from '../i18n/index.svelte';
import { LISTABLE_PROVIDERS } from '../recommended-models';
import { RECOMMENDED_PROVIDER } from '../providers';
import { resourcePackOptions } from '../resource-pack';
import { normalizedScanOptions, scanOptionsSignature } from '../settings';
import type { AppState } from '../app.svelte';

export const defaultSettings = (): Settings => ({
  provider: RECOMMENDED_PROVIDER, model: '', base_url: '', wire_format: 'openai', target_language: '한국어', style_preset: 'neutral',
  openrouter_reasoning: 'default', style_prompt: '', custom_system_prompt: '', temperature: 0.3, batch_size: 40, request_timeout: 120, rpm_limit: 0,
  tpm_limit: 0, max_batch_retries: 3, concurrency: 4, resource_pack_enabled: false, resource_pack_options: resourcePackOptions(), external_resource_pack_paths: [], skip_target_language_text: true,
  max_file_write_retries: 2, continue_on_file_error: true, review_before_apply: true, max_cost_usd: 0, source_overrides: {}, custom_prices: {},
  ui_language: 'ko', last_world_dir: '', scan_options: normalizedScanOptions()
});

/** Settings that change which text a scan finds. Changing one makes a reviewed scan stale. */
const SCOPE_KEYS: (keyof Settings)[] = ['target_language', 'resource_pack_enabled', 'skip_target_language_text'];

type SavedSettings = { settings: Settings; apiKeyStored: boolean; credentialMode?: CredentialMode; credentialState?: CredentialState };

/** The saved settings, where the API key lives, and every way of writing them. */
export class SettingsStore {
  settings = $state<Settings>(defaultSettings());
  apiKeyStored = $state(false);
  credentialMode = $state<CredentialMode>('local');
  /** Why the key store cannot be used, when it cannot. Saved keys may still be there. */
  credentialStoreError = $state<CredentialStoreError | null>(null);
  settingsRecoveryRequired = $state(false);
  /** Why the last save failed. The settings save bar and the setup wizard show it where the user pressed save. */
  saveError = $state('');
  credentialRecovery = new SvelteSet<string>();
  /**
   * The saved Custom key predates address binding and is never sent (CREDENTIAL_ENDPOINT_UNBOUND).
   * Settings then explains it and opens the key field; saving a new key clears it.
   */
  keyReentry = $state(false);
  /** Set when the person is taken to the key field; Settings clears it once the field has focus. */
  focusKeyField = $state(false);
  private recoveryRevision = 0;

  constructor(private readonly app: AppState) {}

  /** Record what the shell reported about the key store. */
  applyCredentialState(state: CredentialState | undefined): void {
    this.credentialStoreError = state?.error ?? null;
  }

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
    this.applyCredentialState(saved.credentialState);
    this.settingsRecoveryRequired = false;
    this.credentialRecovery.delete(s.provider);
    // The key just saved is tied to this address, so the old unbound one is gone.
    if (apiKey && s.provider === 'custom') this.keyReentry = false;
  }

  /** Reload authoritative preferences after a write whose rollback could not be verified. */
  private async recover(): Promise<void> {
    const app = this.app;
    this.settingsRecoveryRequired = true;
    this.recoveryRevision += 1;
    // The reviewed scan has to go, but the review itself is kept in the core when possible.
    await app.job.draft.store(true);
    if (app.job.draft.needsConfirm) app.notify(t('review.draft.lostOnRecovery'), 'error', 12000);
    app.job.reset();
    if (app.worldDir) app.step = 'scan';
    try {
      const saved = await callBackend<SavedSettings>('settings.get');
      this.settings = { ...defaultSettings(), ...saved.settings };
      this.settings.scan_options = normalizedScanOptions(saved.settings.scan_options);
      this.apiKeyStored = saved.apiKeyStored;
      this.credentialMode = saved.credentialMode ?? this.credentialMode;
      this.applyCredentialState(saved.credentialState);
      setLocale(app.locale);
      this.settingsRecoveryRequired = false;
    } catch {
      // Unknown state remains blocked until a subsequent successful settings save/reload.
    }
  }

  /** Whether two settings differ in what a scan finds (so a reviewed scan would go stale). */
  scopeDiffers(before: Settings, now: Settings): boolean {
    return SCOPE_KEYS.some((key) => before[key] !== now[key]) ||
      JSON.stringify(before.external_resource_pack_paths ?? []) !== JSON.stringify(now.external_resource_pack_paths ?? []) ||
      scanOptionsSignature(before.scan_options) !== scanOptionsSignature(now.scan_options) ||
      JSON.stringify(resourcePackOptions(before.resource_pack_options)) !== JSON.stringify(resourcePackOptions(now.resource_pack_options));
  }

  /** Save from the settings screen. A change that alters what a scan finds makes the scan stale. */
  async save(before: Settings, apiKey = '', beforeMode: CredentialMode = this.credentialMode): Promise<boolean> {
    const app = this.app;
    if (app.busy) return false;
    this.saveError = '';
    if (app.scan && this.scopeDiffers(before, this.settings) && !(await app.job.draft.mayDiscard('settings'))) {
      // Declined: nothing was saved, so the settings screen keeps its unsaved draft.
      this.settings = { ...before };
      this.credentialMode = beforeMode;
      return false;
    }
    if (app.busy) return false;
    app.busy = 'settings';
    const recoveryRevision = this.recoveryRevision;
    try {
      await this.persist(apiKey);
      const scopeChanged = this.scopeDiffers(before, this.settings);
      if (scopeChanged && app.scan) {
        app.job.reset();
        if (app.step !== 'world') app.step = 'scan';
        app.notify(t('settings.changedScan'), 'info', 8000);
      }
      if (before.ui_language !== this.settings.ui_language) setLocale(app.locale);
      if (JSON.stringify(before.source_overrides) !== JSON.stringify(this.settings.source_overrides)) app.candidates.refetchSoon(0);
      if (app.scan) void app.loadEstimate();
      app.notify(t('settings.saved'), 'success', 2600);
      // A new key makes the provider's model list readable: fetch it so the model box has choices.
      if (apiKey && LISTABLE_PROVIDERS.includes(this.settings.provider)) void app.loadModels(this.settings, true).catch(() => {});
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
      if (provider === 'custom') this.keyReentry = false;
      this.app.notify(t('settings.apiKey.deleted'), 'success');
      return true;
    } catch (cause) {
      this.app.fail(cause);
      return false;
    }
  }

  /** Set a damaged key store aside and start an empty one. */
  async resetKeyStorage(): Promise<boolean> {
    const app = this.app;
    if (app.isBusy) return false;
    try {
      await resetCredentialStorage();
      this.credentialStoreError = null;
      this.apiKeyStored = false;
      this.credentialRecovery.clear();
      app.notify(t('credential.reset.done'), 'success');
      return true;
    } catch (cause) {
      app.fail(cause);
      return false;
    }
  }
}
