import { SvelteSet } from 'svelte/reactivity';
import {
  callBackend,
  onProgress,
  onZoomFailed,
  type BackupLocation,
  type BootstrapPayload,
  type Candidate,
  type InterruptedJob,
  type Settings
} from './api';
import { onExitConfirm, onExitStuck, onExitWaiting, onOpenWorld, openExternal, type MenuAction } from './native';
import { clock } from './clock.svelte';
import { hasConsent, rememberConsent } from './local-prefs';
import { setLocale, t, type Locale } from './i18n/index.svelte';
import { detectSystemLocale, isLocale } from './i18n/locale';
import { type ThemeChoice } from './theme';
import type { FontScale } from './font-scale';
import { exceedsCap } from './workflow';
import { normalizedScanOptions } from './settings';
import type { SettingsTab } from './settings-tabs';
import { ExitGate } from './app/exit-gate.svelte';
import { Feedback } from './app/feedback.svelte';
import { LeaveGuards } from './app/guards.svelte';
import { Maintenance } from './app/maintenance.svelte';
import { ModelCatalog } from './app/model-catalog.svelte';
import { setNotifyOnFinish } from './app/notifications';
import { DEFAULT_PREFS, DEFAULT_TARGET, Preferences } from './app/preferences.svelte';
import { Recovery } from './app/recovery.svelte';
import { defaultSettings, SettingsStore } from './app/settings-store.svelte';
import { TranslationJob, type TranslateOptions } from './app/translation-job.svelte';
import { Updater } from './app/updater.svelte';
import { WorldLibrary } from './app/worlds.svelte';
import { numberOr, STEPS, type Busy, type Page, type RunBlocker, type Step } from './app/types';

export type {
  Busy, DiscardReason, DraftState, FailureList, Operation, Page, RunBlocker, Step, Toast, Tone, UpdateState
} from './app/types';
export { DEFAULT_PREFS, DEFAULT_TARGET, STEPS, defaultSettings };

