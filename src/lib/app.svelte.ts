import {
  callBackend,
  onCloseBlocked,
  onZoomFailed,
  onProgress,
  type BootstrapPayload,
  type Candidate,
  type Settings
} from './api';
import { onCloseRequested, openExternal, type MenuAction } from './native';
import { setLocale, t, type Locale } from './i18n/index.svelte';
import { detectSystemLocale, isLocale } from './i18n/locale';
import { type ThemeChoice } from './theme';
import type { FontScale } from './font-scale';
import { exceedsCap } from './workflow';
import { normalizedScanOptions } from './settings';
import type { SettingsTab } from './settings-tabs';
import { Feedback } from './app/feedback.svelte';
import { LeaveGuards } from './app/guards.svelte';
import { ModelCatalog } from './app/model-catalog.svelte';
import { DEFAULT_PREFS, Preferences } from './app/preferences.svelte';
import { defaultSettings, SettingsStore } from './app/settings-store.svelte';
import { TranslationJob } from './app/translation-job.svelte';
import { Updater } from './app/updater.svelte';
import { WorldLibrary } from './app/worlds.svelte';
import { numberOr, STEPS, type Busy, type Page, type Step } from './app/types';

export type { Busy, FailureList, Operation, Page, Step, Tone, UpdateState } from './app/types';
export { DEFAULT_PREFS, STEPS, defaultSettings };

export const ISSUES_URL = 'https://github.com/kim0040/PomiTranslate/issues/new';
/** Menu commands that work while the core failed to start: help pages and links only. */
const STARTUP_SAFE_ACTIONS: MenuAction[] = ['help', 'shortcuts', 'licenses', 'report'];
const PROVIDERS = ['openai', 'gemini', 'anthropic', 'openrouter', 'comet', 'custom'];
const NOTICE_KEY = 'pomi.notice.v1';

/**
 * The one object the screens read. It owns what is shared by every screen (start-up, which page and
 * step is showing, the busy flag) and composes the domain modules in `./app/`; each module owns its
 * own state and rules. The members below the composition are thin pass-throughs so a screen can say
 * `app.scan` or `app.notify(...)` without knowing which module holds it.
 */
export class AppState {
  ready = $state(false);
  startupFailed = $state(false);
  page = $state<Page>('workspace');
  step = $state<Step>('world');
  busy = $state<Busy>('');
  railCollapsed = $state(false);
  /** A section of the help page to bring into view (set by the Help menu). */
  helpSection = $state('');
  notices = $state<BootstrapPayload['notices'] | null>(null);
  /** The workflow step that sent the user to settings, so settings can offer the way back. */
  returnStep = $state<Step | null>(null);
  /** The settings tab shown. It is kept for the session, and a fix-it link picks the tab it needs. */
  settingsTab = $state<SettingsTab>('translate');
  /** One setting a fix-it link points at (an element id on the settings screen); the screen reveals it, then clears this. */
  settingsFocus = $state('');
  /** True once the app is torn down, so late answers and retries stop touching it. */
  destroyed = false;

  readonly feedback = new Feedback();
  readonly guards = new LeaveGuards(this);
  readonly preferences = new Preferences(this);
  readonly updater = new Updater(this);
  readonly settingsStore = new SettingsStore(this);
  readonly modelCatalog = new ModelCatalog(this);
  readonly worlds = new WorldLibrary(this);
  readonly job = new TranslationJob(this);

  private unsubscribe: (() => void)[] = [];
  private listenersStarted = false;

  // --- derived across modules ----------------------------------------------------------------

  get locale(): Locale {
    return isLocale(this.settings.ui_language) ? this.settings.ui_language : 'ko';
  }

  get hasModel(): boolean {
    return !!this.settings.model?.trim();
  }

  /** What still has to be set up before the AI can translate. Scanning and review work without it. */
  get setupNeeds(): ('model' | 'key')[] {
    const needs: ('model' | 'key')[] = [];
    if (!this.hasModel) needs.push('model');
    if (!this.apiKeyStored) needs.push('key');
    return needs;
  }

