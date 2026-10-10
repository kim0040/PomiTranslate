import { SvelteSet } from 'svelte/reactivity';
import {
  BackendError, callBackend, cancelBackend,
  type Candidate, type Estimate, type LastJob, type LastScan, type ProgressEvent, type ResumeStatus,
  type ScanResult, type TranslationResult
} from '../api';
import { CandidateSource } from '../candidates.svelte';
import { baseName } from '../format';
import { t } from '../i18n/index.svelte';
import { COST_CAP_UNPRICED, costSafety, type CostSafetyKind } from '../cost-safety';
import { editErrors, emptyProgress, reduceProgress, RESUMABLE_STATUSES, type JobProgress } from '../workflow';
import { fetchTranslationPage, TranslationReview } from '../translation-review.svelte';
import { revealWorldFolder } from '../native';
import type { AppState } from '../app.svelte';
import { notifyAfterJob } from './notifications';
import { emptyFailures, type FailureList, type Operation } from './types';

const RESUMABLE = RESUMABLE_STATUSES;
/** Statuses after which the sidecar may hold a saved translation table worth listing. */
const TABLE_STATUSES = ['completed', 'partial', 'failed', 'needs_retry', 'cancelled', 'budget_stopped'];
const FAILURE_PAGE = 50;

/**
 * The job of the open world: the scan and what was chosen from it, the estimate, the translate
 * operations (start, resume, retry, apply, reapply), and everything their results leave behind.
 */
export class TranslationJob {
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
  /** The core refused a start because a limit is set and the model has no price (`cost_cap_unpriced`). */
  unpricedBlocked = $state(false);
  /** What to run again, with the person's agreement, after the core refused with `cost_cap_unpriced`. */
  unpricedRetry = $state<(() => Promise<void>) | null>(null);
  /** "Keep no limit" was chosen on the run step, so its reminder stays away for this session. */
  noLimitAcknowledged = $state(false);

  progress = $state<JobProgress>(emptyProgress());
  /** The one clock the sidebar and the run screen both read, so their timers never drift apart. */
  now = $state(Date.now());
  cancelling = $state(false);
  operation = $state<Operation>('translate');
  result = $state<TranslationResult | null>(null);
  /** The translation table of the current job: rows from the sidecar plus the user's unsaved edits. */
  translationReview = new TranslationReview(() => (this.scan && this.app.worldDir ? { worldDir: this.app.worldDir, scanPlanId: this.scan.scanPlanId } : null));
  /** The review view is showing (in the run step before applying, or in the result step for corrections). */
  reviewOpen = $state(false);
  /** Counts and usage of the run that stopped for review. */
  reviewOutcome = $state<TranslationResult | null>(null);
  /** The review was reopened from a saved job at start-up, so it says where the translations came from. */
  reviewResumed = $state(false);
  failures = $state<FailureList>(emptyFailures());
  resume = $state<ResumeStatus | null>(null);
  lastJob = $state<LastJob | null>(null);
  lastScan = $state<LastScan | null>(null);
  /** The recovery snapshot of the last restore, until the next scan or world change replaces the job. */
  lastRestoreId = $state('');

  private includedUndo: { excluded: Set<string>; scanPlanId: string; worldDir: string; revision: number } | null = null;
  private undoRevision = 0;
  private undoToastId: number | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;
  private failuresRevision = 0;
  private estimateRevision = 0;

  constructor(private readonly app: AppState) {}

  /** Where the estimate stands against the spending limit (see cost-safety.ts). */
  get costSafety(): CostSafetyKind {
    const kind = costSafety({
      manualOnly: this.manualOnly, estimate: this.estimate, loading: this.estimateLoading, cap: this.app.settings.max_cost_usd
    });
    // A refusal from the core counts even when the estimate looked priced.
    return this.unpricedBlocked && (this.app.settings.max_cost_usd ?? 0) > 0 && kind !== 'free' ? 'unpriced' : kind;
  }

  // --- derived numbers used across screens ---------------------------------------------------

  get candidateCount(): number {
    return this.scan?.candidateCount ?? 0;
  }