export const ISSUES_URL = 'https://github.com/kim0040/PomiTranslate/issues/new';
/** Menu commands that work while the core failed to start: help pages and links only. */
const STARTUP_SAFE_ACTIONS: MenuAction[] = ['help', 'shortcuts', 'licenses', 'report'];

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

  readonly feedback = new Feedback({
    quitting: () => this.exitGate.quitting,
    keyNeedsReentry: () => { this.settingsStore.keyReentry = true; }
  });
  readonly guards = new LeaveGuards(this);
  readonly preferences = new Preferences(this);
  readonly updater = new Updater(this);
  readonly settingsStore = new SettingsStore(this);
  readonly modelCatalog = new ModelCatalog(this);
  readonly worlds = new WorldLibrary(this);
  readonly job = new TranslationJob(this);
  readonly recovery = new Recovery(this);
  readonly exitGate = new ExitGate(this);
  readonly maintenance = new Maintenance(this);

  private unsubscribe: (() => void)[] = [];
  private listenersStarted = false;
  private consentGiven = new SvelteSet<string>();

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

  /**
   * Everything that stops Start, in the order the screens explain it. Empty means Start works (apart
   * from a job already running). Models and keys are not needed when every sentence is written by hand.
   */
  get runBlockers(): RunBlocker[] {
    const blockers: RunBlocker[] = [];
    if (this.settingsRecoveryRequired) blockers.push('recovery');
    const needsProvider = !this.manualOnly;
    if (this.credentialRecovery.has(this.settings.provider) || (needsProvider && this.credentialStoreError)) blockers.push('credential');
    if (this.interruptedHere.length) blockers.push('interrupted');
    if (needsProvider && !this.hasModel) blockers.push('model');
    if (needsProvider && !this.apiKeyStored && !this.credentialStoreError) blockers.push('key');
    return blockers;
  }

  get canRun(): boolean {
    return !!this.scan && this.scan.status === 'completed' && !this.scan.writeBlockers?.length &&
      this.includedCount > 0 && !this.busy && this.runBlockers.length === 0 && !this.newerPending;
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
  /** A refused request is waiting for the agreement: the only case the review and result screens may offer it. */
  get unpricedRetryPending(): boolean { return this.job.unpricedRetry !== null; }
  consentUnpriced(): Promise<void> { return this.job.consentUnpriced(); }
  get noLimitAcknowledged() { return this.job.noLimitAcknowledged; }
  set noLimitAcknowledged(value: boolean) { this.job.noLimitAcknowledged = value; }

  get isBusy(): boolean {
    return this.busy === 'scan' || this.busy === 'translate' || this.busy === 'restore' || this.busy === 'recovery';
  }

  /** Anything typed or changed that is not saved yet: the desktop shell asks about it when the app is closed. */
  get unsavedWork(): boolean { return this.guards.unsaved; }

  // --- consent to send text to a provider --------------------------------------------------

  /** First run with this provider and model: ask once before sentences leave the computer. */
  get needsConsent(): boolean {
    return !this.manualOnly && !hasConsent(this.settings.provider, this.settings.model) && !this.consentGiven.has(`${this.settings.provider}|${this.settings.model}`);
  }

  grantConsent(): void {
    rememberConsent(this.settings.provider, this.settings.model);
    this.consentGiven.add(`${this.settings.provider}|${this.settings.model}`);
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
        onExitConfirm((prompt) => this.exitGate.ask(prompt)),
        onExitWaiting(() => this.exitGate.waiting()),
        onExitStuck(() => this.exitGate.stuck()),
        onOpenWorld((path) => { void this.openDropped(path); }),
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
      this.credentialMode = boot.credentialMode ?? this.credentialMode;
      this.settingsStore.applyCredentialState(boot.credentialState);
      this.recent = boot.worlds;
      this.worldDir = boot.settings.last_world_dir || '';
      this.inspection = boot.worldInspection;
      this.backups = boot.backups;
      this.recovery.jobs = Array.isArray(boot.interruptedJobs) ? boot.interruptedJobs : [];
      this.preferences.apply(boot);
      if (this.worldDir && this.inspection?.validJavaWorld) this.step = this.interruptedHere.length ? 'world' : 'scan';
      this.job.applyResume(boot.resume, { lastJob: boot.lastJob, lastScan: boot.lastScan });
      // Translations that were never written wait in the review: the user lands back in it.
      if (this.resume?.status === 'awaiting_review' && !this.interruptedHere.length) {
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
    this.job.dispose();
    for (const stop of this.unsubscribe) stop();
    this.unsubscribe = [];
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

  /** Take the person to the key field of the Custom provider (see `keyReentry`). */
  enterKeyAgain(): void {
    this.focusKeyField = true;
    this.settingsTab = 'translate';
    if (this.page === 'settings') return;
    this.openSettingsFor();
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
      this.settingsTab = 'translate';
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
  set banner(value: { tone: 'error' | 'warning'; message: string; action?: 'enter-key' } | null) { this.feedback.banner = value; }
  get banners() { return this.feedback.banners; }
  dismissBanner(id: number): void { this.feedback.dismissBanner(id); }
  get toasts() { return this.feedback.toasts; }
  notify(...args: Parameters<Feedback['notify']>): number { return this.feedback.notify(...args); }
  dismissToast(id: number): void { this.feedback.dismissToast(id); }
  describe(cause: unknown): string { return this.feedback.describe(cause); }
  fail(cause: unknown): void { this.feedback.fail(cause); }
  get dialogDepth() { return this.feedback.dialogDepth; }
  get dialogError() { return this.feedback.dialogError; }
  set dialogError(value: string) { this.feedback.dialogError = value; }
  registerDialog(): () => void { return this.feedback.registerDialog(); }
  get lastError() { return this.feedback.lastError; }

  // Reset, diagnostics
  get resetShortfall() { return this.maintenance.resetShortfall; }
  set resetShortfall(value) { this.maintenance.resetShortfall = value; }
  resetApp(clearKeys: boolean): Promise<boolean> { return this.maintenance.resetApp(clearKeys); }
  resetShortfallLines(...args: Parameters<Maintenance['resetShortfallLines']>): string[] { return this.maintenance.resetShortfallLines(...args); }
  saveDiagnostics(): Promise<void> { return this.maintenance.saveDiagnostics(); }
  copyDiagnostics(): Promise<void> { return this.maintenance.copyDiagnostics(); }
  reportCrash(error: unknown): void { this.maintenance.reportCrash(error); }

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
  get firstRun() { return this.preferences.firstRun; }
  get notificationsSupported() { return this.preferences.notificationsSupported; }
  setPrefs(changes: Parameters<Preferences['setPrefs']>[0]): Promise<void> { return this.preferences.setPrefs(changes); }
  acceptNotice(): void { this.preferences.acceptNotice(); }
  chooseFirstRunLanguage(locale: Locale): void { this.preferences.chooseFirstRunLanguage(locale); }
  setFirstRunTarget(value: string): void { this.preferences.setFirstRunTarget(value); }
  openWizard(): void { this.preferences.openWizard(); }
  dismissWizard(): void { this.preferences.dismissWizard(); }
  finishSetup(openTour = false): void { this.preferences.finishSetup(openTour); }
  saveSetup(changes: Partial<Settings>, apiKey: string): Promise<boolean> { return this.preferences.saveSetup(changes, apiKey); }
  finishTour(): void { this.preferences.finishTour(); }
  setTheme(choice: ThemeChoice): void { this.preferences.setTheme(choice); }
  get fontScale() { return this.preferences.fontScale; }
  setFontScale(scale: FontScale): void { this.preferences.setFontScale(scale); }
  /** The Settings switch. Turning it on asks the system for permission once. */
  setNotifyOnFinish(on: boolean): Promise<void> { return setNotifyOnFinish(this, on); }

  // Updates
  get update() { return this.updater.update; }
  get updateState() { return this.updater.state; }
  get updateError() { return this.updater.error; }
  get updateProgress() { return this.updater.progress; }
  get updateAvailable(): boolean { return this.updater.available; }
  checkUpdates(manual = true): Promise<void> { return this.updater.check(manual); }
  installUpdate(): Promise<void> { return this.updater.install(); }
  skipUpdate(): void { this.updater.skip(); }
  cancelUpdateDownload(): Promise<void> { return this.exitGate.cancelUpdateDownload(); }

  // Leaving the app (the shell's question) and moving between pages (unsaved edits)
  get exitPrompt() { return this.exitGate.prompt; }
  exitStay(): void { this.exitGate.stay(); }
  exitQuit(): Promise<void> { return this.exitGate.quit(); }
  exitSaveAndQuit(): Promise<void> { return this.exitGate.saveAndQuit(); }
  exitKeepWaiting(): Promise<void> { return this.exitGate.keepWaiting(); }
  exitNow(): Promise<void> { return this.exitGate.quitNow(); }
  get settingsDirty() { return this.guards.settingsDirty; }
  set settingsDirty(value) { this.guards.settingsDirty = value; }
  get glossaryDirty() { return this.guards.glossaryDirty; }
  set glossaryDirty(value) { this.guards.glossaryDirty = value; }
  /** Only edits to the translation table are unsaved (no settings, glossary or wizard draft). */
  get reviewOnlyDirty() { return this.guards.reviewOnly; }
  get wizardDirty() { return this.guards.wizardDirty; }
  set wizardDirty(value) { this.guards.wizardDirty = value; }
  get saveDraft() { return this.guards.saveDraft; }
  set saveDraft(value) { this.guards.saveDraft = value; }
  get pendingLeave() { return this.guards.pendingLeave; }
  set pendingLeave(value) { this.guards.pendingLeave = value; }
  get pendingReviewLeave() { return this.guards.pendingReviewLeave; }
  resolveLeave(proceed: boolean): void { this.guards.resolveLeave(proceed); }
  resolveReviewLeave(discard: boolean): void { this.guards.resolveReviewLeave(discard); }

  // Settings and credentials
  get settings() { return this.settingsStore.settings; }
  set settings(value) { this.settingsStore.settings = value; }
  get apiKeyStored() { return this.settingsStore.apiKeyStored; }
  set apiKeyStored(value) { this.settingsStore.apiKeyStored = value; }
  get credentialMode() { return this.settingsStore.credentialMode; }
  set credentialMode(value) { this.settingsStore.credentialMode = value; }
  get credentialStoreError() { return this.settingsStore.credentialStoreError; }
  get settingsRecoveryRequired() { return this.settingsStore.settingsRecoveryRequired; }
  get settingsSaveError() { return this.settingsStore.saveError; }
  clearSettingsSaveError(): void { this.settingsStore.saveError = ''; }
  get credentialRecovery() { return this.settingsStore.credentialRecovery; }
  get keyReentry() { return this.settingsStore.keyReentry; }
  set keyReentry(value) { this.settingsStore.keyReentry = value; }
  get focusKeyField() { return this.settingsStore.focusKeyField; }
  set focusKeyField(value) { this.settingsStore.focusKeyField = value; }
  persistSettings(apiKey = ''): Promise<void> { return this.settingsStore.persist(apiKey); }
  saveSettings(...args: Parameters<SettingsStore['save']>): Promise<boolean> { return this.settingsStore.save(...args); }
  setRunOption(changes: Parameters<SettingsStore['setRunOption']>[0]): Promise<boolean> { return this.settingsStore.setRunOption(changes); }
  setUiLanguage(locale: Locale): Promise<boolean> { return this.settingsStore.setUiLanguage(locale); }
  deleteApiKey(provider?: string): Promise<boolean> { return this.settingsStore.deleteApiKey(provider); }
  resetKeyStorage(): Promise<boolean> { return this.settingsStore.resetKeyStorage(); }

  // Model catalog
  get models() { return this.modelCatalog.models; }
  get modelsLoading() { return this.modelCatalog.loading; }
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
  get backupUsage() { return this.worlds.backupUsage; }
  get backupAdminSupported() { return this.worlds.backupAdminSupported; }
  loadDiscovered(force = false): Promise<void> { return this.worlds.loadDiscovered(force); }
  openDropped(path: string): Promise<void> { return this.worlds.openDropped(path); }
  chooseWorld(): Promise<void> { return this.worlds.choose(); }
  useWorld(path: string): Promise<void> { return this.worlds.use(path); }
  forgetWorld(path: string): Promise<void> { return this.worlds.forget(path); }
  loadBackups(): Promise<void> { return this.worlds.loadBackups(); }
  restore(backupSetId: string): Promise<boolean> { return this.worlds.restore(backupSetId); }
  deleteBackup(backupSetId: string, location?: BackupLocation, acknowledgeLastCopy?: boolean): Promise<boolean> { return this.worlds.deleteBackup(backupSetId, location, acknowledgeLastCopy); }
  pruneBackups(keepLatest: number, location?: BackupLocation): Promise<boolean> { return this.worlds.pruneBackups(keepLatest, location); }
  openFolder(path: string, kind: 'world' | 'other' = 'other'): Promise<void> { return this.worlds.openFolder(path, kind); }

  // Interrupted work
  get interruptedJobs() { return this.recovery.jobs; }
  get interruptedHere(): InterruptedJob[] { return this.recovery.interruptedHere; }
  get recoveryResult() { return this.recovery.result; }
  get recoveryJobId() { return this.recovery.jobId; }
  get highlightedJobId() { return this.recovery.highlightedJobId; }
  set highlightedJobId(value) { this.recovery.highlightedJobId = value; }
  get continuation() { return this.recovery.continuation; }
  recover(...args: Parameters<Recovery['recover']>) { return this.recovery.recover(...args); }
  openInterrupted(): Promise<void> { return this.recovery.openInterrupted(); }
  continueInterrupted(job: InterruptedJob): Promise<void> { return this.recovery.continueInterrupted(job); }
  confirmContinuation(): Promise<void> { return this.recovery.confirmContinuation(); }
  cancelContinuation(): void { this.recovery.cancelContinuation(); }
  closeRecoveryResult(): void { this.recovery.closeResult(); }

  // The job of the open world
  get scan() { return this.job.scan; }
  set scan(value) { this.job.scan = value; }
  get scanAt() { return this.job.scanAt; }
  get candidates() { return this.job.candidates; }
  get excluded() { return this.job.excluded; }
  get overrides() { return this.job.overrides; }
  set overrides(value) { this.job.overrides = value; }
  get effectiveOverrides() { return this.job.effectiveOverrides; }
  get newerAccepted() { return this.job.newerAccepted; }
  set newerAccepted(value) { this.job.newerAccepted = value; }
  get newerPending() { return this.job.newerPending; }
  get estimate() { return this.job.estimate; }
  get estimateLoading() { return this.job.estimateLoading; }
  get failurePolicy() { return this.job.failurePolicy; }
  set failurePolicy(value) { this.job.failurePolicy = value; }
  get progress() { return this.job.progress; }
  get now() { return clock.now; }
  get cancelling() { return this.job.cancelling; }
  get starting() { return this.job.starting; }
  get operation() { return this.job.operation; }
  get result() { return this.job.result; }
  get resultAt() { return this.job.resultAt; }
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
  startTranslate(options?: TranslateOptions): Promise<void> { return this.job.startTranslate(options); }
  translateAgain(): void { this.job.translateAgain(); }
  retryFailed(options?: Parameters<TranslationJob['retryFailed']>[0]): Promise<void> { return this.job.retryFailed(options); }
  applyTranslations(): Promise<void> { return this.job.applyTranslations(); }
  discardResume(): Promise<boolean> { return this.job.discardResume(); }
  openReview(): void { this.job.openReview(); }
  closeReview(): void { this.job.closeReview(); }
  openCorrections(): void { this.job.openCorrections(); }
  loadFailures(more = false): Promise<void> { return this.job.loadFailures(more); }
  revealWorld(): Promise<void> { return this.job.revealWorld(); }
  cancel(): Promise<void> { return this.job.cancel(); }

  // The review draft (choices made before translating)
  get draftState() { return this.job.draft.state; }
  get draftCount(): number { return this.job.draft.count; }
  get draftNeedsConfirm(): boolean { return this.job.draft.needsConfirm; }
  get reviewVersion() { return this.job.draft.version; }
  get discardPrompt() { return this.job.draft.prompt; }
  mayDiscard(...args: Parameters<ReviewDraftLike['mayDiscard']>) { return this.job.draft.mayDiscard(...args); }
  answerDiscard(agreed: boolean): void { this.job.draft.answer(agreed); }
  storeReview(force = false): Promise<boolean> { return this.job.draft.store(force); }
}

type ReviewDraftLike = TranslationJob['draft'];

export const app = new AppState();
