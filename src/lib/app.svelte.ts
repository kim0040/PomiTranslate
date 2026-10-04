import { SvelteSet } from 'svelte/reactivity';
import { open } from '@tauri-apps/plugin-dialog';
import {
  BackendError,
  callBackend,
  cancelBackend,
  type CredentialMode,
  onCloseBlocked,
  onZoomFailed,
  onProgress,
  type BackupSummary,
  type BootstrapPayload,
  type Estimate,
  type ModelInfo,
  type Notices,
  type RecentWorld,
  type ResumeStatus,
  type ScanResult,
  type Settings,
  type TranslationResult,
  type TranslationCounts,
  type TranslationPageMeta,
  type TranslationRow,
  type DiscoveredWorld,
  type AppPrefs,
  type WorldInspection
} from './api';
import { checkForUpdate, installUpdate, onUpdateProgress, openExternal, revealWorldFolder, type MenuAction, type UpdateInfo } from './native';
import { resourcePackOptions } from './resource-pack';
import { CandidateSource } from './candidates.svelte';
import { hasMessage, setLocale, t, type Locale, type MessageKey } from './i18n/index.svelte';
import { applyTheme, type ThemeChoice } from './theme';
import { editErrors, emptyProgress, exceedsCap, reduceProgress, RESUMABLE_STATUSES, type JobProgress } from './workflow';
import { fetchTranslationPage, TranslationReview } from './translation-review.svelte';
import { normalizedScanOptions, scanOptionsSignature } from './settings';

export type Page = 'workspace' | 'backups' | 'settings' | 'about' | 'help';
export type Step = 'world' | 'scan' | 'review' | 'run' | 'result';
export type Busy = '' | 'loading' | 'scan' | 'translate' | 'restore' | 'models' | 'prompt' | 'settings' | 'usage';
export type Tone = 'info' | 'success' | 'error';

export const STEPS: Step[] = ['world', 'scan', 'review', 'run', 'result'];

export const defaultSettings = (): Settings => ({
  provider: 'openai', model: '', base_url: '', wire_format: 'openai', target_language: '한국어', style_preset: 'neutral',
  openrouter_reasoning: 'default', style_prompt: '', custom_system_prompt: '', temperature: 0.3, batch_size: 40, request_timeout: 120, rpm_limit: 0,
  tpm_limit: 0, max_batch_retries: 3, concurrency: 4, resource_pack_enabled: false, resource_pack_options: resourcePackOptions(), external_resource_pack_paths: [], skip_target_language_text: true,
  max_file_write_retries: 2, continue_on_file_error: true, review_before_apply: true, max_cost_usd: 0, source_overrides: {},
  ui_language: 'ko', last_world_dir: '', scan_options: normalizedScanOptions()
});

const NOTICE_KEY = 'pomi.notice.v1';
const PROVIDERS = ['openai', 'gemini', 'anthropic', 'openrouter', 'comet', 'custom'];
export const ISSUES_URL = 'https://github.com/kim0040/PomiTranslate/issues/new';
const DAY = 24 * 60 * 60;
export const DEFAULT_PREFS: AppPrefs = {
  theme: 'system', notice_accepted: false, tutorial_seen: false,
  update_auto_check: true, update_last_check: 0, update_skipped_version: ''
};
export type UpdateState = 'idle' | 'checking' | 'installing' | 'error';
/** Menu commands that work while the core failed to start: help pages and links only. */
const STARTUP_SAFE_ACTIONS: MenuAction[] = ['help', 'shortcuts', 'licenses', 'report'];
const RESUMABLE = RESUMABLE_STATUSES;
/** Statuses after which the sidecar may hold a saved translation table worth listing. */
const TABLE_STATUSES = ['completed', 'partial', 'failed', 'needs_retry', 'cancelled', 'budget_stopped'];
/** What a running translate-type operation is, so the progress screen can say it. */
export type Operation = 'translate' | 'resume' | 'retry' | 'apply' | 'reapply';
/** The full list of failed rows the result screen shows, loaded from the saved table. */
export type FailureList = {
  loading: boolean;
  /** Null until known; false when the sidecar holds no saved table for this job. */
  checkpoint: boolean | null;
  rows: TranslationRow[];
  total: number;
  counts: TranslationCounts | null;
  meta: TranslationPageMeta | null;
};
const emptyFailures = (): FailureList => ({ loading: false, checkpoint: null, rows: [], total: 0, counts: null, meta: null });
const FAILURE_PAGE = 50;
/** Settings that change which text a scan finds. Changing one makes a reviewed scan stale. */
const SCOPE_KEYS: (keyof Settings)[] = ['target_language', 'resource_pack_enabled', 'skip_target_language_text'];

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value !== '' && value !== null && value !== undefined ? parsed : fallback;
}