  get canRun(): boolean {
    return !!this.scan && this.scan.status === 'completed' && !this.scan.writeBlockers?.length &&
      this.includedCount > 0 && (this.hasModel || this.manualOnly) && (this.apiKeyStored || this.manualOnly) && !this.busy &&
      !this.settingsRecoveryRequired && !this.credentialRecovery.has(this.settings.provider);
  }

  get stepReached(): Record<Step, boolean> {
    const scanned = !!this.scan && this.scan.status === 'completed' && !this.scan.writeBlockers?.length;
    return {
      world: true,
      scan: !!this.worldDir && !!this.inspection?.validJavaWorld,
      review: scanned && this.candidateCount > 0,
      run: scanned && this.candidateCount > 0,
      result: !!this.result
    };
  }

  /** The estimate's upper bound is above the saved spending cap: starting needs an explicit yes. */
  get overBudget(): boolean {
    return !this.manualOnly && exceedsCap(this.estimate, this.settings.max_cost_usd);
  }

  /** Where the estimate stands against the spending limit: free, unlimited, unpriced, over or within. */
  get costSafety() { return this.job.costSafety; }
  get unpriced(): boolean { return this.job.costSafety === 'unpriced'; }
  /** Show the "no price, so no limit" notice: before a start, or after the core refused one. */
  get unpricedNotice(): boolean { return this.job.costSafety === 'unpriced' || this.job.unpricedRetry !== null; }
  consentUnpriced(): Promise<void> { return this.job.consentUnpriced(); }
  get noLimitAcknowledged() { return this.job.noLimitAcknowledged; }
  set noLimitAcknowledged(value: boolean) { this.job.noLimitAcknowledged = value; }

  get isBusy(): boolean {
    return this.busy === 'scan' || this.busy === 'translate' || this.busy === 'restore';
  }

  // --- start-up ----------------------------------------------------------------------------

