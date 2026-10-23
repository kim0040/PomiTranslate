import { SvelteSet } from 'svelte/reactivity';
import { open } from '@tauri-apps/plugin-dialog';
import {
  BackendError,
  callBackend,
  cancelBackend,
  type CredentialMode,
  type CredentialState,
  type CredentialStoreError,
  diagnosticsExport,
  diagnosticsSnapshot,
  fromShellError,
  nativeReset,
  resetCredentialStorage,
  onZoomFailed,
  onProgress,
  type BackupLocation,
  type BackupSummary,
  type BackupUsage,
  type BackupsListPayload,
  type BootstrapPayload,
  type InterruptedJob,
  type RecoveryResult,
  type ReviewDraft,
  type Estimate,
  type ModelInfo,
  type Notices,
  type RecentWorld,
  type ResumeStatus,
  type ScanResult,
  type Settings,
  type TranslationResult,
  type DiscoveredWorld,
  type AppPrefs,
  type WorldInspection
} from './api';
import {
  appVersion, cancelExit, cancelUpdate, checkForUpdate, confirmExit, dataLocations, forceExit, inShell, installUpdate, isGoneQuestion, keepWaiting, onExitConfirm, onExitStuck, onExitWaiting,
  onOpenWorld, onUpdateProgress, openExternal, revealPath, type MenuAction, type UpdateInfo
} from './native';
import { expectedLogFolder, formatDiagnostics, newDiagnosticId } from './diagnostics';
import { hasConsent, rememberConsent, takeLegacyNotifyPref } from './local-prefs';
import { notificationsAvailable, requestNotificationPermission, sendNotification } from './plugins';
import { cleanOverrides } from './review';
import { LISTABLE_PROVIDERS } from './recommended-models';
import { resourcePackOptions } from './resource-pack';
import { assessReset, type ResetShortfall } from './reset';
import { CandidateSource } from './candidates.svelte';
import { needsNewerConfirmation } from './chunk-coverage';
import { detectLocale, hasMessage, setLocale, t, type Locale, type MessageKey } from './i18n/index.svelte';
import { applyTheme, type ThemeChoice } from './theme';
import { emptyProgress, reduceProgress, type JobProgress } from './workflow';
import { normalizedScanOptions, scanOptionsSignature } from './settings';

export type Page = 'workspace' | 'backups' | 'glossary' | 'settings' | 'about' | 'help';
export type Step = 'world' | 'scan' | 'review' | 'run' | 'result';
export type Busy = '' | 'loading' | 'scan' | 'translate' | 'restore' | 'recovery' | 'prompt' | 'settings' | 'usage';
export type Tone = 'info' | 'success' | 'error';
/** Why Start is unavailable, in the order the screens explain it. */
export type RunBlocker = 'recovery' | 'credential' | 'interrupted' | 'model' | 'key';
/** What a pending question about dropping an unsaved review is about. */
export type DiscardReason = 'world' | 'restore' | 'forget' | 'rescan' | 'settings';
export type DraftState = 'idle' | 'saving' | 'saved' | 'error';
export type Toast = { id: number; tone: Tone; message: string; ms: number };

/** The language a person translating in this UI language most likely wants as the target. */
export const DEFAULT_TARGET: Record<Locale, string> = { ko: '한국어', en: 'English', ja: '日本語' };
const DRAFT_SAVE_DELAY = 800;
const ESTIMATE_DELAY = 400;
const PREFS_RETRY_LIMIT = 5;
/** Backend calls whose type the core does not know yet (an older core) fail with these codes. */
const UNKNOWN_COMMAND_CODES = ['UNSUPPORTED_REQUEST', 'UNKNOWN_REQUEST', 'UNKNOWN_MESSAGE'];

/** An error whose message is already shown text in the display language (made by this file). */
class LocalizedError extends Error {}

function samePath(a: string, b: string): boolean {
  const norm = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return !!a && !!b && norm(a) === norm(b);
}

export const STEPS: Step[] = ['world', 'scan', 'review', 'run', 'result'];

export const defaultSettings = (): Settings => ({
  provider: 'openai', model: '', base_url: '', wire_format: 'openai', target_language: '한국어', style_preset: 'neutral',
  openrouter_reasoning: 'default', style_prompt: '', custom_system_prompt: '', temperature: 0.3, batch_size: 40, request_timeout: 120, rpm_limit: 0,
  tpm_limit: 0, max_batch_retries: 3, concurrency: 4, resource_pack_enabled: false, resource_pack_options: resourcePackOptions(), external_resource_pack_paths: [], skip_target_language_text: true,
  max_file_write_retries: 2, continue_on_file_error: true, source_overrides: {},
  ui_language: 'ko', last_world_dir: '', scan_options: normalizedScanOptions()
});