export class AppState {
  ready = $state(false);
  startupFailed = $state(false);
  page = $state<Page>('workspace');
  step = $state<Step>('world');
  busy = $state<Busy>('');
  cancelling = $state(false);
  theme = $state<ThemeChoice>('system');
  notices = $state<Notices | null>(null);
  showNotice = $state(false);
  /** App state saved with the settings file; the web view's storage is only a fast copy. */
  prefs = $state<AppPrefs>({ ...DEFAULT_PREFS });
  showTour = $state(false);
  showLicenses = $state(false);
  /** A section of the help page to bring into view (set by the Help menu). */
  helpSection = $state('');
  update = $state<UpdateInfo | null>(null);
  updateState = $state<UpdateState>('idle');
  updateError = $state('');
  updateProgress = $state<{ downloaded: number; total: number | null } | null>(null);
  banner = $state<{ tone: 'error' | 'warning'; message: string } | null>(null);
  toasts = $state<{ id: number; tone: Tone; message: string }[]>([]);
  railCollapsed = $state(false);
  /** Set by the settings screen while it holds changes that are not saved yet. */
  settingsDirty = $state(false);
  /** A move away from settings that waits until the user saves or drops the changes there. */
  pendingLeave = $state<(() => void) | null>(null);
  /** The workflow step that sent the user to settings, so settings can offer the way back. */
  returnStep = $state<Step | null>(null);

  settings = $state<Settings>(defaultSettings());
  apiKeyStored = $state(false);
  credentialMode = $state<CredentialMode>('local');
  settingsRecoveryRequired = $state(false);
  credentialRecovery = new SvelteSet<string>();
  private settingsRecoveryRevision = 0;
  models = $state<ModelInfo[]>([]);
  modelsScope = $state('');
  modelsCached = $state(false);
  private modelCatalogs = new Map<string, { models: ModelInfo[]; fetchedAt: number; cached: boolean }>();

  worldDir = $state('');
  inspection = $state<WorldInspection | null>(null);
  recent = $state<RecentWorld[]>([]);
  discovered = $state<DiscoveredWorld[]>([]);
  discoveredLoaded = $state(false);
  backups = $state<BackupSummary[]>([]);

  scan = $state<ScanResult | null>(null);
  candidates = new CandidateSource(() => ({
    excluded: [...this.excluded],
    manual: Object.entries(this.overrides).filter(([, value]) => value.trim()).map(([id]) => id)
  }));
  excluded = new SvelteSet<string>();
  overrides = $state<Record<string, string>>({});
  estimate = $state<Estimate | null>(null);
  /** True while a newer estimate is on its way, so screens can say "calculating" instead of "unknown". */
  estimateLoading = $state(false);
  failurePolicy = $state<'stop' | 'skip'>('stop');

  progress = $state<JobProgress>(emptyProgress());
  /** The one clock the sidebar and the run screen both read, so their timers never drift apart. */
  now = $state(Date.now());
  operation = $state<Operation>('translate');
  result = $state<TranslationResult | null>(null);
  /** The translation table of the current job: rows from the sidecar plus the user's unsaved edits. */
  translationReview = new TranslationReview(() => (this.scan && this.worldDir ? { worldDir: this.worldDir, scanPlanId: this.scan.scanPlanId } : null));
  /** The review view is showing (in the run step before applying, or in the result step for corrections). */
  reviewOpen = $state(false);
  /** Counts and usage of the run that stopped for review. */
  reviewOutcome = $state<TranslationResult | null>(null);
  /** The review was reopened from a saved job at start-up, so it says where the translations came from. */
  reviewResumed = $state(false);
  failures = $state<FailureList>(emptyFailures());
  resume = $state<ResumeStatus | null>(null);
  /** The recovery snapshot of the last restore, until the next scan or world change replaces the job. */
  lastRestoreId = $state('');

  private toastSerial = 0;
  private clock: ReturnType<typeof setInterval> | null = null;
  private failuresRevision = 0;
  private estimateRevision = 0;
  private unsubscribe: (() => void)[] = [];
  private listenersStarted = false;
  private destroyed = false;

  // --- derived numbers used across screens ---------------------------------------------------

  get locale(): Locale {
    return (this.settings.ui_language as Locale) || 'ko';
  }

  get candidateCount(): number {
    return this.scan?.candidateCount ?? 0;
  }

  get manualCount(): number {
    if (this.estimate && Object.keys(this.settings.source_overrides ?? {}).length) return Math.max(0, this.includedCount - this.estimate.candidateCount);
    return Object.entries(this.overrides).filter(([id, value]) => value.trim() && !this.excluded.has(id)).length;
  }

  manualTranslation(candidate: import('./api').Candidate): string {
    const saved = this.settings.source_overrides ?? {};
    return this.overrides[candidate.id] ?? (Object.hasOwn(saved, candidate.source) ? saved[candidate.source] : '');
  }

  get includedCount(): number {
    return Math.max(0, this.candidateCount - this.excluded.size);
  }

  /** Sentences that will go to the provider: included and not written by hand. */
  get outgoingCount(): number {
    return Math.max(0, this.includedCount - this.manualCount);
  }