  async boot(): Promise<void> {
    if (this.busy || (this.ready && !this.startupFailed) || this.destroyed) return;
    this.busy = 'loading';
    this.ready = false;
    this.banner = null;
    this.startupFailed = false;
    if (!this.listenersStarted) {
      this.listenersStarted = true;
      // A stalled event subscription must not prevent the initial backend request.
      for (const listening of [
        onProgress((event) => this.job.handleProgress(event)),
        onCloseRequested((source) => this.guards.handleCloseRequested(source)),
        onCloseBlocked(() => { this.notify(t('app.closeBlocked'), 'info', 10000); }),
        onZoomFailed(() => { this.notify(t('app.zoomFailed'), 'error'); })
      ]) {
        void listening.then((stop) => {
          if (this.destroyed) stop(); else this.unsubscribe.push(stop);
        }).catch(() => {});
      }
    }
    try {
      const boot = await callBackend<BootstrapPayload>('app.bootstrap');
      if (this.destroyed) return;
      this.notices = boot.notices;
      this.settings = {
        ...defaultSettings(), ...boot.settings,
        ui_language: isLocale(boot.settings.ui_language) ? boot.settings.ui_language : detectSystemLocale()
      };
      this.settings.batch_size = numberOr(boot.settings.batch_size, 40);
      this.settings.temperature = numberOr(boot.settings.temperature, 0.3);
      this.settings.request_timeout = numberOr(boot.settings.request_timeout, 120);
      this.settings.rpm_limit = numberOr(boot.settings.rpm_limit, 0);
      this.settings.tpm_limit = numberOr(boot.settings.tpm_limit, 0);
      this.settings.max_batch_retries = numberOr(boot.settings.max_batch_retries, 3);
      this.settings.concurrency = numberOr(boot.settings.concurrency, 4);
      this.settings.review_before_apply = boot.settings.review_before_apply !== false;
      this.settings.max_cost_usd = numberOr(boot.settings.max_cost_usd, 0);
      this.settings.skip_target_language_text = boot.settings.skip_target_language_text !== false;
      this.settings.resource_pack_enabled = !!boot.settings.resource_pack_enabled;
      this.settings.scan_options = normalizedScanOptions(boot.settings.scan_options);
      setLocale(this.locale);
      this.apiKeyStored = boot.apiKeyStored;
      this.credentialMode = boot.credentialMode ?? 'local';
      this.recent = boot.worlds;
      this.worldDir = boot.settings.last_world_dir || '';
      this.inspection = boot.worldInspection;
      this.backups = boot.backups;
      this.lastJob = boot.lastJob ?? boot.resume?.lastJob ?? null;
      this.lastScan = boot.lastScan ?? boot.resume?.lastScan ?? null;
      this.preferences.apply(boot);
      if (this.worldDir && this.inspection?.validJavaWorld) this.step = 'scan';
      this.job.applyResume(boot.resume, { lastJob: boot.lastJob, lastScan: boot.lastScan });
      // Translations that were never written wait in the review: the user lands back in it.
      if (this.resume?.status === 'awaiting_review') {
        this.reviewResumed = true;
        this.openReview();
      } else if (this.resume?.status === 'reapply_interrupted') {
        this.step = 'result';
        this.reviewOpen = true;
        this.translationReview.reset();
      }
    } catch (cause) {
      this.startupFailed = true;
      this.fail(cause);
    } finally {
      this.busy = '';
      this.ready = true;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.preferences.dispose();
    this.job.stopClock();
    for (const stop of this.unsubscribe) stop();
    this.unsubscribe = [];
  }

  // --- reset -------------------------------------------------------------------------------

  /**
   * Return to first launch. Removes preferences, recent worlds, model lists and unfinished jobs, and
   * the saved API keys when asked. World backups stay, so every world can still be restored.
   */
  async resetApp(clearKeys: boolean): Promise<boolean> {
    if (this.isBusy) return false;
    try {
      await callBackend('app.reset', { confirm: 'reset' });
      if (clearKeys) for (const provider of PROVIDERS) await callBackend('credentials.delete', { provider });
      try {
        localStorage.removeItem(NOTICE_KEY);
        localStorage.removeItem('pomi.theme.v1');
      } catch { /* nothing cached */ }
      return true;
    } catch (cause) {
      this.fail(cause);
      return false;
    }
  }

  // --- navigation --------------------------------------------------------------------------

  goto(page: Page): void {
    if (this.busy === 'settings' || page === this.page) return;
    this.guards.leave(() => { this.page = page; });
  }

  goStep(step: Step): void {
    if (!this.ready || this.startupFailed || !this.stepReached[step] || this.isBusy) return;
    if (this.page === 'workspace') {
      this.step = step;
      return;
    }
    this.guards.leave(() => {
      this.page = 'workspace';
      this.step = step;
    });
  }

  /** Open settings to fix something the current step needs; settings then offers the way back. */
  openSettingsFor(step: Step = this.step, tab: SettingsTab = 'translate', focus = ''): void {
    if (this.busy === 'settings') return;
    this.returnStep = this.page === 'workspace' ? step : null;
    this.settingsTab = tab;
    this.settingsFocus = focus;
    this.goto('settings');
  }

  /** Back to the step that opened settings. */
  returnFromSettings(): void {
    const step = this.returnStep;
    if (step && this.stepReached[step]) this.goStep(step);
    else this.goto('workspace');
  }

  /** Commands from the native menu bar (or their shortcuts in a browser preview). */
  menu(action: MenuAction): void {
    // The appearance applies at any time, even while the app is starting or busy.
    if (action === 'theme-system' || action === 'theme-light' || action === 'theme-dark') {
      this.setTheme(action.slice(6) as ThemeChoice);
      return;
    }
    if (!this.ready || this.busy === 'settings') return;
    // Help, licenses and the issue link need nothing from the core, so they stay open when it failed to start.
    if (this.startupFailed && !STARTUP_SAFE_ACTIONS.includes(action)) return;
    if (action === 'settings') {
      this.goto('settings');
    } else if (action === 'open-world') {
      if (this.isBusy) return;
      this.guards.leave(() => {
        this.page = 'workspace';
        void this.chooseWorld();
      });
    } else if (action === 'help' || action === 'shortcuts') {
      this.helpSection = action === 'shortcuts' ? 'shortcuts' : '';
      this.goto('help');
    } else if (action === 'tour') {
      this.showTour = true;
    } else if (action === 'licenses') {
      this.showLicenses = true;
    } else if (action === 'report') {
      void openExternal(ISSUES_URL).catch((cause) => this.fail(cause));
    } else if (action === 'updates') {
      this.helpSection = 'updates';
      this.settingsTab = 'app';
      this.goto('settings');
      void this.checkUpdates(true);
    } else if (action === 'find') {
      if (this.page !== 'workspace' || this.step !== 'review') return;
      const search = document.getElementById('review-search') as HTMLInputElement | null;
      search?.focus();
      search?.select();
    }
  }

  // --- pass-throughs to the modules ----------------------------------------------------------

  // Feedback
  get banner() { return this.feedback.banner; }
  set banner(value: { tone: 'error' | 'warning'; message: string } | null) { this.feedback.banner = value; }
  get banners() { return this.feedback.banners; }
  dismissBanner(id: number): void { this.feedback.dismissBanner(id); }
  get toasts() { return this.feedback.toasts; }
  notify(...args: Parameters<Feedback['notify']>): number { return this.feedback.notify(...args); }
  dismissToast(id: number): void { this.feedback.dismissToast(id); }
  describe(cause: unknown): string { return this.feedback.describe(cause); }
  fail(cause: unknown): void { this.feedback.fail(cause); }

  // Preferences and the first-run guide
  get prefs() { return this.preferences.prefs; }
  get theme() { return this.preferences.theme; }
  set theme(value) { this.preferences.theme = value; }
  get showNotice() { return this.preferences.showNotice; }
  get showTour() { return this.preferences.showTour; }
  set showTour(value) { this.preferences.showTour = value; }
  get showWizard() { return this.preferences.showWizard; }
  set showWizard(value) { this.preferences.showWizard = value; }
  get showLicenses() { return this.preferences.showLicenses; }
  set showLicenses(value) { this.preferences.showLicenses = value; }
  setPrefs(changes: Parameters<Preferences['setPrefs']>[0]): Promise<void> { return this.preferences.setPrefs(changes); }
  acceptNotice(): void { this.preferences.acceptNotice(); }
  openWizard(): void { this.preferences.openWizard(); }
  dismissWizard(): void { this.preferences.dismissWizard(); }
  finishSetup(openTour = false): void { this.preferences.finishSetup(openTour); }
  saveSetup(changes: Partial<Settings>, apiKey: string): Promise<boolean> { return this.preferences.saveSetup(changes, apiKey); }
  finishTour(): void { this.preferences.finishTour(); }
  setTheme(choice: ThemeChoice): void { this.preferences.setTheme(choice); }
  get fontScale() { return this.preferences.fontScale; }
  setFontScale(scale: FontScale): void { this.preferences.setFontScale(scale); }

  // Updates
  get update() { return this.updater.update; }
  get updateState() { return this.updater.state; }
  get updateError() { return this.updater.error; }
  get updateProgress() { return this.updater.progress; }
  get updateAvailable(): boolean { return this.updater.available; }
  checkUpdates(manual = true): Promise<void> { return this.updater.check(manual); }
  installUpdate(): Promise<void> { return this.updater.install(); }
  skipUpdate(): void { this.updater.skip(); }

  // Leave and close guards
  get settingsDirty() { return this.guards.settingsDirty; }
  set settingsDirty(value) { this.guards.settingsDirty = value; }
  get glossaryGuard() { return this.guards.glossaryGuard; }
  set glossaryGuard(value) { this.guards.glossaryGuard = value; }
  get wizardDirty() { return this.guards.wizardDirty; }
  set wizardDirty(value) { this.guards.wizardDirty = value; }
  get pendingLeave() { return this.guards.pendingLeave; }
  set pendingLeave(value) { this.guards.pendingLeave = value; }
  get pendingReviewLeave() { return this.guards.pendingReviewLeave; }
  get pendingCloseSource() { return this.guards.pendingCloseSource; }
  get pendingCloseContext() { return this.guards.pendingCloseContext; }
  resolveLeave(proceed: boolean): void { this.guards.resolveLeave(proceed); }
  resolveReviewLeave(discard: boolean): void { this.guards.resolveReviewLeave(discard); }
  continueCloseAfterGlossary(...args: Parameters<LeaveGuards['continueCloseAfterGlossary']>): void { this.guards.continueCloseAfterGlossary(...args); }
  continueWizardClose(): void { this.guards.continueWizardClose(); }
  discardWizardAndClose(): void { this.guards.discardWizardAndClose(); }
  finishWizardAndClose(): void { this.guards.finishWizardAndClose(); }

  // Settings and credentials
  get settings() { return this.settingsStore.settings; }
  set settings(value) { this.settingsStore.settings = value; }
  get apiKeyStored() { return this.settingsStore.apiKeyStored; }
  set apiKeyStored(value) { this.settingsStore.apiKeyStored = value; }
  get credentialMode() { return this.settingsStore.credentialMode; }
  set credentialMode(value) { this.settingsStore.credentialMode = value; }
  get settingsRecoveryRequired() { return this.settingsStore.settingsRecoveryRequired; }
  get settingsSaveError() { return this.settingsStore.saveError; }
  clearSettingsSaveError(): void { this.settingsStore.saveError = ''; }
  get credentialRecovery() { return this.settingsStore.credentialRecovery; }
  persistSettings(apiKey = ''): Promise<void> { return this.settingsStore.persist(apiKey); }
  saveSettings(...args: Parameters<SettingsStore['save']>): Promise<boolean> { return this.settingsStore.save(...args); }
  setRunOption(changes: Parameters<SettingsStore['setRunOption']>[0]): Promise<boolean> { return this.settingsStore.setRunOption(changes); }
  setUiLanguage(locale: Locale): Promise<boolean> { return this.settingsStore.setUiLanguage(locale); }
  deleteApiKey(provider?: string): Promise<boolean> { return this.settingsStore.deleteApiKey(provider); }

  // Model catalog
  get models() { return this.modelCatalog.models; }
  get modelsScope() { return this.modelCatalog.scope; }
  get modelsCached() { return this.modelCatalog.cached; }
  get modelsHidden() { return this.modelCatalog.hidden; }
  modelsFor(selection: Settings) { return this.modelCatalog.modelsFor(selection); }
  loadModels(selection?: Settings, force = false): Promise<number> { return this.modelCatalog.load(selection, force); }
  testConnection(...args: Parameters<ModelCatalog['test']>) { return this.modelCatalog.test(...args); }
  checkConnection(...args: Parameters<ModelCatalog['check']>): Promise<number> { return this.modelCatalog.check(...args); }

  // Worlds and backups
  get worldDir() { return this.worlds.worldDir; }
  set worldDir(value) { this.worlds.worldDir = value; }
  get inspection() { return this.worlds.inspection; }
  set inspection(value) { this.worlds.inspection = value; }
  get recent() { return this.worlds.recent; }
  set recent(value) { this.worlds.recent = value; }
  get discovered() { return this.worlds.discovered; }
  get discoveredLoaded() { return this.worlds.discoveredLoaded; }
  get backups() { return this.worlds.backups; }
  set backups(value) { this.worlds.backups = value; }
  loadDiscovered(force = false): Promise<void> { return this.worlds.loadDiscovered(force); }
  openDropped(path: string): Promise<void> { return this.worlds.openDropped(path); }
  chooseWorld(): Promise<void> { return this.worlds.choose(); }
  useWorld(path: string): Promise<void> { return this.worlds.use(path); }
  forgetWorld(path: string): Promise<void> { return this.worlds.forget(path); }
  loadBackups(): Promise<void> { return this.worlds.loadBackups(); }
  restore(backupSetId: string): Promise<boolean> { return this.worlds.restore(backupSetId); }

  // The job of the open world
  get scan() { return this.job.scan; }
  set scan(value) { this.job.scan = value; }
  get candidates() { return this.job.candidates; }
  get excluded() { return this.job.excluded; }
  get overrides() { return this.job.overrides; }
  set overrides(value) { this.job.overrides = value; }
  get estimate() { return this.job.estimate; }
  get estimateLoading() { return this.job.estimateLoading; }
  get failurePolicy() { return this.job.failurePolicy; }
  set failurePolicy(value) { this.job.failurePolicy = value; }
  get progress() { return this.job.progress; }
  get now() { return this.job.now; }
  get cancelling() { return this.job.cancelling; }
  get operation() { return this.job.operation; }
  get result() { return this.job.result; }
  get translationReview() { return this.job.translationReview; }
  get reviewOpen() { return this.job.reviewOpen; }
  set reviewOpen(value) { this.job.reviewOpen = value; }
  get reviewOutcome() { return this.job.reviewOutcome; }
  get reviewResumed() { return this.job.reviewResumed; }
  set reviewResumed(value) { this.job.reviewResumed = value; }
  get failures() { return this.job.failures; }
  get resume() { return this.job.resume; }
  get lastJob() { return this.job.lastJob; }
  set lastJob(value) { this.job.lastJob = value; }
  get lastScan() { return this.job.lastScan; }
  set lastScan(value) { this.job.lastScan = value; }
  get lastRestoreId() { return this.job.lastRestoreId; }
  get candidateCount(): number { return this.job.candidateCount; }
  get manualCount(): number { return this.job.manualCount; }
  get includedCount(): number { return this.job.includedCount; }
  get outgoingCount(): number { return this.job.outgoingCount; }
  get manualOnly(): boolean { return this.job.manualOnly; }
  get tableStatuses(): string[] { return this.job.tableStatuses; }
  manualTranslation(candidate: Candidate): string { return this.job.manualTranslation(candidate); }
  isResumeStatus(status: string): boolean { return this.job.isResumeStatus(status); }
  startScan(): Promise<void> { return this.job.startScan(); }
  loadEstimate(): Promise<void> { return this.job.loadEstimate(); }
  setIncluded(id: string, included: boolean): void { this.job.setIncluded(id, included); }
  setIncludedMany(ids: string[], included: boolean): void { this.job.setIncludedMany(ids, included); }
  undoIncluded(): boolean { return this.job.undoIncluded(); }
  setOverride(id: string, value: string): void { this.job.setOverride(id, value); }
  startTranslate(options?: Parameters<TranslationJob['startTranslate']>[0]): Promise<void> { return this.job.startTranslate(options); }
  retryFailed(options?: Parameters<TranslationJob['retryFailed']>[0]): Promise<void> { return this.job.retryFailed(options); }
  applyTranslations(): Promise<void> { return this.job.applyTranslations(); }
  openReview(): void { this.job.openReview(); }
  closeReview(): void { this.job.closeReview(); }
  openCorrections(): void { this.job.openCorrections(); }
  loadFailures(more = false): Promise<void> { return this.job.loadFailures(more); }
  revealWorld(): Promise<void> { return this.job.revealWorld(); }
  cancel(): Promise<void> { return this.job.cancel(); }
}

export const app = new AppState();