const NOTICE_KEY = 'pomi.notice.v1';
const PROVIDERS = ['openai', 'gemini', 'anthropic', 'openrouter', 'comet', 'custom'];
export const ISSUES_URL = 'https://github.com/kim0040/PomiTranslate/issues/new';
const DAY = 24 * 60 * 60;
export const DEFAULT_PREFS: AppPrefs = {
  theme: 'system', notice_accepted: false, tutorial_seen: false,
  update_auto_check: true, update_last_check: 0, update_skipped_version: '', notify_on_finish: true
};
export type UpdateState = 'idle' | 'checking' | 'installing' | 'error';
/** Menu commands that work while the core failed to start: help pages and links only. */
const STARTUP_SAFE_ACTIONS: MenuAction[] = ['help', 'shortcuts', 'licenses', 'report'];
const RESUMABLE = ['cancelled', 'needs_retry', 'failed', 'partial'];
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
  /** The part of Settings an entry point asked for. Settings consumes it, also while it is already open, through its guarded tab switch. */
  settingsTabRequest = $state<'translation' | 'app' | null>(null);
  update = $state<UpdateInfo | null>(null);
  updateState = $state<UpdateState>('idle');
  updateError = $state('');
  updateProgress = $state<{ downloaded: number; total: number | null } | null>(null);
  banner = $state<{ tone: 'error' | 'warning'; message: string; action?: 'enter-key' } | null>(null);
  /**
   * The saved Custom key predates address binding and is never sent (CREDENTIAL_ENDPOINT_UNBOUND).
   * Settings then explains it and opens the key field; saving a new key clears it.
   */
  keyReentry = $state(false);
  /** Set when the person is taken to the key field; Settings clears it once the field has focus. */
  focusKeyField = $state(false);
  toasts = $state<Toast[]>([]);
  railCollapsed = $state(false);
  /** Set by the settings screen while it holds changes that are not saved yet. */
  settingsDirty = $state(false);
  /** Set by the glossary screen while its list has edits that are not saved yet. */
  glossaryDirty = $state(false);
  /**
   * The question the shell asked when the window was closed or Quit was chosen: a running job, unsaved
   * settings, or both. `reason: 'update'` is the same question raised by an update that restarts the app.
   * `intent` names the question; every answer carries it. `waiting` follows "cancel and quit"; `stuck`
   * means the job did not stop in time.
   */
  exitPrompt = $state<{ job: boolean; dirty: boolean; reason: 'quit' | 'update'; intent: number; phase: 'ask' | 'waiting' | 'stuck' } | null>(null);
  /** What an incomplete reset left behind; the reset dialog shows it and offers a retry. */
  resetShortfall = $state<ResetShortfall | null>(null);
  /** Set by the settings or glossary screen (whichever is open): saves its draft and says whether that worked. */
  saveDraft: (() => Promise<boolean>) | null = null;
  /** A move away from settings that waits until the user saves or drops the changes there. */
  pendingLeave = $state<(() => void) | null>(null);
  /** The workflow step that sent the user to settings, so settings can offer the way back. */
  returnStep = $state<Step | null>(null);

  settings = $state<Settings>(defaultSettings());
  apiKeyStored = $state(false);
  credentialMode = $state<CredentialMode>('local');
  /** Why the key store cannot be used, when it cannot. Saved keys may still be there. */
  credentialStoreError = $state<CredentialStoreError | null>(null);
  settingsRecoveryRequired = $state(false);
  credentialRecovery = new SvelteSet<string>();
  private settingsRecoveryRevision = 0;
  models = $state<ModelInfo[]>([]);
  /** A model-list request is running. Separate from `busy`, so it never blocks scan, review or save. */
  modelsLoading = $state(false);
  private modelsInFlight: { scope: string; promise: Promise<number> } | null = null;
  modelsScope = $state('');
  modelsCached = $state(false);
  private modelCatalogs = new Map<string, { models: ModelInfo[]; fetchedAt: number; cached: boolean }>();

  worldDir = $state('');
  inspection = $state<WorldInspection | null>(null);
  recent = $state<RecentWorld[]>([]);
  discovered = $state<DiscoveredWorld[]>([]);
  discoveredLoaded = $state(false);
  backups = $state<BackupSummary[]>([]);
  /** False once the core said it has no backups.delete/prune (an older core): the controls are hidden. */
  backupAdminSupported = $state(true);
  /** Disk used by backups; absent when the core is too old to report it. */
  backupUsage = $state<BackupUsage | null>(null);
  /** Work an earlier run left half done, found at start-up. */
  interruptedJobs = $state<InterruptedJob[]>([]);
  /** The finished recovery the person is looking at (its job leaves the list once decided). */
  recoveryResult = $state<{ job: InterruptedJob; result: RecoveryResult } | null>(null);
  recoveryJobId = $state('');

  scan = $state<ScanResult | null>(null);
  /** The one confirmation per scan that its chunks come from a newer game version than this app was tested with. */
  newerAccepted = $state(false);
  /** When the scan on screen was made (ms), for the return-visit summary. */
  scanAt = $state(0);
  candidates = new CandidateSource(() => ({
    excluded: [...this.excluded],
    manual: Object.keys(this.effectiveOverrides)
  }), (cause) => this.describe(cause));
  excluded = new SvelteSet<string>();
  /** What was typed, exactly as typed. `effectiveOverrides` is what counts. */
  overrides = $state<Record<string, string>>({});
  /** Manual translations as sent: trimmed, blank ones dropped. */
  effectiveOverrides = $derived(cleanOverrides(this.overrides));
  /** Bumped on every include/exclude/override change; screens depend on this instead of the sets. */
  reviewVersion = $state(0);
  draftState = $state<DraftState>('idle');
  /** The review has changes that are not stored in the core yet. */
  private draftDirty = $state(false);
  /** False once the core answered that it has no draft commands (an older core). */
  private draftSupported = $state(true);
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private estimateTimer: ReturnType<typeof setTimeout> | null = null;
  /** The question "drop this unsaved review?" and what to do on yes. */
  discardPrompt = $state<{ reason: DiscardReason; resolve: (agreed: boolean) => void } | null>(null);
  estimate = $state<Estimate | null>(null);
  /** True while a newer estimate is on its way, so screens can say "calculating" instead of "unknown". */
  estimateLoading = $state(false);
  failurePolicy = $state<'stop' | 'skip'>('stop');

  progress = $state<JobProgress>(emptyProgress());
  result = $state<TranslationResult | null>(null);
  /** When `result` arrived (ms), so a screen can say how long ago it was; 0 when there is none. */
  resultAt = $state(0);
  resume = $state<ResumeStatus | null>(null);
  /** The recovery snapshot of the last restore, until the next scan or world change replaces the job. */
  lastRestoreId = $state('');
  /** The last failure the person was shown, for the diagnostics copy. */
  lastError = $state<{ code: string; id: string; at: number } | null>(null);
  /** The shell can show system notifications (plugin present). */
  notificationsSupported = $state(false);
  /** The person has not yet picked a display and target language in the first-run dialog. */
  firstRun = $state(false);
  private targetTouched = false;
  private prefsAttempts = 0;
  private prefsGaveUp = false;

  private toastSerial = 0;
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
    return Object.keys(this.effectiveOverrides).filter((id) => !this.excluded.has(id)).length;
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

  /** Interrupted work on the world that is open. Translating or restoring it first would hide it. */
  get interruptedHere(): InterruptedJob[] {
    return this.interruptedJobs.filter((job) => samePath(job.worldPath, this.worldDir));
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

  /** The interrupted job whose continuation waits for the newer-version confirmation, shown in the recovery panel itself. */
  continuation = $state<InterruptedJob | null>(null);
  /** The last start was refused with NEWER_VERSION_UNCONFIRMED, so the confirmation is asked again where it was asked. */
  private newerRefused = false;

  /** The scan met chunks newer than the newest tested version and the person has not confirmed yet. */
  get newerPending(): boolean {
    return needsNewerConfirmation(this.scan?.chunkCoverage) && !this.newerAccepted;
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

  get isBusy(): boolean {
    return this.busy === 'scan' || this.busy === 'translate' || this.busy === 'restore' || this.busy === 'recovery';
  }

  // --- feedback ----------------------------------------------------------------------------

  /**
   * Show a toast. Errors stay until dismissed; the others leave on their own, and the toast region
   * (components/Toasts.svelte) holds that timer while the pointer or focus is on a toast.
   */
  notify(message: string, tone: Tone = 'info', ms = 5200): void {
    // Behind an open dialog a toast cannot be reached, so an error raised meanwhile is shown inside
    // the dialog instead (one place, announced once) and not queued as a second copy.
    if (tone === 'error' && this.dialogDepth > 0) {
      this.dialogError = message;
      return;
    }
    const id = ++this.toastSerial;
    this.toasts = [...this.toasts, { id, tone, message, ms: tone === 'error' ? 0 : ms }];
  }

  /** Dialogs currently open, and the latest error to show inside them. */
  dialogDepth = $state(0);
  dialogError = $state('');

  /** Called by each open Dialog. Returns the function that says it closed. */
  registerDialog(): () => void {
    this.dialogDepth += 1;
    this.dialogError = '';
    return () => {
      this.dialogDepth = Math.max(0, this.dialogDepth - 1);
      if (!this.dialogDepth) this.dialogError = '';
    };
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((toast) => toast.id !== id);
  }

  /**
   * A readable message for a failed call, in the display language. A code the shell or core sent
   * maps to catalog text with a next step; anything else gets the generic text and an error id the
   * diagnostics copy carries. The raw English message of a failure is never shown.
   */
  describe(cause: unknown): string {
    if (cause instanceof LocalizedError) return cause.message;
    const code = cause instanceof BackendError ? cause.code : '';
    if (cause instanceof BackendError) {
      // The update codes keep their own catalog section.
      const key = cause.code.startsWith('UPDATE_') ? `update.error.${cause.code}` : `error.${cause.code}`;
      if (cause.code === 'BUSY') return t('error.busy');
      // A Custom key saved before keys were tied to an address: the fix is entering it again, so
      // Settings is told to take the person to that field.
      if (cause.code === 'CREDENTIAL_ENDPOINT_UNBOUND') this.keyReentry = true;
      if (hasMessage(key)) {
        // A storage failure also says which step repairs it.
        const why = cause.detail ? `error.${cause.detail}` : '';
        return why && hasMessage(why) ? `${t(key as MessageKey)} ${t(why as MessageKey)}` : t(key as MessageKey);
      }
    }
    const id = newDiagnosticId();
    // Written outside any render: describe runs from handlers, never from a template.
    this.lastError = { code: code || 'UNKNOWN', id, at: Date.now() };
    return `${t('error.default')} ${t('error.copyDiagnostics')} ${t('error.id', { id })}`;
  }

  /** Save the diagnostics bundle as a file the person can attach; the clipboard copy is the fallback outside the shell. */
  async saveDiagnostics(): Promise<void> {
    if (!inShell()) return this.copyDiagnostics();
    try {
      if (await diagnosticsExport()) this.notify(t('diagnostics.saved'), 'success');
    } catch {
      this.notify(t('diagnostics.saveFailed'), 'error');
    }
  }

  /** Put what a bug report needs on the clipboard: versions, last error, log folder. No keys, no world text. */
  async copyDiagnostics(): Promise<void> {
    try {
      const shellText = await diagnosticsSnapshot().catch(() => '');
      const places = await dataLocations();
      const text = formatDiagnostics({
        shellText,
        appVersion: await appVersion(''),
        revision: String((import.meta.env as Record<string, unknown>).VITE_BUILD_REVISION ?? ''),
        uiLocale: this.locale,
        browserLocale: typeof navigator === 'undefined' ? '' : navigator.language,
        platform: typeof navigator === 'undefined' ? '' : navigator.platform,
        provider: this.settings.provider,
        model: this.settings.model,
        lastError: this.lastError,
        logFolder: expectedLogFolder(places?.app)
      });
      await navigator.clipboard.writeText(text);
      this.notify(t('diagnostics.copied'), 'success');
    } catch {
      this.notify(t('diagnostics.copyFailed'), 'error');
    }
  }

  /** The error boundary caught a failure while drawing the app: keep an id for the diagnostics copy. */
  reportCrash(error: unknown): void {
    this.lastError = { code: error instanceof Error && error.name ? `UI_${error.name}`.toUpperCase() : 'UI_CRASH', id: newDiagnosticId(), at: Date.now() };
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) console.error('[ui] render failure', error);
  }

  /** Record what the shell reported about the key store. */
  private applyCredentialState(state: CredentialState | undefined): void {
    this.credentialStoreError = state?.error ?? null;
  }

  fail(cause: unknown): void {
    const message = this.describe(cause);
    this.banner = { tone: 'error', message, ...(cause instanceof BackendError && cause.code === 'CREDENTIAL_ENDPOINT_UNBOUND' ? { action: 'enter-key' as const } : {}) };
    if (this.dialogDepth > 0) this.dialogError = message;
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
        onExitConfirm((prompt) => { this.exitPrompt = { ...prompt, phase: 'ask' }; }),
        onExitWaiting(() => { this.exitPrompt = { job: true, dirty: false, reason: 'quit', intent: 0, ...this.exitPrompt, phase: 'waiting' }; }),
        onExitStuck(() => { this.exitPrompt = { job: true, dirty: false, reason: 'quit', intent: 0, ...this.exitPrompt, phase: 'stuck' }; }),
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
      this.settings = { ...defaultSettings(), ...boot.settings };
      this.settings.batch_size = numberOr(boot.settings.batch_size, 40);
      this.settings.temperature = numberOr(boot.settings.temperature, 0.3);
      this.settings.request_timeout = numberOr(boot.settings.request_timeout, 120);
      this.settings.rpm_limit = numberOr(boot.settings.rpm_limit, 0);
      this.settings.tpm_limit = numberOr(boot.settings.tpm_limit, 0);
      this.settings.max_batch_retries = numberOr(boot.settings.max_batch_retries, 3);
      this.settings.concurrency = numberOr(boot.settings.concurrency, 4);
      this.settings.skip_target_language_text = boot.settings.skip_target_language_text !== false;
      this.settings.resource_pack_enabled = !!boot.settings.resource_pack_enabled;
      this.settings.scan_options = normalizedScanOptions(boot.settings.scan_options);
      setLocale(this.locale);
      this.apiKeyStored = boot.apiKeyStored;
      this.credentialMode = boot.credentialMode ?? this.credentialMode;
      this.applyCredentialState(boot.credentialState);
      this.recent = boot.worlds;
      this.worldDir = boot.settings.last_world_dir || '';
      this.inspection = boot.worldInspection;
      this.backups = boot.backups;
      this.interruptedJobs = Array.isArray(boot.interruptedJobs) ? boot.interruptedJobs : [];
      this.applyPrefs(boot);
      this.applyFirstRunLanguage(boot);
      void notificationsAvailable().then((ok) => { this.notificationsSupported = ok; });
      if (this.worldDir && this.inspection?.validJavaWorld) this.step = this.interruptedHere.length ? 'world' : 'scan';
      this.applyResume(boot.resume);

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
    if (this.draftTimer) clearTimeout(this.draftTimer);
    if (this.estimateTimer) clearTimeout(this.estimateTimer);
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
    // The finish-notification switch used to live in web storage: carry an earlier choice over once.
    const legacyNotify = takeLegacyNotifyPref();
    if (legacyNotify !== null && legacyNotify !== (saved.notify_on_finish ?? true)) {
      saved.notify_on_finish = legacyNotify;
      void this.setPrefs({ notify_on_finish: legacyNotify });
    }
    this.prefs = saved;
    if (saved.theme !== this.theme) this.setThemeOnly(saved.theme);
    this.showNotice = !saved.notice_accepted;
    this.showTour = saved.notice_accepted && !saved.tutorial_seen;
    if (saved.update_auto_check && Date.now() / 1000 - saved.update_last_check > DAY) {
      setTimeout(() => void this.checkUpdates(false), 4000);
    }
  }

  /**
   * First launch: show the interface in the language the system uses (Korean, English or Japanese,
   * else English) and suggest that language as the translation target. Nothing is saved until the
   * notice is accepted, so closing the app during the dialog leaves the install as it was.
   */
  private applyFirstRunLanguage(boot: BootstrapPayload): void {
    // The notice is shown exactly on a launch nobody has accepted it on yet (applyPrefs decided that).
    this.firstRun = this.showNotice;
    if (!this.firstRun || boot.settings.app_prefs) return;
    this.chooseFirstRunLanguage(detectLocale());
  }

  /** The language switcher of the first-run dialog: applies at once, saved on accept. */
  chooseFirstRunLanguage(locale: Locale): void {
    this.settings = { ...this.settings, ui_language: locale };
    if (!this.targetTouched) this.settings.target_language = DEFAULT_TARGET[locale];
    setLocale(locale);
  }

  setFirstRunTarget(value: string): void {
    this.targetTouched = true;
    this.settings = { ...this.settings, target_language: value };
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
      this.prefsAttempts = 0;
      this.prefsGaveUp = false;
    } catch {
      this.unsavedPrefs = { ...pending, ...this.unsavedPrefs };
      this.prefsAttempts += 1;
      if (this.prefsAttempts >= PREFS_RETRY_LIMIT) {
        // The change applies for this session; stop retrying and say so once.
        if (!this.prefsGaveUp) {
          this.prefsGaveUp = true;
          this.notify(t('prefs.notSaved'), 'error');
        }
        return;
      }
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
    if (this.firstRun) {
      this.firstRun = false;
      // The language and target picked in the dialog become the saved settings.
      void this.persistSettings().catch((cause) => this.fail(cause));
    }
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
      // However the install ended, a question it was waiting on is moot.
      if (this.exitPrompt?.reason === 'update') this.exitPrompt = null;
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
    this.resetShortfall = null;
    // The shell's half goes first (saved keys when asked, then the run reports). The core's data is
    // reset only when that half fully worked, so a failed step can simply be tried again. If the
    // core's half fails afterwards, the message says that the keys are already gone.
    let nativeDone = false;
    try {
      const shortfall = assessReset(await nativeReset(clearKeys), clearKeys);
      if (shortfall) {
        this.resetShortfall = shortfall;
        this.banner = { tone: 'error', message: this.resetShortfallLines(shortfall).join(' ') };
        return false;
      }
      nativeDone = true;
      await callBackend('app.reset', { confirm: 'reset' });
      try {
        localStorage.removeItem(NOTICE_KEY);
        localStorage.removeItem('pomi.theme.v1');
      } catch { /* nothing cached */ }
      return true;
    } catch (cause) {
      const partial = nativeDone ? ` ${t(clearKeys ? 'reset.partialKeys' : 'reset.partial')}` : '';
      const message = `${this.describe(cause)}${partial}`;
      this.banner = { tone: 'error', message };
      // The reset question is a modal: an error behind it would not be seen.
      if (this.dialogDepth > 0) this.dialogError = message;
      return false;
    }
  }

  /** What is left after an incomplete reset, one sentence each, in the display language. */
  resetShortfallLines(shortfall: ResetShortfall): string[] {
    const lines = [t('reset.incomplete')];
    if (shortfall.keys) lines.push(t(shortfall.keysPartial ? 'reset.left.keysPartial' : 'reset.left.keys'));
    if (shortfall.reports) lines.push(t('reset.left.reports'));
    for (const code of shortfall.errors) {
      const key = `error.${code}`;
      if (hasMessage(key)) lines.push(t(key as MessageKey));
    }
    lines.push(t('reset.left.retry'));
    return lines;
  }

  /** Set a damaged key store aside and start an empty one. */
  async resetKeyStorage(): Promise<boolean> {
    if (this.isBusy) return false;
    try {
      await resetCredentialStorage();
      this.credentialStoreError = null;
      this.apiKeyStored = false;
      this.credentialRecovery.clear();
      this.notify(t('credential.reset.done'), 'success');
      return true;
    } catch (cause) {
      this.fail(cause);
      return false;
    }
  }

  // --- leaving the app ---------------------------------------------------------------------

  /**
   * Stay: dismiss the question and tell the shell, which calls off an update that waits for the
   * answer. If the shell no longer has the question, there is nothing more to do.
   */
  exitStay(): void {
    const prompt = this.exitPrompt;
    this.exitPrompt = null;
    if (prompt?.phase === 'ask' && prompt.intent > 0) void cancelExit(prompt.intent).catch(() => {});
  }

  /**
   * Go on with the question on screen. A quit cancels a running job first and ends when it has
   * stopped; an update question closes here and the install carries on. An answer the shell refuses
   * because the question is gone (it timed out or was replaced) closes the dialog and does nothing else.
   */
  async exitQuit(): Promise<void> {
    const prompt = this.exitPrompt;
    try {
      await confirmExit(prompt?.intent ?? 0);
      if (prompt?.reason === 'update') this.exitPrompt = null;
    } catch (cause) {
      this.exitPrompt = null;
      if (!isGoneQuestion(cause)) this.fail(fromShellError(cause));
    }
  }

  /** Save the settings draft, then go on. A failed save keeps the app open. */
  async exitSaveAndQuit(): Promise<void> {
    const saved = this.saveDraft ? await this.saveDraft() : false;
    if (saved) await this.exitQuit();
    else this.notify(t('exit.saveFailed'), 'error', 8000);
  }

  /** "Keep waiting" after the job did not stop in time: the shell repeats the cancel and waits again. */
  async exitKeepWaiting(): Promise<void> {
    try {
      await keepWaiting();
      if (this.exitPrompt) this.exitPrompt = { ...this.exitPrompt, phase: 'waiting' };
    } catch (cause) {
      this.exitPrompt = null;
      this.fail(fromShellError(cause));
    }
  }

  /** "Quit now": the job did not stop, so the shell ends the core. */
  async exitNow(): Promise<void> {
    try {
      await forceExit();
    } catch (cause) {
      this.exitPrompt = null;
      this.fail(fromShellError(cause));
    }
  }

  async cancelUpdateDownload(): Promise<void> {
    await cancelUpdate();
  }

  // --- navigation --------------------------------------------------------------------------

  /**
   * Leave the current page. Unsaved settings or glossary edits are never dropped silently: the move
   * waits until that screen asks whether to save them, drop them, or stay.
   */
  private leave(next: () => void): void {
    const run = () => {
      if (this.page === 'settings') this.returnStep = null;
      next();
    };
    if ((this.page === 'settings' && this.settingsDirty) || (this.page === 'glossary' && this.glossaryDirty)) this.pendingLeave = run;
    else run();
  }

  /** Answer for a move that waited on unsaved settings. */
  resolveLeave(proceed: boolean): void {
    const next = this.pendingLeave;
    this.pendingLeave = null;
    if (!proceed || !next) {
      this.settingsTabRequest = null;
      return;
    }
    this.settingsDirty = false;
    this.glossaryDirty = false;
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
    this.settingsTabRequest = 'translation';
    this.goto('settings');
  }

  /** Take the person to the key field of the Custom provider (see `keyReentry`). */
  enterKeyAgain(): void {
    this.focusKeyField = true;
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
      this.settingsTabRequest = 'translation';
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
      this.settingsTabRequest = 'app';
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
    if (this.draftTimer) { clearTimeout(this.draftTimer); this.draftTimer = null; }
    if (this.estimateTimer) { clearTimeout(this.estimateTimer); this.estimateTimer = null; }
    this.draftDirty = false;
    this.draftState = 'idle';
    this.reviewVersion += 1;
    this.scan = null;
    this.newerAccepted = false;
    this.continuation = null;
    this.scanAt = 0;
    this.candidates.reset('');
    this.excluded.clear();
    this.overrides = {};
    this.estimate = null;
    this.result = null;
    this.resultAt = 0;
    this.progress = emptyProgress();
    this.resume = null;
  }

  // --- review draft ------------------------------------------------------------------------

  /** Excluded sentences plus manual translations in the review. */
  get draftCount(): number {
    return this.excluded.size + Object.keys(this.effectiveOverrides).length;
  }

  /**
   * Dropping the review would lose work: it has content and is not stored in the core (or the core
   * cannot store drafts at all). A stored draft is restored on re-scan, so it needs no question.
   */
  get draftNeedsConfirm(): boolean {
    return this.draftCount > 0 && (this.draftDirty || !this.draftSupported);
  }

  /**
   * May the review be dropped now? Yes at once when nothing would be lost; otherwise the question
   * is shown (components/DiscardReviewDialog.svelte) and this resolves with the answer. Callers try
   * to store the draft first, so the question only appears when that was not possible.
   */
  async mayDiscard(reason: DiscardReason): Promise<boolean> {
    if (this.draftDirty) await this.storeReview(true);
    if (!this.draftNeedsConfirm) return true;
    this.discardPrompt?.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.discardPrompt = { reason, resolve };
    });
  }

  answerDiscard(agreed: boolean): void {
    const prompt = this.discardPrompt;
    this.discardPrompt = null;
    prompt?.resolve(agreed);
  }

  /** A review choice changed (include/exclude or manual text). */
  private reviewChanged(): void {
    this.reviewVersion += 1;
    this.estimate = null;
    this.estimateLoading = true;
    this.draftDirty = true;
    this.scheduleDraftSave();
    this.scheduleEstimate();
  }

  private scheduleEstimate(): void {
    if (this.estimateTimer) clearTimeout(this.estimateTimer);
    this.estimateTimer = setTimeout(() => {
      this.estimateTimer = null;
      void this.loadEstimate();
    }, ESTIMATE_DELAY);
  }

  private scheduleDraftSave(delay = DRAFT_SAVE_DELAY): void {
    if (!this.scan || !this.draftSupported || this.destroyed) return;
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      void this.storeReview();
    }, delay);
  }

  /** Store the review in the core now. Resolves true when nothing is left unstored. */
  async storeReview(force = false): Promise<boolean> {
    if (this.draftTimer) { clearTimeout(this.draftTimer); this.draftTimer = null; }
    const scan = this.scan;
    if (!scan || !this.draftDirty) return !this.draftDirty;
    if (!this.draftSupported) return false;
    // The core is busy with a job and answers in order; store the draft when it has finished.
    if (this.isBusy && !force) return false;
    const version = this.reviewVersion;
    this.draftState = 'saving';
    try {
      await callBackend('review.draft.set', {
        scanPlanId: scan.scanPlanId,
        excludedCandidateIds: [...this.excluded],
        candidateOverrides: this.effectiveOverrides
      });
      if (this.scan?.scanPlanId === scan.scanPlanId && version === this.reviewVersion) this.draftDirty = false;
      this.draftState = 'saved';
      return !this.draftDirty;
    } catch (cause) {
      const code = cause instanceof BackendError ? cause.code : '';
      if (UNKNOWN_COMMAND_CODES.includes(code)) {
        this.draftSupported = false;
        this.draftState = 'idle';
      } else if (code === 'DRAFT_TOO_LARGE') {
        this.draftState = 'error';
        this.notify(t('review.draft.tooLarge'), 'error');
      } else if (code === 'PLAN_NOT_FOUND') {
        this.draftState = 'error';
      } else {
        this.draftState = 'error';
        this.scheduleDraftSave(5000);
      }
      return false;
    }
  }

  /** Bring back the review stored for this scan plan, unless the person already changed it. */
  private async restoreDraft(planId: string): Promise<void> {
    if (!this.draftSupported) return;
    const version = this.reviewVersion;
    try {
      const draft = await callBackend<ReviewDraft>('review.draft.get', { scanPlanId: planId });
      if (!draft.exists || this.scan?.scanPlanId !== planId || version !== this.reviewVersion) return;
      const ids = draft.excludedCandidateIds ?? [];
      const typed = draft.candidateOverrides ?? {};
      if (!ids.length && !Object.keys(typed).length) return;
      this.excluded.clear();
      for (const id of ids) this.excluded.add(id);
      this.overrides = { ...typed };
      this.draftDirty = false;
      this.draftState = 'saved';
      this.reviewVersion += 1;
      this.candidates.refetchSoon(0);
      void this.loadEstimate();
      this.notify(t('review.draft.restored', { excluded: ids.length, manual: Object.keys(typed).length }), 'info', 6000);
    } catch (cause) {
      if (cause instanceof BackendError && UNKNOWN_COMMAND_CODES.includes(cause.code)) this.draftSupported = false;
      // A draft that cannot be read is simply absent: the review starts empty.
    }
  }

  /** Remove the stored draft once the review has been applied (or thrown away on purpose). */
  private async clearDraft(planId: string): Promise<void> {
    if (!this.draftSupported) return;
    try {
      await callBackend('review.draft.clear', { scanPlanId: planId });
    } catch (cause) {
      if (cause instanceof BackendError && UNKNOWN_COMMAND_CODES.includes(cause.code)) this.draftSupported = false;
    }
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
    if (path !== this.worldDir && !(await this.mayDiscard('world'))) return;
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
    if (this.worldDir === path && !(await this.mayDiscard('forget'))) return;
    try {
      this.recent = (await callBackend<{ worlds: RecentWorld[] }>('worlds.forget', { worldDir: path })).worlds;
      if (this.worldDir === path) {
        this.worldDir = '';
        this.inspection = null;
        this.backups = [];
        this.backupUsage = null;
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
      this.backupUsage = null;
      return;
    }
    const listed = await callBackend<BackupsListPayload>('backups.list', { worldDir: this.worldDir });
    this.backups = listed.backups;
    this.backupUsage = listed.usage ?? null;
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
      chunkCoverage: resumable.chunkCoverage,
      providerRequests: 0,
      fingerprint: resumable.fingerprint,
      scanPlanId: resumable.scanPlanId,
      dryRun: true,
      candidates: resumable.candidates || []
    };
    this.newerAccepted = false;
    this.excluded.clear();
    for (const id of resumable.excludedCandidateIds || []) this.excluded.add(id);
    this.overrides = { ...(resumable.candidateOverrides || {}) };
    this.resume = resumable;
    this.draftDirty = false;
    this.reviewVersion += 1;
    this.scanAt = (resumable.savedAt ?? 0) * 1000;
    this.candidates.reset(resumable.scanPlanId, resumable.candidates, resumable.candidateCount);
    void this.loadEstimate();
    // A checkpoint carries its own choices; without one the stored review draft (if any) applies.
    if (!this.excluded.size && !Object.keys(this.overrides).length) void this.restoreDraft(resumable.scanPlanId);
  }

  /** Throw away the saved partial run (and its checkpoint) so the next start begins from scratch. */
  async discardResume(): Promise<boolean> {
    if (!this.worldDir || this.isBusy) return false;
    try {
      await callBackend<{ discarded: number }>('resume.discard', {
        worldDir: this.worldDir,
        ...(this.scan ? { scanPlanId: this.scan.scanPlanId } : {})
      });
      this.resume = null;
      this.notify(t('run.discarded'), 'success');
      return true;
    } catch (cause) {
      this.fail(cause);
      return false;
    }
  }

  // --- scan --------------------------------------------------------------------------------

  async startScan(): Promise<void> {
    if (!this.worldDir || this.isBusy) return;
    if (this.scan && !(await this.mayDiscard('rescan'))) return;
    if (this.isBusy) return;
    this.busy = 'scan';
    this.banner = null;
    this.resetJob();
    this.progress = { ...emptyProgress(), phase: 'collect', startedAt: Date.now() };
    let finished = false;
    try {
      await this.persistSettings();
      this.scan = await callBackend<ScanResult>('scan.start', { worldDir: this.worldDir });
      this.scanAt = Date.now();
      this.estimate = this.scan.estimate ?? null;
      this.candidates.reset(this.scan.scanPlanId, this.scan.candidates, this.scan.candidateCount);
      finished = this.scan.status === 'completed';
    } catch (cause) {
      this.fail(cause);
    } finally {
      this.busy = '';
      this.progress = emptyProgress();
    }
    const cancelled = this.cancelling;
    this.cancelling = false;
    this.announce('scan', finished, cancelled);
    // The same plan (same world and settings) gets its earlier review back.
    if (finished && this.scan) void this.restoreDraft(this.scan.scanPlanId);
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
        overrideCandidateIds: Object.keys(this.effectiveOverrides)
      });
      if (revision === this.estimateRevision && signature === this.estimateSignature()) this.estimate = estimate;
    } catch {
      // An unavailable estimate stays unknown; stale costs must not describe new choices.
    } finally {
      if (revision === this.estimateRevision) this.estimateLoading = false;
    }
  }

  private estimateSignature(): string {
    return JSON.stringify([this.scan?.scanPlanId, this.settings, this.reviewVersion]);
  }

  setIncluded(id: string, included: boolean): void {
    if (this.excluded.has(id) === !included) return;
    if (included) this.excluded.delete(id);
    else this.excluded.add(id);
    this.reviewChanged();
  }

  /** Include or exclude many sentences at once (a whole filtered list) as one review change. */
  setIncludedMany(ids: string[], included: boolean): void {
    let changed = false;
    for (const id of ids) {
      if (this.excluded.has(id) === !included) continue;
      if (included) this.excluded.delete(id);
      else this.excluded.add(id);
      changed = true;
    }
    if (changed) this.reviewChanged();
  }

  /**
   * Keep what was typed exactly as typed (so the box does not jump while typing); `effectiveOverrides`
   * is the trimmed version that is counted, estimated, saved and sent.
   */
  setOverride(id: string, value: string): void {
    const next = { ...this.overrides };
    if (value) next[id] = value;
    else delete next[id];
    this.overrides = next;
    this.reviewChanged();
  }

  // --- translate ---------------------------------------------------------------------------

  private handleProgress(event: import('./api').ProgressEvent): void {
    this.progress = reduceProgress(this.progress, event);
  }

  async startTranslate(options: { resume?: boolean; fromInterrupted?: boolean } = {}): Promise<void> {
    if (!this.scan || this.isBusy || this.settingsRecoveryRequired || this.credentialRecovery.has(this.settings.provider)) return;
    // Continuing an interrupted job is the one start allowed while it is open.
    if (this.interruptedHere.length && !options.fromInterrupted) return;
    // The review is stored before the job takes the core; a draft that cannot be stored is not lost
    // because the job's own checkpoint keeps the reviewed choices.
    await this.storeReview();
    this.busy = 'translate';
    this.cancelling = false;
    this.newerRefused = false;
    this.banner = null;
    this.result = null;
    this.resultAt = 0;
    this.step = 'run';
    this.progress = { ...emptyProgress(), phase: 'collect', startedAt: Date.now() };
    let outcome: TranslationResult | null = null;
    const planId = this.scan.scanPlanId;
    try {
      await this.persistSettings();
      outcome = await callBackend<TranslationResult>(options.resume ? 'translate.resume' : 'translate.start', {
        worldDir: this.worldDir,
        fingerprint: this.scan.fingerprint,
        scanPlanId: this.scan.scanPlanId,
        excludedCandidateIds: [...this.excluded],
        candidateOverrides: this.effectiveOverrides,
        manualOnly: this.manualOnly,
        provider: this.settings.provider,
        model: this.settings.model,
        ...(this.settings.provider === 'custom' ? { baseUrl: this.settings.base_url } : {}),
        wireFormat: this.settings.wire_format,
        failurePolicy: this.failurePolicy,
        ...(this.newerAccepted && needsNewerConfirmation(this.scan.chunkCoverage) ? { acceptNewerVersion: true } : {})
      });
      this.result = outcome;
      this.resultAt = Date.now();
      this.step = 'result';
      await this.loadBackups();
      if (RESUMABLE.includes(outcome.status)) {
        this.applyResume(await callBackend<ResumeStatus>('resume.status', { worldDir: this.worldDir }));
        // A resumed job keeps its reviewed choices: applyResume rebuilds them from the checkpoint.
      } else {
        this.resume = null;
        // The review has been applied; a stored draft would only come back as a stale suggestion.
        if (outcome.status === 'completed') void this.clearDraft(planId);
      }
    } catch (cause) {
      this.fail(cause);
      // The core asks again: the confirmation did not reach it, so it must be given again.
      if (cause instanceof BackendError && cause.code === 'NEWER_VERSION_UNCONFIRMED') {
        this.newerAccepted = false;
        this.newerRefused = true;
      }
      // A continuation of an interrupted job asks again in its own panel instead of leaving it.
      this.step = !this.scan ? 'scan' : this.newerRefused && options.fromInterrupted ? 'world' : 'run';
      // An unfinished job of this world must be settled first: take the person to where that happens.
      if (cause instanceof BackendError && cause.code === 'RECOVERY_REQUIRED') await this.openInterrupted();
      if (!options.resume && this.resume) {
        // Starting over drops the saved checkpoint; ask what is left rather than offer a stale resume.
        void callBackend<ResumeStatus>('resume.status', { worldDir: this.worldDir })
          .then((resumable) => this.applyResume(resumable))
          .catch(() => { this.resume = null; });
      }
    } finally {
      this.busy = '';
      this.progress = emptyProgress();
    }
    const cancelled = this.cancelling || outcome?.status === 'cancelled';
    this.cancelling = false;
    this.announce('translate', !!outcome && (outcome.status === 'completed' || outcome.status === 'partial'), cancelled);
    if (this.draftDirty) this.scheduleDraftSave(0);
  }

  /** A run that failed before writing anything: start it again from the scan that is still on screen. */
  translateAgain(): void {
    if (!this.scan || this.isBusy || !this.stepReached.run) return;
    this.result = null;
    this.resultAt = 0;
    this.banner = null;
    this.step = 'run';
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
    if (this.interruptedHere.length) {
      this.notify(t('recovery.blocksRestore'), 'error');
      return false;
    }
    if (this.scan && !(await this.mayDiscard('restore'))) return false;
    if (this.isBusy) return false;
    this.busy = 'restore';
    this.banner = null;
    let ok = false;
    try {
      const restored = await callBackend<{ status: string; recoverySetId: string }>('restore.start', {
        worldDir: this.worldDir,
        backupSetId
      });
      if (restored.status !== 'restored' || !restored.recoverySetId) {
        throw new LocalizedError(t('backups.restoreUnconfirmed'));
      }
      this.resetJob();
      // Set after the reset: the scan and backup pages say why the reviewed scan is gone.
      this.lastRestoreId = restored.recoverySetId;
      this.step = 'scan';
      await this.loadBackups();
      this.notify(t('backups.restoreDone'), 'success', 9000);
      ok = true;
      return true;
    } catch (cause) {
      this.fail(cause);
      if (cause instanceof BackendError && cause.code === 'RECOVERY_REQUIRED') await this.openInterrupted();
      return false;
    } finally {
      this.busy = '';
      this.announce('restore', ok, false);
    }
  }

  // --- backup administration ---------------------------------------------------------------

  /** Delete one backup set. The core refuses while a job holds the world and for sets recovery needs. */
  async deleteBackup(backupSetId: string, location: BackupLocation = 'app', acknowledgeLastCopy = false): Promise<boolean> {
    if (!this.worldDir || this.isBusy) return false;
    try {
      await callBackend('backups.delete', { worldDir: this.worldDir, backupSetId, location, acknowledgeLastCopy });
      await this.loadBackups();
      this.notify(t('backups.deleted'), 'success');
      return true;
    } catch (cause) {
      if (cause instanceof BackendError && UNKNOWN_COMMAND_CODES.includes(cause.code)) this.backupAdminSupported = false;
      this.fail(cause);
      await this.loadBackups().catch(() => {});
      return false;
    }
  }

  /** Keep the newest `keepLatest` sets and delete the rest (never the only recovery copy). */
  async pruneBackups(keepLatest: number, location: BackupLocation = 'app'): Promise<boolean> {
    if (!this.worldDir || this.isBusy) return false;
    try {
      const outcome = await callBackend<{ deleted: string[]; skipped?: unknown[]; failed?: unknown[] }>('backups.prune', {
        worldDir: this.worldDir, keepLatest, location, acknowledgeLastCopy: false
      });
      await this.loadBackups();
      const count = outcome.deleted?.length ?? 0;
      this.notify(t(count ? 'backups.pruned' : 'backups.prunedNone', { count }), count ? 'success' : 'info');
      if (outcome.failed?.length) this.notify(t('backups.pruneSomeFailed', { count: outcome.failed.length }), 'error');
      return true;
    } catch (cause) {
      if (cause instanceof BackendError && UNKNOWN_COMMAND_CODES.includes(cause.code)) this.backupAdminSupported = false;
      this.fail(cause);
      await this.loadBackups().catch(() => {});
      return false;
    }
  }

  // --- interrupted work --------------------------------------------------------------------

  /**
   * Decide what to do with work an earlier run left half done: undo it (restore from the backup the
   * run made) or keep the files as they are. The core makes a recovery backup first and keeps any
   * file that changed since as a conflict instead of overwriting it.
   */
  async recover(job: InterruptedJob, mode: 'rollback' | 'keep', options: { acceptConflicts?: boolean } = {}): Promise<RecoveryResult | null> {
    if (this.isBusy) return null;
    if (this.continuation?.jobId === job.jobId) this.cancelContinuation();
    this.busy = 'recovery';
    this.recoveryJobId = job.jobId;
    this.banner = null;
    this.progress = { ...emptyProgress(), phase: 'recovery', startedAt: Date.now() };
    let result: RecoveryResult | null = null;
    try {
      result = await callBackend<RecoveryResult>('recovery.start', {
        jobId: job.jobId, mode, ...(mode === 'keep' && options.acceptConflicts ? { acceptConflicts: true } : {})
      });
      this.recoveryResult = { job, result };
      // A decided job no longer needs attention; one that is partial or in conflict stays listed.
      if (result.state !== 'partial' && result.state !== 'recovery_conflict') this.interruptedJobs = this.interruptedJobs.filter((item) => item.jobId !== job.jobId);
      // Undoing an unpublished resume puts the earlier job back in the list: the core knows, not this page.
      if (result.settledBy === 'unpublished_continuation') await this.refreshInterruptedJobs();
      if (samePath(job.worldPath, this.worldDir)) {
        this.resetJob();
        this.step = 'world';
        await this.loadBackups().catch(() => {});
      }
    } catch (cause) {
      this.fail(cause);
    } finally {
      this.busy = '';
      this.recoveryJobId = '';
      this.progress = emptyProgress();
    }
    this.announce('recovery', !!result && (result.state === 'rolled_back' || result.state === 'kept'), false);
    return result;
  }

  /** Ask the core which jobs are still open; the list stays as it was when the core cannot answer. */
  private async refreshInterruptedJobs(): Promise<void> {
    try {
      const boot = await callBackend<BootstrapPayload>('app.bootstrap');
      this.interruptedJobs = Array.isArray(boot.interruptedJobs) ? boot.interruptedJobs : this.interruptedJobs;
    } catch { /* the list stays as it was */ }
  }

  /** The blocking job to point at after a request was refused with RECOVERY_REQUIRED. */
  highlightedJobId = $state('');

  /** Reload the interrupted jobs (the list only changes at start-up and after a decision) and show them. */
  async openInterrupted(): Promise<void> {
    await this.refreshInterruptedJobs();
    const here = this.interruptedHere;
    this.highlightedJobId = (here.find((job) => job.blocking) ?? here[0])?.jobId ?? '';
    this.step = 'world';
  }

  /** "Continue the remaining work" of a partial job: the same checkpoint, resumed. */
  async continueInterrupted(job: InterruptedJob): Promise<void> {
    if (this.isBusy || !samePath(job.worldPath, this.worldDir)) return;
    // A confirmation already given for this same saved scan (on the run step) still counts after it is loaded again.
    const confirmedPlan = this.newerAccepted ? this.scan?.scanPlanId : '';
    try {
      this.applyResume(await callBackend<ResumeStatus>('resume.status', { worldDir: this.worldDir }));
    } catch (cause) {
      this.fail(cause);
      return;
    }
    if (!this.resume || !this.scan) {
      this.notify(t('interrupted.continueUnavailable'), 'error');
      return;
    }
    if (confirmedPlan && confirmedPlan === this.scan.scanPlanId) this.newerAccepted = true;
    if (needsNewerConfirmation(this.scan.chunkCoverage) && !this.newerAccepted) {
      // Ask here, in the recovery panel, with the saved job still selected; nothing is sent until it is ticked.
      this.continuation = job;
      return;
    }
    await this.runContinuation();
  }

  /** The newer-version box of the recovery panel is ticked: send the continuation with that confirmation. */
  async confirmContinuation(): Promise<void> {
    if (!this.continuation || this.isBusy || !this.newerAccepted || !this.scan || !this.resume) return;
    await this.runContinuation();
  }

  /** Leave the confirmation without continuing; the job stays open and the box is unticked. */
  cancelContinuation(): void {
    this.continuation = null;
    this.newerAccepted = false;
  }

  private async runContinuation(): Promise<void> {
    this.step = 'run';
    await this.startTranslate({ resume: true, fromInterrupted: true });
    // Refused for the confirmation: stay on it (it is asked again) instead of leaving for the world screen.
    if (this.newerRefused) return;
    this.continuation = null;
    // A finished continuation settles the job; its list entry is refreshed from the core.
    await this.openInterrupted();
    if (!this.interruptedHere.length) this.step = 'result';
  }

  closeRecoveryResult(): void {
    this.recoveryResult = null;
  }

  async openFolder(path: string): Promise<void> {
    if (await revealPath(path)) return;
    try {
      await navigator.clipboard.writeText(path);
      this.notify(t('folder.copied', { path }), 'info', 9000);
    } catch {
      this.notify(t('folder.show', { path }), 'info', 12000);
    }
  }

  // --- notifications -----------------------------------------------------------------------

  /** Tell the person a job ended while the window is in the background. No world text goes in. */
  private announce(kind: 'scan' | 'translate' | 'restore' | 'recovery', ok: boolean, cancelled: boolean): void {
    if (cancelled || this.prefs.notify_on_finish === false || !this.notificationsSupported) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()) return;
    void sendNotification(
      t(ok ? 'notify.title.done' : 'notify.title.failed'),
      t(`notify.body.${kind}.${ok ? 'done' : 'failed'}` as MessageKey)
    );
  }

  /** The Settings switch. Turning it on asks the system for permission once. */
  async setNotifyOnFinish(on: boolean): Promise<void> {
    if (on && !(await requestNotificationPermission())) {
      this.notify(t('notify.denied'), 'info', 9000);
      await this.setPrefs({ notify_on_finish: false });
    } else {
      await this.setPrefs({ notify_on_finish: on });
    }
  }

  // --- consent to send text to a provider --------------------------------------------------

  /** First run with this provider and model: ask once before sentences leave the computer. */
  get needsConsent(): boolean {
    return !this.manualOnly && !hasConsent(this.settings.provider, this.settings.model) && !this.consentGiven.has(`${this.settings.provider}|${this.settings.model}`);
  }

  private consentGiven = new SvelteSet<string>();

  grantConsent(): void {
    rememberConsent(this.settings.provider, this.settings.model);
    this.consentGiven.add(`${this.settings.provider}|${this.settings.model}`);
  }

  // --- settings ----------------------------------------------------------------------------

  /** Write the current settings, and a new API key when one was typed. Never keeps the key. */
  async persistSettings(apiKey = ''): Promise<void> {
    const s = this.settings;
    if (this.credentialRecovery.has(s.provider) && !apiKey) throw new BackendError('', 'CREDENTIAL_SAVE_UNCERTAIN');
    let saved: { settings: Settings; apiKeyStored: boolean; credentialMode?: CredentialMode; credentialState?: CredentialState };
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
    this.applyCredentialState(saved.credentialState);
    this.settingsRecoveryRequired = false;
    this.credentialRecovery.delete(s.provider);
    // The key just saved is tied to this address, so the old unbound one is gone.
    if (apiKey && s.provider === 'custom') this.keyReentry = false;
  }

  /** Reload authoritative preferences after a write whose rollback could not be verified. */
  private async recoverSettings(): Promise<void> {
    this.settingsRecoveryRequired = true;
    this.settingsRecoveryRevision += 1;
    // The reviewed scan has to go, but the review itself is kept in the core when possible.
    await this.storeReview(true);
    if (this.draftNeedsConfirm) this.notify(t('review.draft.lostOnRecovery'), 'error', 12000);
    this.resetJob();
    if (this.worldDir) this.step = 'scan';
    try {
      const saved = await callBackend<{ settings: Settings; apiKeyStored: boolean; credentialMode?: CredentialMode; credentialState?: CredentialState }>('settings.get');
      this.settings = { ...defaultSettings(), ...saved.settings };
      this.settings.scan_options = normalizedScanOptions(saved.settings.scan_options);
      this.apiKeyStored = saved.apiKeyStored;
      this.credentialMode = saved.credentialMode ?? this.credentialMode;
      this.applyCredentialState(saved.credentialState);
      setLocale(this.locale);
      this.settingsRecoveryRequired = false;
    } catch {
      // Unknown state remains blocked until a subsequent successful settings save/reload.
    }
  }

  /** Whether two settings differ in what a scan finds (so a reviewed scan would go stale). */
  private scopeDiffers(before: Settings, now: Settings): boolean {
    return SCOPE_KEYS.some((key) => before[key] !== now[key]) ||
      JSON.stringify(before.external_resource_pack_paths ?? []) !== JSON.stringify(now.external_resource_pack_paths ?? []) ||
      scanOptionsSignature(before.scan_options) !== scanOptionsSignature(now.scan_options) ||
      JSON.stringify(resourcePackOptions(before.resource_pack_options)) !== JSON.stringify(resourcePackOptions(now.resource_pack_options));
  }

  /** Save from the settings screen. A change that alters what a scan finds makes the scan stale. */
  async saveSettings(before: Settings, apiKey = '', beforeMode: CredentialMode = this.credentialMode): Promise<boolean> {
    if (this.busy) return false;
    if (this.scan && this.scopeDiffers(before, this.settings) && !(await this.mayDiscard('settings'))) {
      // Declined: nothing was saved, so the settings screen keeps its unsaved draft.
      this.settings = { ...before };
      this.credentialMode = beforeMode;
      return false;
    }
    if (this.busy) return false;
    this.busy = 'settings';
    const recoveryRevision = this.settingsRecoveryRevision;
    try {
      await this.persistSettings(apiKey);
      const scopeChanged = this.scopeDiffers(before, this.settings);
      if (scopeChanged && this.scan) {
        this.resetJob();
        if (this.step !== 'world') this.step = 'scan';
        this.notify(t('settings.changedScan'), 'info', 8000);
      }
      if (before.ui_language !== this.settings.ui_language) setLocale(this.locale);
      if (JSON.stringify(before.source_overrides) !== JSON.stringify(this.settings.source_overrides)) this.candidates.refetchSoon(0);
      if (this.scan) void this.loadEstimate();
      this.notify(t('settings.saved'), 'success', 2600);
      // A new key makes the provider's model list readable: fetch it so the model box has choices.
      if (apiKey && LISTABLE_PROVIDERS.includes(this.settings.provider)) void this.loadModels(this.settings, true).catch(() => {});
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

  /**
   * Read the provider's model list. Runs beside everything else: it sets `modelsLoading`, not `busy`,
   * so scanning, reviewing and saving settings stay available while a slow provider answers. A second
   * request for the same provider joins the one in flight.
   */
  loadModels(selection: Settings = this.settings, force = false): Promise<number> {
    const scope = this.modelScope(selection);
    const cached = this.modelCatalogs.get(scope);
    if (!force && cached && Date.now() - cached.fetchedAt < 5 * 60_000) {
      this.models = cached.models;
      this.modelsScope = scope;
      this.modelsCached = cached.cached;
      return Promise.resolve(cached.models.length);
    }
    if (this.modelsInFlight?.scope === scope) return this.modelsInFlight.promise;
    const promise = (async () => {
      this.modelsLoading = true;
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
        this.modelsLoading = false;
        this.modelsInFlight = null;
      }
    })();
    this.modelsInFlight = { scope, promise };
    return promise;
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
      if (provider === 'custom') this.keyReentry = false;
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