  get manualOnly(): boolean {
    return this.includedCount > 0 && this.manualCount === this.includedCount;
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

  get isBusy(): boolean {
    return this.busy === 'scan' || this.busy === 'translate' || this.busy === 'restore';
  }

  // --- feedback ----------------------------------------------------------------------------

  notify(message: string, tone: Tone = 'info', ms = 5200): void {
    const id = ++this.toastSerial;
    this.toasts = [...this.toasts, { id, tone, message }];
    if (ms > 0) setTimeout(() => this.dismissToast(id), ms);
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((toast) => toast.id !== id);
  }

  /** A readable message for a failed call. Codes the shell or core sent map to catalog text. */
  describe(cause: unknown): string {
    if (cause instanceof BackendError) {
      const key = `error.${cause.code}`;
      if (cause.code === 'BUSY') return t('error.busy');
      if (hasMessage(key)) return t(key as MessageKey);
      return cause.message || t('error.default');
    }
    return cause instanceof Error ? cause.message : t('error.default');
  }

  fail(cause: unknown): void {
    this.banner = { tone: 'error', message: this.describe(cause) };
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
        onProgress((event) => this.handleProgress(event)),
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
      this.settings = { ...defaultSettings(), ...boot.settings };
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
      this.applyPrefs(boot);
      if (this.worldDir && this.inspection?.validJavaWorld) this.step = 'scan';
      this.applyResume(boot.resume);
      // Translations that were never written wait in the review: the user lands back in it.
      if (this.resume?.status === 'awaiting_review') {
        this.reviewResumed = true;
        this.openReview();
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
    if (this.prefsRetry) clearTimeout(this.prefsRetry);
    this.stopClock();
    for (const stop of this.unsubscribe) stop();
    this.unsubscribe = [];
  }

  /**
   * Read the saved app state. A build before this one kept the theme and the notice answer only in
   * the web view's storage; when the settings file has none yet, that answer is carried over once.
   */
  private applyPrefs(boot: BootstrapPayload): void {
    const saved = { ...DEFAULT_PREFS, ...(boot.prefs ?? {}) };
    if (!boot.settings.app_prefs) {
      let acceptedBefore = false;
      try { acceptedBefore = localStorage.getItem(NOTICE_KEY) === 'accepted'; } catch { /* no storage */ }
      const carried: Partial<AppPrefs> = {};
      if (acceptedBefore) Object.assign(carried, { notice_accepted: true, tutorial_seen: true });
      if (this.theme !== 'system') carried.theme = this.theme;
      Object.assign(saved, carried);
      if (Object.keys(carried).length) void this.setPrefs(carried);
    }
    this.prefs = saved;
    if (saved.theme !== this.theme) this.setThemeOnly(saved.theme);
    this.showNotice = !saved.notice_accepted;
    this.showTour = saved.notice_accepted && !saved.tutorial_seen;
    if (saved.update_auto_check && Date.now() / 1000 - saved.update_last_check > DAY) {
      setTimeout(() => void this.checkUpdates(false), 4000);
    }
  }

  private unsavedPrefs: Partial<AppPrefs> = {};
  private prefsRetry: ReturnType<typeof setTimeout> | null = null;

  /**
   * Save app state. The change applies at once. While a scan, translation or restore holds the core
   * the save cannot run, so it is kept and retried until it lands; otherwise the next launch would
   * read the older value from the settings file.
   */
  async setPrefs(changes: Partial<AppPrefs>): Promise<void> {
    this.prefs = { ...this.prefs, ...changes };
    const pending = { ...this.unsavedPrefs, ...changes };
    this.unsavedPrefs = {};
    try {
      const saved = await callBackend<{ prefs: AppPrefs }>('prefs.set', { prefs: pending });
      this.prefs = { ...this.prefs, ...saved.prefs, ...this.unsavedPrefs };
    } catch {
      this.unsavedPrefs = { ...pending, ...this.unsavedPrefs };
      if (!this.prefsRetry && !this.destroyed) {
        this.prefsRetry = setTimeout(() => {
          this.prefsRetry = null;
          if (Object.keys(this.unsavedPrefs).length) void this.setPrefs({});
        }, 3000);
      }
    }
  }

  acceptNotice(): void {
    try { localStorage.setItem(NOTICE_KEY, 'accepted'); } catch { /* the settings file is the record */ }
    this.showNotice = false;
    if (!this.prefs.tutorial_seen) this.showTour = true;
    void this.setPrefs({ notice_accepted: true });
  }

  finishTour(): void {
    this.showTour = false;
    if (!this.prefs.tutorial_seen) void this.setPrefs({ tutorial_seen: true });
  }

  private setThemeOnly(choice: ThemeChoice): void {
    this.theme = choice;
    applyTheme(choice);
  }

  setTheme(choice: ThemeChoice): void {
    this.setThemeOnly(choice);
    void this.setPrefs({ theme: choice });
  }

  // --- updates -----------------------------------------------------------------------------

  /** Check the release feed. A manual check reports every outcome; an automatic one stays quiet. */
  async checkUpdates(manual = true): Promise<void> {
    if (this.updateState === 'checking' || this.updateState === 'installing') return;
    this.updateState = 'checking';
    this.updateError = '';
    try {
      const info = await checkForUpdate();
      this.update = info;
      this.updateState = 'idle';
      void this.setPrefs({ update_last_check: Math.floor(Date.now() / 1000) });
      if (!manual && info.status === 'available' && info.version !== this.prefs.update_skipped_version) {
        this.notify(t('update.availableToast', { version: info.version ?? '' }), 'info', 9000);
      }
    } catch (cause) {
      this.updateState = manual ? 'error' : 'idle';
      this.updateError = cause instanceof Error ? cause.message : String(cause);
    }
  }

  get updateAvailable(): boolean {
    return this.update?.status === 'available' && this.update.version !== this.prefs.update_skipped_version;
  }

  async installUpdate(): Promise<void> {
    if (this.isBusy || this.updateState === 'installing') return;
    this.updateState = 'installing';
    this.updateError = '';
    this.updateProgress = { downloaded: 0, total: null };
    let stop: (() => void) | null = null;
    try {
      stop = await onUpdateProgress((downloaded, total) => { this.updateProgress = { downloaded, total }; }).catch(() => null);
      await installUpdate();
    } catch (cause) {
      this.updateState = 'error';
      this.updateError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      stop?.();
    }
  }

  skipUpdate(): void {
    if (this.update?.version) void this.setPrefs({ update_skipped_version: this.update.version });
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

  /**
   * Leave the current page. Unsaved settings are never dropped silently: the move waits until the
   * settings screen asks whether to save them, drop them, or stay.
   */
  private leave(next: () => void): void {
    const run = () => {
      if (this.page === 'settings') this.returnStep = null;
      next();
    };
    if (this.page === 'settings' && this.settingsDirty) this.pendingLeave = run;
    else run();
  }

  /** Answer for a move that waited on unsaved settings. */
  resolveLeave(proceed: boolean): void {
    const next = this.pendingLeave;
    this.pendingLeave = null;
    if (!proceed || !next) return;
    this.settingsDirty = false;
    next();
  }

  goto(page: Page): void {
    if (this.busy === 'settings' || page === this.page) return;
    this.leave(() => { this.page = page; });
  }

  goStep(step: Step): void {
    if (!this.ready || this.startupFailed || !this.stepReached[step] || this.isBusy) return;
    if (this.page === 'workspace') {
      this.step = step;
      return;
    }
    this.leave(() => {
      this.page = 'workspace';
      this.step = step;
    });
  }

  /** Open settings to fix something the current step needs; settings then offers the way back. */
  openSettingsFor(step: Step = this.step): void {
    if (this.busy === 'settings') return;
    this.returnStep = this.page === 'workspace' ? step : null;
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
      this.leave(() => {
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
      this.goto('settings');
      void this.checkUpdates(true);
    } else if (action === 'find') {
      if (this.page !== 'workspace' || this.step !== 'review') return;
      const search = document.getElementById('review-search') as HTMLInputElement | null;
      search?.focus();
      search?.select();
    }
  }

  // --- worlds ------------------------------------------------------------------------------

  /** Worlds the game launchers keep. Read-only and best effort: an empty list is not an error. */
  async loadDiscovered(force = false): Promise<void> {
    if (this.discoveredLoaded && !force) return;
    try {
      this.discovered = (await callBackend<{ worlds: DiscoveredWorld[] }>('worlds.discover')).worlds ?? [];
    } catch {
      this.discovered = [];
    } finally {
      this.discoveredLoaded = true;
    }
  }

  /** A folder dropped on the window opens like one chosen in the folder dialog. */
  async openDropped(path: string): Promise<void> {
    if (!this.ready || this.startupFailed) return;
    if (this.isBusy) {
      this.notify(t('world.dropBusy'), 'info');
      return;
    }
    this.leave(() => {
      this.page = 'workspace';
      void this.useWorld(path);
    });
  }

  private resetJob(): void {
    this.lastRestoreId = '';
    this.estimateRevision++;
    this.estimateLoading = false;
    this.scan = null;
    this.candidates.reset('');
    this.excluded.clear();
    this.overrides = {};
    this.estimate = null;
    this.result = null;
    this.progress = emptyProgress();
    this.resume = null;
    this.reviewOpen = false;
    this.reviewResumed = false;
    this.reviewOutcome = null;
    this.translationReview.clear();
    this.failuresRevision++;
    this.failures = emptyFailures();
  }

  async chooseWorld(): Promise<void> {
    this.banner = null;
    try {
      const chosen = await open({ directory: true, multiple: false, title: t('world.open') });
      if (typeof chosen === 'string') await this.useWorld(chosen);
    } catch (cause) {
      this.fail(cause);
    }
  }

  async useWorld(path: string): Promise<void> {
    if (this.isBusy) return;
    this.banner = null;
    try {
      const inspected = await callBackend<WorldInspection>('world.inspect', { worldDir: path });
      if (!inspected.validJavaWorld) {
        this.banner = { tone: 'error', message: t('world.invalid') };
        return;
      }
      const changed = path !== this.worldDir;
      this.worldDir = path;
      this.inspection = inspected;
      if (changed) this.resetJob();
      this.recent = (await callBackend<{ worlds: RecentWorld[] }>('worlds.remember', { worldDir: path })).worlds;
      await this.loadBackups();
      if (changed) this.applyResume(await callBackend<ResumeStatus>('resume.status', { worldDir: path }));
      this.step = 'world';
    } catch (cause) {
      this.fail(cause);
    }
  }

  async forgetWorld(path: string): Promise<void> {
    try {
      this.recent = (await callBackend<{ worlds: RecentWorld[] }>('worlds.forget', { worldDir: path })).worlds;
      if (this.worldDir === path) {
        this.worldDir = '';
        this.inspection = null;
        this.backups = [];
        this.resetJob();
        this.step = 'world';
      }
    } catch (cause) {
      this.fail(cause);
    }
  }

  async loadBackups(): Promise<void> {
    if (!this.worldDir) {
      this.backups = [];
      return;
    }
    this.backups = (await callBackend<{ backups: BackupSummary[] }>('backups.list', { worldDir: this.worldDir })).backups;
  }

  // --- resume ------------------------------------------------------------------------------

  private applyResume(resumable: ResumeStatus): void {
    if (!resumable?.available || !resumable.scanPlanId || !resumable.fingerprint) {
      this.resume = null;
      return;
    }
    this.scan = {
      status: 'completed',
      candidateCount: resumable.candidateCount || 0,
      occurrenceCount: resumable.occurrenceCount,
      kinds: resumable.kinds,
      coverage: resumable.coverage,
      providerRequests: 0,
      fingerprint: resumable.fingerprint,
      scanPlanId: resumable.scanPlanId,
      dryRun: true,
      candidates: resumable.candidates || []
    };
    this.excluded.clear();
    for (const id of resumable.excludedCandidateIds || []) this.excluded.add(id);
    this.overrides = { ...(resumable.candidateOverrides || {}) };
    this.resume = resumable;
    this.candidates.reset(resumable.scanPlanId, resumable.candidates, resumable.candidateCount);
    void this.loadEstimate();
  }

  // --- scan --------------------------------------------------------------------------------

  async startScan(): Promise<void> {
    if (!this.worldDir || this.isBusy) return;
    this.busy = 'scan';
    this.banner = null;
    this.resetJob();
    this.progress = { ...emptyProgress(), phase: 'collect', startedAt: Date.now() };
    this.startClock();
    try {
      await this.persistSettings();
      this.scan = await callBackend<ScanResult>('scan.start', { worldDir: this.worldDir });
      this.estimate = this.scan.estimate ?? null;
      this.candidates.reset(this.scan.scanPlanId, this.scan.candidates, this.scan.candidateCount);
    } catch (cause) {
      this.fail(cause);
    } finally {
      this.busy = '';
      this.stopClock();
      this.progress = emptyProgress();
    }
  }

  async loadEstimate(): Promise<void> {
    if (!this.scan) return;
    const revision = ++this.estimateRevision;
    const planId = this.scan.scanPlanId;
    const signature = this.estimateSignature();
    this.estimate = null;
    this.estimateLoading = true;
    try {
      const estimate = await callBackend<Estimate>('estimate.get', {
        scanPlanId: planId,
        excludedCandidateIds: [...this.excluded],
        overrideCandidateIds: Object.entries(this.overrides).filter(([, value]) => value.trim()).map(([id]) => id)
      });
      if (revision === this.estimateRevision && signature === this.estimateSignature()) this.estimate = estimate;
    } catch {
      // An unavailable estimate stays unknown; stale costs must not describe new choices.
    } finally {
      if (revision === this.estimateRevision) this.estimateLoading = false;
    }
  }

  private estimateSignature(): string {
    return JSON.stringify([this.scan?.scanPlanId, this.settings, [...this.excluded].sort(),
      Object.entries(this.overrides).filter(([, value]) => value.trim()).map(([id]) => id).sort()]);
  }

  setIncluded(id: string, included: boolean): void {
    this.estimate = null;
    if (included) this.excluded.delete(id);
    else this.excluded.add(id);
  }

  setOverride(id: string, value: string): void {
    this.estimate = null;
    const next = { ...this.overrides };
    if (value) next[id] = value;
    else delete next[id];
    this.overrides = next;
  }

  // --- translate ---------------------------------------------------------------------------

  private handleProgress(event: import('./api').ProgressEvent): void {
    this.progress = reduceProgress(this.progress, event);
  }

  private startClock(): void {
    this.now = Date.now();
    if (!this.clock) this.clock = setInterval(() => { this.now = Date.now(); }, 500);
  }

  private stopClock(): void {
    if (this.clock) clearInterval(this.clock);
    this.clock = null;
  }

  private get guarded(): boolean {
    return !this.scan || this.isBusy || this.settingsRecoveryRequired || this.credentialRecovery.has(this.settings.provider);
  }

  /**
   * Run one translate-type request with the progress screen up. Returns the outcome, or null when it
   * was refused (the banner says why and the step goes back to where the request started).
   */
  private async runOperation(
    kind: Operation,
    request: () => Promise<TranslationResult>,
    options: { persist: boolean; keepResult: boolean }
  ): Promise<TranslationResult | null> {
    const origin = this.step;
    this.operation = kind;
    this.busy = 'translate';
    this.cancelling = false;
    this.banner = null;
    if (!options.keepResult) this.result = null;
    this.step = 'run';
    this.progress = { ...emptyProgress(), phase: 'collect', startedAt: Date.now() };
    this.startClock();
    try {
      if (options.persist) await this.persistSettings();
      return await request();
    } catch (cause) {
      if (cause instanceof BackendError && cause.code === 'EDITS_INVALID') {
        this.translationReview.setRefused(editErrors(cause.details));
        this.reviewOpen = true;
      }
      this.fail(cause);
      this.step = kind === 'translate' || kind === 'resume' ? (this.scan ? 'run' : 'scan') : origin;
      return null;
    } finally {
      this.busy = '';
      this.cancelling = false;
      this.stopClock();
      this.progress = emptyProgress();
    }
  }

  private get identity() {
    return { worldDir: this.worldDir, scanPlanId: this.scan!.scanPlanId };
  }

  async startTranslate(options: { resume?: boolean; budgetOverride?: boolean } = {}): Promise<void> {
    if (this.guarded) return;
    const kind: Operation = options.resume ? 'resume' : 'translate';
    const hadResume = !!this.resume;
    const outcome = await this.runOperation(kind, () => callBackend<TranslationResult>(options.resume ? 'translate.resume' : 'translate.start', {
      worldDir: this.worldDir,
      fingerprint: this.scan!.fingerprint,
      scanPlanId: this.scan!.scanPlanId,
      excludedCandidateIds: [...this.excluded],
      candidateOverrides: this.overrides,
      manualOnly: this.manualOnly,
      provider: this.settings.provider,
      model: this.settings.model,
      ...(this.settings.provider === 'custom' ? { baseUrl: this.settings.base_url } : {}),
      wireFormat: this.settings.wire_format,
      failurePolicy: this.failurePolicy,
      ...(options.budgetOverride ? { budgetOverride: true } : {})
    }), { persist: true, keepResult: false });
    if (outcome) {
      // A new translation replaces the job, so edits made to an older one no longer apply.
      if (!options.resume) this.translationReview.clear();
      await this.settle(outcome);
    } else if (!options.resume && hadResume) {
      // Starting over drops the saved checkpoint; ask what is left rather than offer a stale resume.
      void callBackend<ResumeStatus>('resume.status', { worldDir: this.worldDir })
        .then((resumable) => this.applyResume(resumable))
        .catch(() => { this.resume = null; });
    }
  }

  /** Send only the failed and unsent rows to the AI again. The result comes back for review. */
  async retryFailed(options: { budgetOverride?: boolean } = {}): Promise<void> {
    if (this.guarded) return;
    const outcome = await this.runOperation('retry', () => callBackend<TranslationResult>('translate.retry_failed', {
      ...this.identity,
      provider: this.settings.provider,
      model: this.settings.model,
      ...(options.budgetOverride ? { budgetOverride: true } : {})
    }), { persist: true, keepResult: true });
    if (outcome) await this.settle(outcome);
  }

  /** Write the reviewed translations (and edits) into the world. No AI request is sent. */
  async applyTranslations(): Promise<void> {
    if (this.guarded) return;
    const review = this.translationReview;
    const corrections = !!review.meta?.applied;
    const outcome = await this.runOperation(corrections ? 'reapply' : 'apply', () => callBackend<TranslationResult>(corrections ? 'translate.reapply' : 'translate.apply', {
      ...this.identity,
      fingerprint: this.scan!.fingerprint,
      edits: review.edits()
    }), { persist: false, keepResult: true });
    if (outcome) await this.settle(outcome);
  }

  /** Handle what a translate-type request returned: into the review, or onto the result screen. */
  private async settle(outcome: TranslationResult): Promise<void> {
    this.reviewResumed = false;
    if (outcome.status === 'awaiting_review') {
      this.reviewOutcome = outcome;
      this.step = 'run';
      this.reviewOpen = true;
      this.translationReview.reset();
    } else {
      this.result = outcome;
      this.reviewOutcome = null;
      this.reviewOpen = false;
      this.step = 'result';
      if (outcome.status === 'completed' || outcome.status === 'partial') this.translationReview.settle();
      this.failuresRevision++;
      this.failures = emptyFailures();
    }
    try { await this.loadBackups(); } catch { /* the backup list refreshes when its page opens */ }
    if (RESUMABLE.includes(outcome.status)) {
      try {
        this.applyResume(await callBackend<ResumeStatus>('resume.status', { worldDir: this.worldDir }));
        // A resumed job keeps its reviewed choices: applyResume rebuilds them from the checkpoint.
      } catch { /* the result screen offers a fresh start instead */ }
    } else {
      this.resume = null;
    }
  }

  /** Show the translation table of the current job, in the step the user is on (run, or result for corrections). */
  openReview(): void {
    if (!this.scan) return;
    if (this.step !== 'result') this.step = 'run';
    this.reviewOpen = true;
    if (!this.translationReview.loaded) this.translationReview.reset();
  }

  closeReview(): void {
    this.reviewOpen = false;
  }

  /** Correct translations after the world was written: the same table over the applied job. */
  openCorrections(): void {
    this.translationReview.clear();
    this.reviewOpen = true;
    this.translationReview.reset();
  }

  /** Load failed rows from the saved table, 50 at a time. */
  async loadFailures(more = false): Promise<void> {
    if (!this.scan || !this.worldDir) return;
    const revision = more ? this.failuresRevision : ++this.failuresRevision;
    const offset = more ? this.failures.rows.length : 0;
    if (!more) this.failures = { ...emptyFailures(), loading: true };
    else this.failures.loading = true;
    try {
      const page = await fetchTranslationPage(this.identity, { state: 'failed', offset, limit: FAILURE_PAGE });
      if (revision !== this.failuresRevision) return;
      this.failures = {
        loading: false, checkpoint: true, rows: more ? [...this.failures.rows, ...page.rows] : page.rows,
        total: page.total, counts: page.counts, meta: page.meta
      };
    } catch {
      if (revision !== this.failuresRevision) return;
      // No saved table for this job: only a fresh translation is possible.
      this.failures = { ...emptyFailures(), checkpoint: false };
    }
  }

  get tableStatuses(): string[] {
    return TABLE_STATUSES;
  }

  /** Save one of the options on the run screen without touching anything else the settings screen holds. */
  async setRunOption(changes: Partial<Pick<Settings, 'review_before_apply' | 'max_cost_usd'>>): Promise<boolean> {
    if (this.busy) return false;
    const before = { review_before_apply: this.settings.review_before_apply, max_cost_usd: this.settings.max_cost_usd };
    this.busy = 'settings';
    this.settings = { ...this.settings, ...changes };
    try {
      await this.persistSettings();
      if (this.scan) void this.loadEstimate();
      return true;
    } catch (cause) {
      this.settings = { ...this.settings, ...before };
      this.fail(cause);
      return false;
    } finally {
      this.busy = '';
    }
  }

  async revealWorld(): Promise<void> {
    try {
      await revealWorldFolder(this.worldDir);
    } catch (cause) {
      this.fail(cause);
    }
  }

  async cancel(): Promise<void> {
    if (!this.isBusy || this.cancelling) return;
    try {
      if (await cancelBackend()) this.cancelling = true;
    } catch (cause) {
      this.fail(cause);
    }
  }

  // --- backups -----------------------------------------------------------------------------

  async restore(backupSetId: string): Promise<boolean> {
    if (!this.worldDir || this.isBusy) return false;
    this.busy = 'restore';
    this.banner = null;
    this.startClock();
    try {
      const restored = await callBackend<{ status: string; recoverySetId: string }>('restore.start', {
        worldDir: this.worldDir,
        backupSetId
      });
      if (restored.status !== 'restored' || !restored.recoverySetId) {
        throw new Error(t('backups.restoreUnconfirmed'));
      }
      this.resetJob();
      // Set after the reset: the scan and backup pages say why the reviewed scan is gone.
      this.lastRestoreId = restored.recoverySetId;
      this.step = 'scan';
      await this.loadBackups();
      this.notify(t('backups.restoreDone'), 'success', 9000);
      return true;
    } catch (cause) {
      this.fail(cause);
      return false;
    } finally {
      this.busy = '';
      this.stopClock();
    }
  }

  // --- settings ----------------------------------------------------------------------------

  /** Write the current settings, and a new API key when one was typed. Never keeps the key. */
  async persistSettings(apiKey = ''): Promise<void> {
    const s = this.settings;
    if (this.credentialRecovery.has(s.provider) && !apiKey) throw new BackendError('', 'CREDENTIAL_SAVE_UNCERTAIN');
    let saved: { settings: Settings; apiKeyStored: boolean; credentialMode: CredentialMode };
    try {
      saved = await callBackend('settings.set', {
        worldDir: this.worldDir,
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
      if (cause instanceof BackendError && ['SETTINGS_RECONCILIATION_REQUIRED', 'CREDENTIAL_SAVE_UNCERTAIN'].includes(cause.code)) await this.recoverSettings();
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
  private async recoverSettings(): Promise<void> {
    this.settingsRecoveryRequired = true;
    this.settingsRecoveryRevision += 1;
    this.resetJob();
    if (this.worldDir) this.step = 'scan';
    try {
      const saved = await callBackend<{ settings: Settings; apiKeyStored: boolean; credentialMode: CredentialMode }>('settings.get');
      this.settings = { ...defaultSettings(), ...saved.settings };
      this.settings.scan_options = normalizedScanOptions(saved.settings.scan_options);
      this.apiKeyStored = saved.apiKeyStored;
      this.credentialMode = saved.credentialMode ?? 'local';
      setLocale(this.locale);
      this.settingsRecoveryRequired = false;
    } catch {
      // Unknown state remains blocked until a subsequent successful settings save/reload.
    }
  }

  /** Save from the settings screen. A change that alters what a scan finds makes the scan stale. */
  async saveSettings(before: Settings, apiKey = '', beforeMode: CredentialMode = this.credentialMode): Promise<boolean> {
    if (this.busy) return false;
    this.busy = 'settings';
    const recoveryRevision = this.settingsRecoveryRevision;
    try {
      await this.persistSettings(apiKey);
      const scopeChanged = SCOPE_KEYS.some((key) => before[key] !== this.settings[key]) ||
        JSON.stringify(before.external_resource_pack_paths ?? []) !== JSON.stringify(this.settings.external_resource_pack_paths ?? []) ||
        scanOptionsSignature(before.scan_options) !== scanOptionsSignature(this.settings.scan_options) ||
        JSON.stringify(resourcePackOptions(before.resource_pack_options)) !== JSON.stringify(resourcePackOptions(this.settings.resource_pack_options));
      if (scopeChanged && this.scan) {
        this.resetJob();
        if (this.step !== 'world') this.step = 'scan';
        this.notify(t('settings.changedScan'), 'info', 8000);
      }
      if (before.ui_language !== this.settings.ui_language) setLocale(this.locale);
      if (JSON.stringify(before.source_overrides) !== JSON.stringify(this.settings.source_overrides)) this.candidates.refetchSoon(0);
      if (this.scan) void this.loadEstimate();
      this.notify(t('settings.saved'), 'success', 2600);
      return true;
    } catch (cause) {
      if (this.settingsRecoveryRevision === recoveryRevision) {
        this.settings = { ...before };
        this.credentialMode = beforeMode;
      }
      this.banner = { tone: 'error', message: `${t('settings.saveError')}: ${this.describe(cause)}` };
      return false;
    } finally {
      this.busy = '';
    }
  }

  private modelScope(selection: Settings): string {
    return JSON.stringify([selection.provider, selection.provider === 'custom' ? selection.base_url : '', selection.provider === 'custom' ? selection.wire_format : '']);
  }

  modelsFor(selection: Settings): ModelInfo[] {
    return this.modelsScope === this.modelScope(selection) ? this.models : [];
  }

  async loadModels(selection: Settings = this.settings, force = false): Promise<number> {
    const scope = this.modelScope(selection);
    const cached = this.modelCatalogs.get(scope);
    if (!force && cached && Date.now() - cached.fetchedAt < 5 * 60_000) {
      this.models = cached.models;
      this.modelsScope = scope;
      this.modelsCached = cached.cached;
      return cached.models.length;
    }
    if (this.busy) throw new Error(t('settings.model.wait'));
    this.busy = 'models';
    try {
      const listed = await callBackend<{ models: ModelInfo[]; cached?: boolean }>('models.list', {
        provider: selection.provider,
        ...(selection.provider === 'custom' ? { baseUrl: selection.base_url } : {}),
        model: '',
        wireFormat: selection.wire_format,
        ...(selection.provider === 'openrouter' ? { publicCatalog: true } : {})
      });
      this.models = listed.models;
      this.modelsScope = scope;
      this.modelsCached = !!listed.cached;
      this.modelCatalogs.set(scope, { models: listed.models, fetchedAt: Date.now(), cached: !!listed.cached });
      return listed.models.length;
    } finally {
      this.busy = '';
    }
  }

  /**
   * The display language applies the moment it is picked, like the appearance next to it. Only the
   * language is written; other edits waiting on the settings screen stay unsaved there.
   */
  async setUiLanguage(locale: Locale): Promise<boolean> {
    const before = this.settings.ui_language;
    if (before === locale) return true;
    if (this.busy) return false;
    this.busy = 'settings';
    this.settings = { ...this.settings, ui_language: locale };
    setLocale(locale);
    try {
      await this.persistSettings();
      return true;
    } catch (cause) {
      this.settings = { ...this.settings, ui_language: before };
      setLocale(this.locale);
      this.fail(cause);
      return false;
    } finally {
      this.busy = '';
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
      this.notify(t('settings.apiKey.deleted'), 'success');
      return true;
    } catch (cause) {
      this.fail(cause);
      return false;
    }
  }

  isResumeStatus(status: string): boolean {
    return RESUMABLE.includes(status);
  }
}

export const app = new AppState();