  get manualCount(): number {
    if (this.estimate && Object.keys(this.app.settings.source_overrides ?? {}).length) return Math.max(0, this.includedCount - this.estimate.candidateCount);
    return Object.entries(this.overrides).filter(([id, value]) => value.trim() && !this.excluded.has(id)).length;
  }

  manualTranslation(candidate: Candidate): string {
    const saved = this.app.settings.source_overrides ?? {};
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

  get tableStatuses(): string[] {
    return TABLE_STATUSES;
  }

  isResumeStatus(status: string): boolean {
    return RESUMABLE.includes(status);
  }

  // --- the clock ---------------------------------------------------------------------------

  startClock(): void {
    this.now = Date.now();
    if (!this.clock) this.clock = setInterval(() => { this.now = Date.now(); }, 500);
  }

  stopClock(): void {
    if (this.clock) clearInterval(this.clock);
    this.clock = null;
  }

  handleProgress(event: ProgressEvent): void {
    this.progress = reduceProgress(this.progress, event);
  }

  // --- reset and resume --------------------------------------------------------------------

  /** Forget the scan and everything chosen or produced from it. */
  reset(): void {
    this.clearIncludedUndo();
    this.lastRestoreId = '';
    this.estimateRevision++;
    this.estimateLoading = false;
    this.unpricedBlocked = false;
    this.unpricedRetry = null;
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

  applyResume(resumable: ResumeStatus | null | undefined, fallback: { lastJob?: LastJob | null; lastScan?: LastScan | null } = {}): void {
    this.clearIncludedUndo();
    this.lastJob = resumable?.lastJob ?? fallback.lastJob ?? null;
    this.lastScan = resumable?.lastScan ?? fallback.lastScan ?? null;
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
    const app = this.app;
    if (!app.worldDir || app.isBusy) return;
    if (app.guards.waitForReviewDrafts(() => void this.startScan())) return;
    const startedAt = Date.now();
    let notificationStatus = 'failed';
    app.busy = 'scan';
    app.banner = null;
    this.reset();
    this.progress = { ...emptyProgress(), phase: 'collect', startedAt: Date.now() };
    this.startClock();
    try {
      await app.persistSettings();
      this.scan = await callBackend<ScanResult>('scan.start', { worldDir: app.worldDir });
      if (this.scan.status === 'completed') {
        this.lastScan = this.scan.lastScan ?? { at: Math.floor(Date.now() / 1000), candidateCount: this.scan.candidateCount };
      }
      notificationStatus = this.scan.status === 'completed' ? 'completed' : this.scan.status;
      this.estimate = this.scan.estimate ?? null;
      this.candidates.reset(this.scan.scanPlanId, this.scan.candidates, this.scan.candidateCount);
    } catch (cause) {
      app.fail(cause);
    } finally {
      app.busy = '';
      this.stopClock();
      this.progress = emptyProgress();
      notifyAfterJob(app, 'scan', startedAt, { status: notificationStatus, candidates: this.scan?.candidateCount });
    }
  }

  async loadEstimate(): Promise<void> {
    if (!this.scan) return;
    const revision = ++this.estimateRevision;
    const planId = this.scan.scanPlanId;
    const signature = this.estimateSignature();
    this.estimate = null;
    this.estimateLoading = true;
    this.unpricedBlocked = false;
    this.unpricedRetry = null;
    try {
      const estimate = await callBackend<Estimate>('estimate.get', {
        scanPlanId: planId,
        excludedCandidateIds: [...this.excluded],
        overrideCandidateIds: Object.entries(this.overrides).filter(([, value]) => value.trim()).map(([id]) => id)
      });
      if (revision === this.estimateRevision && signature === this.estimateSignature()) this.estimate = estimate;
    } catch {
      // An unavailable estimate stays unknown (stale costs must not describe new choices), but it is said once.
      this.app.notify(t('quiet.estimateFailed'), 'info', 8000);
    } finally {
      if (revision === this.estimateRevision) this.estimateLoading = false;
    }
  }

  private estimateSignature(): string {
    return JSON.stringify([this.scan?.scanPlanId, this.app.settings, [...this.excluded].sort(),
      Object.entries(this.overrides).filter(([, value]) => value.trim()).map(([id]) => id).sort()]);
  }

  setIncluded(id: string, included: boolean): void {
    if (this.excluded.has(id) === !included) return;
    this.recordIncludedUndo();
    this.estimate = null;
    if (included) this.excluded.delete(id);
    else this.excluded.add(id);
  }

  setIncludedMany(ids: string[], included: boolean): void {
    const revision = this.recordIncludedUndo();
    this.estimate = null;
    for (const id of ids) {
      if (included) this.excluded.delete(id);
      else this.excluded.add(id);
    }
    this.undoToastId = this.app.notify(t('review.bulkUndoReady'), 'info', 10000, {
      label: t('review.undo'),
      run: () => { this.undoIncludedFor(revision); }
    });
  }

  undoIncluded(): boolean {
    return this.undoIncludedFor();
  }

  private undoIncludedFor(revision?: number): boolean {
    const record = this.includedUndo;
    if (!record || (revision !== undefined && record.revision !== revision)) return false;
    if (!this.scan || record.scanPlanId !== this.scan.scanPlanId || record.worldDir !== this.app.worldDir) {
      this.clearIncludedUndo();
      return false;
    }
    this.excluded.clear();
    for (const id of record.excluded) this.excluded.add(id);
    this.clearIncludedUndo();
    this.estimate = null;
    void this.loadEstimate();
    return true;
  }

  private recordIncludedUndo(): number {
    this.clearIncludedUndo();
    const revision = ++this.undoRevision;
    this.includedUndo = {
      excluded: new Set(this.excluded), scanPlanId: this.scan?.scanPlanId ?? '', worldDir: this.app.worldDir, revision
    };
    return revision;
  }

  private clearIncludedUndo(): void {
    this.includedUndo = null;
    this.undoRevision += 1;
    if (this.undoToastId !== null) this.app.dismissToast(this.undoToastId);
    this.undoToastId = null;
  }

  setOverride(id: string, value: string): void {
    this.estimate = null;
    const next = { ...this.overrides };
    if (value) next[id] = value;
    else delete next[id];
    this.overrides = next;
  }

  // --- translate ---------------------------------------------------------------------------

  private get guarded(): boolean {
    const app = this.app;
    return !this.scan || app.isBusy || app.settingsRecoveryRequired || app.credentialRecovery.has(app.settings.provider);
  }

  /**
   * Run one translate-type request with the progress screen up. Returns the outcome, or null when it
   * was refused (the banner says why and the step goes back to where the request started).
   */
  private async runOperation(
    kind: Operation,
    request: () => Promise<TranslationResult>,
    options: { persist: boolean; keepResult: boolean; onUnpriced?: () => Promise<void> }
  ): Promise<TranslationResult | null> {
    const app = this.app;
    const origin = app.step;
    this.operation = kind;
    const startedAt = Date.now();
    let outcome: TranslationResult | null = null;
    app.busy = 'translate';
    this.cancelling = false;
    app.banner = null;
    this.unpricedBlocked = false;
    this.unpricedRetry = null;
    if (!options.keepResult) this.result = null;
    app.step = 'run';
    this.progress = { ...emptyProgress(), phase: 'collect', startedAt: Date.now() };
    this.startClock();
    try {
      if (options.persist) await app.persistSettings();
      outcome = await request();
      return outcome;
    } catch (cause) {
      const interrupted = cause instanceof BackendError && cause.code === 'REAPPLY_INTERRUPTED';
      if (interrupted) {
        const recoverySetId = (cause.details && typeof cause.details === 'object' && 'recoverySetId' in cause.details)
          ? (cause.details as { recoverySetId?: unknown }).recoverySetId : undefined;
        if (typeof recoverySetId === 'string' && recoverySetId) {
          if (this.translationReview.meta) this.translationReview.meta = { ...this.translationReview.meta, status: 'reapply_interrupted', recoverySetId };
          if (this.resume) this.resume = { ...this.resume, status: 'reapply_interrupted', recoverySetId };
          if (this.lastJob) this.lastJob = { ...this.lastJob, status: 'reapply_interrupted' };
          this.reviewOpen = true;
          app.step = 'result';
          this.translationReview.reset();
        }
      }
      if (cause instanceof BackendError && cause.code === 'EDITS_INVALID') {
        this.translationReview.setRefused(editErrors(cause.details));
        this.reviewOpen = true;
      }
      const unpriced = cause instanceof BackendError && cause.code === COST_CAP_UNPRICED;
      if (unpriced) {
        this.unpricedBlocked = true;
        this.unpricedRetry = options.onUnpriced ?? null;
      }
      if (cause instanceof BackendError && ['GLOSSARY_CHANGED', 'GLOSSARY_MISMATCH_UNCONFIRMED'].includes(cause.code)) {
        this.translationReview.reset();
        this.reviewOpen = true;
      }
      // A notice with the choice (set the price, or go on without the limit) explains it; no banner on top.
      if (!interrupted && !(unpriced && options.onUnpriced)) app.fail(cause);
      app.step = kind === 'translate' || kind === 'resume' ? (this.scan ? 'run' : 'scan') : origin;
      return null;
    } finally {
      app.busy = '';
      this.cancelling = false;
      this.stopClock();
      this.progress = emptyProgress();
      notifyAfterJob(app, 'translation', startedAt, {
        status: outcome?.status ?? 'failed', translated: outcome?.translation?.translated, failed: outcome?.translation?.failed
      });
    }
  }

  private get identity() {
    return { worldDir: this.app.worldDir, scanPlanId: this.scan!.scanPlanId };
  }

  async startTranslate(options: { resume?: boolean; budgetOverride?: boolean; budgetDisabled?: boolean; unpricedCapAck?: boolean } = {}): Promise<void> {
    const app = this.app;
    if (this.guarded) return;
    if (app.guards.waitForReviewDrafts(() => void this.startTranslate(options))) return;
    const kind: Operation = options.resume ? 'resume' : 'translate';
    const hadResume = !!this.resume;
    const outcome = await this.runOperation(kind, () => callBackend<TranslationResult>(options.resume ? 'translate.resume' : 'translate.start', {
      worldDir: app.worldDir,
      fingerprint: this.scan!.fingerprint,
      scanPlanId: this.scan!.scanPlanId,
      excludedCandidateIds: [...this.excluded],
      candidateOverrides: this.overrides,
      manualOnly: this.manualOnly,
      provider: app.settings.provider,
      model: app.settings.model,
      ...(app.settings.provider === 'custom' ? { baseUrl: app.settings.base_url } : {}),
      wireFormat: app.settings.wire_format,
      failurePolicy: this.failurePolicy,
      ...(options.budgetOverride ? { budgetOverride: true } : {}),
      ...(options.unpricedCapAck ? { unpricedCapAck: true } : {}),
      ...(options.budgetDisabled ? { budgetDisabled: true } : {})
    }), { persist: true, keepResult: false, onUnpriced: () => this.startTranslate({ ...options, unpricedCapAck: true }) });
    if (outcome) {
      // A new translation replaces the job, so edits made to an older one no longer apply.
      if (!options.resume) this.translationReview.clear();
      await this.settle(outcome);
    } else if (!options.resume && hadResume) {
      // Starting over drops the saved checkpoint; ask what is left rather than offer a stale resume.
      void callBackend<ResumeStatus>('resume.status', { worldDir: app.worldDir })
        .then((resumable) => this.applyResume(resumable))
        .catch(() => { this.resume = null; this.app.notify(t('quiet.resumeFailed'), 'info', 8000); });
    }
  }

  /** Send only the failed and unsent rows to the AI again. The result comes back for review. */
  async retryFailed(options: { budgetOverride?: boolean; refreshGlossary?: boolean; unpricedCapAck?: boolean } = {}): Promise<void> {
    const app = this.app;
    if (this.guarded) return;
    if (app.guards.waitForReviewDrafts(() => void this.retryFailed(options))) return;
    const outcome = await this.runOperation('retry', () => callBackend<TranslationResult>('translate.retry_failed', {
      ...this.identity,
      provider: app.settings.provider,
      model: app.settings.model,
      ...(options.refreshGlossary ? { refreshGlossary: true } : {}),
      ...(options.budgetOverride ? { budgetOverride: true } : {}),
      ...(options.unpricedCapAck ? { unpricedCapAck: true } : {})
    }), { persist: true, keepResult: true, onUnpriced: () => this.retryFailed({ ...options, unpricedCapAck: true }) });
    if (outcome) await this.settle(outcome);
  }

  /**
   * The person agreed to run without the spending limit after the core refused (or the estimate
   * showed the model has no price). Runs the refused request again with `unpricedCapAck`.
   */
  async consentUnpriced(): Promise<void> {
    const again = this.unpricedRetry;
    this.unpricedRetry = null;
    if (again) await again();
    else await this.startTranslate({ resume: !!this.resume && this.resume.status !== 'awaiting_review', unpricedCapAck: true });
  }

  /** Write the reviewed translations (and edits) into the world. No AI request is sent. */
  async applyTranslations(): Promise<void> {
    if (this.guarded) return;
    const review = this.translationReview;
    const corrections = !!review.meta?.applied;
    const outcome = await this.runOperation(corrections ? 'reapply' : 'apply', () => callBackend<TranslationResult>(corrections ? 'translate.reapply' : 'translate.apply', {
      ...this.identity,
      fingerprint: this.scan!.fingerprint,
      edits: review.edits(),
      acknowledgeGlossaryMismatch: review.meta?.glossaryActive === true
    }), { persist: false, keepResult: true });
    if (outcome) await this.settle(outcome);
  }

  /** Handle what a translate-type request returned: into the review, or onto the result screen. */
  private async settle(outcome: TranslationResult): Promise<void> {
    const app = this.app;
    this.reviewResumed = false;
    if (outcome.status === 'awaiting_review') {
      this.reviewOutcome = outcome;
      app.step = 'run';
      this.reviewOpen = true;
      this.translationReview.reset();
    } else {
      this.result = outcome;
      this.reviewOutcome = null;
      this.reviewOpen = false;
      app.step = 'result';
      this.lastJob = {
        world: baseName(app.worldDir), at: Date.now() / 1000, status: outcome.status,
        translated: outcome.translation?.translated ?? 0, failed: outcome.translation?.failed ?? 0,
        changedFiles: outcome.changedFileCount, candidateCount: outcome.candidateCount
      };
      if (outcome.status === 'completed' || outcome.status === 'partial') this.translationReview.settle();
      this.failuresRevision++;
      this.failures = emptyFailures();
    }
    try { await app.loadBackups(); } catch { app.notify(t('quiet.backupsFailed'), 'info', 8000); }
    if (RESUMABLE.includes(outcome.status)) {
      try {
        this.applyResume(await callBackend<ResumeStatus>('resume.status', { worldDir: app.worldDir }));
        // A resumed job keeps its reviewed choices: applyResume rebuilds them from the checkpoint.
      } catch {
        // The result screen offers a fresh start instead.
        app.notify(t('quiet.resumeFailed'), 'info', 8000);
      }
    } else {
      this.resume = null;
    }
  }

  /** Show the translation table of the current job, in the step the user is on (run, or result for corrections). */
  openReview(): void {
    if (!this.scan) return;
    if (this.app.step !== 'result') this.app.step = 'run';
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
    if (!this.scan || !this.app.worldDir) return;
    const revision = more ? this.failuresRevision : ++this.failuresRevision;
    const offset = more ? this.failures.rows.length : 0;
    if (!more) this.failures = { ...emptyFailures(), loading: true };
    else this.failures.loading = true;
    try {
      const page = await fetchTranslationPage(this.identity, { state: 'errored', offset, limit: FAILURE_PAGE });
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

  async revealWorld(): Promise<void> {
    try {
      await revealWorldFolder(this.app.worldDir);
    } catch (cause) {
      this.app.fail(cause);
    }
  }

  async cancel(): Promise<void> {
    if (!this.app.isBusy || this.cancelling) return;
    try {
      if (await cancelBackend()) this.cancelling = true;
    } catch (cause) {
      this.app.fail(cause);
    }
  }
}
