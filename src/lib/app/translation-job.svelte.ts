import { SvelteSet } from 'svelte/reactivity';
import {
  BackendError, callBackend, cancelBackend,
  type Candidate, type Estimate, type LastJob, type LastScan, type ProgressEvent, type ResumeStatus,
  type ScanResult, type TranslationResult
} from '../api';
import { CandidateSource } from '../candidates.svelte';
import { needsNewerConfirmation } from '../chunk-coverage';
import { holdClock } from '../clock.svelte';
import { baseName } from '../format';
import { t } from '../i18n/index.svelte';
import { COST_CAP_UNPRICED, costSafety, type CostSafetyKind } from '../cost-safety';
import { cleanOverrides } from '../review';
import { editErrors, emptyProgress, reduceProgress, RESUMABLE_STATUSES, type JobProgress } from '../workflow';
import { fetchTranslationPage, TranslationReview } from '../translation-review.svelte';
import type { AppState } from '../app.svelte';
import { announce } from './notifications';
import { ReviewDraft } from './review-draft.svelte';
import { emptyFailures, type FailureList, type Operation } from './types';

const RESUMABLE = RESUMABLE_STATUSES;
/** Statuses after which the sidecar may hold a saved translation table worth listing. */
const TABLE_STATUSES = ['completed', 'partial', 'failed', 'needs_retry', 'cancelled', 'budget_stopped'];
const FAILURE_PAGE = 50;

export type TranslateOptions = {
  resume?: boolean;
  /** Continuing an interrupted job is the one start allowed while it is open. */
  fromInterrupted?: boolean;
  budgetOverride?: boolean;
  budgetDisabled?: boolean;
  unpricedCapAck?: boolean;
};

/**
 * The job of the open world: the scan and what was chosen from it, the estimate, the translate
 * operations (start, resume, retry, apply, reapply), and everything their results leave behind.
 */
export class TranslationJob {
  scan = $state<ScanResult | null>(null);
  /** The one confirmation per scan that its chunks come from a newer game version than this app was tested with. */
  newerAccepted = $state(false);
  /** When the scan on screen was made (ms), for the return-visit summary. */
  scanAt = $state(0);
  candidates = new CandidateSource(() => ({
    excluded: [...this.excluded],
    manual: Object.keys(this.effectiveOverrides)
  }), (cause) => this.app.describe(cause));
  excluded = new SvelteSet<string>();
  /** What was typed, exactly as typed. `effectiveOverrides` is what counts. */
  overrides = $state<Record<string, string>>({});
  /** Manual translations as sent: trimmed, blank ones dropped. */
  effectiveOverrides = $derived(cleanOverrides(this.overrides));
  estimate = $state<Estimate | null>(null);
  /** True while a newer estimate is on its way, so screens can say "calculating" instead of "unknown". */
  estimateLoading = $state(false);
  failurePolicy = $state<'stop' | 'skip'>('stop');
  /** The core refused a start because a limit is set and the model has no price (`COST_CAP_UNPRICED`). */
  unpricedBlocked = $state(false);
  /** What to run again, with the person's agreement, after the core refused with `COST_CAP_UNPRICED`. */
  unpricedRetry = $state<(() => Promise<void>) | null>(null);
  /** "Keep no limit" was chosen on the run step, so its reminder stays away for this session. */
  noLimitAcknowledged = $state(false);

  progress = $state<JobProgress>(emptyProgress());
  cancelling = $state(false);
  operation = $state<Operation>('translate');
  result = $state<TranslationResult | null>(null);
  /** When `result` arrived (ms), so a screen can say how long ago it was; 0 when there is none. */
  resultAt = $state(0);
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
  /**
   * Single flight for starting or resuming a translation: taken before the first await (the review is
   * stored before the job takes the core) and held until the run has ended. The recovery panel disables its Continue button on it.
   */
  starting = $state(false);
  /** The last start was refused with NEWER_VERSION_UNCONFIRMED, so the confirmation is asked again where it was asked. */
  newerRefused = $state(false);
  /** Choices made before translating, kept in the core per scan plan. */
  readonly draft: ReviewDraft;

  private includedUndo: { excluded: Set<string>; scanPlanId: string; worldDir: string; revision: number } | null = null;
  private undoRevision = 0;
  private undoToastId: number | null = null;
  private releaseClock: (() => void) | null = null;
  private failuresRevision = 0;
  private estimateRevision = 0;

  constructor(private readonly app: AppState) {
    this.draft = new ReviewDraft(app, this);
  }

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
    return Object.keys(this.effectiveOverrides).filter((id) => !this.excluded.has(id)).length;
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

  /** The scan met chunks newer than the newest tested version and the person has not confirmed yet. */
  get newerPending(): boolean {
    return needsNewerConfirmation(this.scan?.chunkCoverage) && !this.newerAccepted;
  }

  get tableStatuses(): string[] {
    return TABLE_STATUSES;
  }

  isResumeStatus(status: string): boolean {
    return RESUMABLE.includes(status);
  }

  // --- the clock ---------------------------------------------------------------------------

  startClock(): void {
    this.releaseClock ??= holdClock();
  }

  stopClock(): void {
    this.releaseClock?.();
    this.releaseClock = null;
  }

  handleProgress(event: ProgressEvent): void {
    this.progress = reduceProgress(this.progress, event);
  }

  dispose(): void {
    this.stopClock();
    this.draft.dispose();
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
    this.draft.reset();
    this.scan = null;
    this.newerAccepted = false;
    this.newerRefused = false;
    this.scanAt = 0;
    this.candidates.reset('');
    this.excluded.clear();
    this.overrides = {};
    this.estimate = null;
    this.result = null;
    this.resultAt = 0;
    this.progress = emptyProgress();
    this.resume = null;
    this.reviewOpen = false;
    this.reviewResumed = false;
    this.reviewOutcome = null;
    this.translationReview.clear();
    this.failuresRevision++;
    this.failures = emptyFailures();
    this.app.recovery.contextDropped();
  }

  applyResume(resumable: ResumeStatus | null | undefined, fallback: { lastJob?: LastJob | null; lastScan?: LastScan | null } = {}): void {
    this.clearIncludedUndo();
    this.lastJob = resumable?.lastJob ?? fallback.lastJob ?? this.lastJob;
    this.lastScan = resumable?.lastScan ?? fallback.lastScan ?? this.lastScan;
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
    this.draft.dirty = false;
    this.draft.version += 1;
    this.scanAt = (resumable.savedAt ?? 0) * 1000;
    this.candidates.reset(resumable.scanPlanId, resumable.candidates, resumable.candidateCount);
    void this.loadEstimate();
    // A checkpoint carries its own choices; without one the stored review draft (if any) applies.
    if (!this.excluded.size && !Object.keys(this.overrides).length) void this.draft.restore(resumable.scanPlanId);
  }

  /** Throw away the saved partial run (and its checkpoint) so the next start begins from scratch. */
  async discardResume(): Promise<boolean> {
    const app = this.app;
    if (!app.worldDir || app.isBusy) return false;
    try {
      await callBackend<{ discarded: number }>('resume.discard', {
        worldDir: app.worldDir,
        ...(this.scan ? { scanPlanId: this.scan.scanPlanId } : {})
      });
      this.resume = null;
      app.notify(t('run.discarded'), 'success');
      return true;
    } catch (cause) {
      app.fail(cause);
      return false;
    }
  }

  // --- scan --------------------------------------------------------------------------------

  async startScan(): Promise<void> {
    const app = this.app;
    if (!app.worldDir || app.isBusy) return;
    if (this.scan && !(await this.draft.mayDiscard('rescan'))) return;
    if (app.isBusy) return;
    if (app.guards.waitForReviewDrafts(() => void this.startScan())) return;
    app.busy = 'scan';
    app.banner = null;
    this.reset();
    this.progress = { ...emptyProgress(), phase: 'collect', startedAt: Date.now() };
    this.startClock();
    let finished = false;
    try {
      await app.persistSettings();
      this.scan = await callBackend<ScanResult>('scan.start', { worldDir: app.worldDir });
      this.scanAt = Date.now();
      if (this.scan.status === 'completed') {
        this.lastScan = this.scan.lastScan ?? { at: Math.floor(Date.now() / 1000), candidateCount: this.scan.candidateCount };
      }
      this.estimate = this.scan.estimate ?? null;
      this.candidates.reset(this.scan.scanPlanId, this.scan.candidates, this.scan.candidateCount);
      finished = this.scan.status === 'completed';
    } catch (cause) {
      app.fail(cause);
    } finally {
      app.busy = '';
      this.stopClock();
      this.progress = emptyProgress();
    }
    const cancelled = this.cancelling;
    this.cancelling = false;
    announce(app, 'scan', finished, cancelled);
    // The same plan (same world and settings) gets its earlier review back.
    if (finished && this.scan) void this.draft.restore(this.scan.scanPlanId);
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
        overrideCandidateIds: Object.keys(this.effectiveOverrides)
      });
      if (revision === this.estimateRevision && signature === this.estimateSignature()) this.estimate = estimate;
    } catch {
      // An unavailable estimate stays unknown (stale costs must not describe new choices).
    } finally {
      if (revision === this.estimateRevision) this.estimateLoading = false;
    }
  }

  private estimateSignature(): string {
    return JSON.stringify([this.scan?.scanPlanId, this.app.settings, this.draft.version]);
  }

  setIncluded(id: string, included: boolean): void {
    if (this.excluded.has(id) === !included) return;
    this.recordIncludedUndo();
    if (included) this.excluded.delete(id);
    else this.excluded.add(id);
    this.draft.changed();
  }

  /** Include or exclude many sentences at once (a whole filtered list) as one review change, with an undo. */
  setIncludedMany(ids: string[], included: boolean): void {
    const before = new Set(this.excluded);
    let changed = false;
    for (const id of ids) {
      if (this.excluded.has(id) === !included) continue;
      if (included) this.excluded.delete(id);
      else this.excluded.add(id);
      changed = true;
    }
    if (!changed) return;
    this.clearIncludedUndo();
    const revision = ++this.undoRevision;
    this.includedUndo = { excluded: before, scanPlanId: this.scan?.scanPlanId ?? '', worldDir: this.app.worldDir, revision };
    this.draft.changed();
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
    this.draft.changed();
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

  /**
   * Keep what was typed exactly as typed (so the box does not jump while typing); `effectiveOverrides`
   * is the trimmed version that is counted, estimated, saved and sent.
   */
  setOverride(id: string, value: string): void {
    const next = { ...this.overrides };
    if (value) next[id] = value;
    else delete next[id];
    this.overrides = next;
    this.draft.changed();
  }

  // --- translate ---------------------------------------------------------------------------

  private get guarded(): boolean {
    const app = this.app;
    return !this.scan || app.isBusy || app.settingsRecoveryRequired || app.credentialRecovery.has(app.settings.provider);
  }

  /** Run `work` as the one start/resume in flight; a second call before it has ended does nothing. */
  async singleFlight(work: () => Promise<void>): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    try {
      await work();
    } finally {
      this.starting = false;
    }
  }

  /**
   * Run one translate-type request with the progress screen up. Returns the outcome, or null when it
   * was refused (the banner says why and the step goes back to where the request started).
   */
  private async runOperation(
    kind: Operation,
    request: () => Promise<TranslationResult>,
    options: { persist: boolean; keepResult: boolean; fromInterrupted?: boolean; onUnpriced?: () => Promise<void> }
  ): Promise<TranslationResult | null> {
    const app = this.app;
    const origin = app.step;
    this.operation = kind;
    let outcome: TranslationResult | null = null;
    app.busy = 'translate';
    this.cancelling = false;
    this.newerRefused = false;
    app.banner = null;
    this.unpricedBlocked = false;
    this.unpricedRetry = null;
    if (!options.keepResult) {
      this.result = null;
      this.resultAt = 0;
    }
    app.step = 'run';
    this.progress = { ...emptyProgress(), phase: 'collect', startedAt: Date.now() };
    this.startClock();
    try {
      if (options.persist) await app.persistSettings();
      outcome = await request();
      return outcome;
    } catch (cause) {
      const code = cause instanceof BackendError ? cause.code : '';
      const interrupted = code === 'REAPPLY_INTERRUPTED';
      if (interrupted && cause instanceof BackendError) {
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
      if (cause instanceof BackendError && code === 'EDITS_INVALID') {
        this.translationReview.setRefused(editErrors(cause.details));
        this.reviewOpen = true;
      }
      const unpriced = code === COST_CAP_UNPRICED;
      if (unpriced) {
        this.unpricedBlocked = true;
        this.unpricedRetry = options.onUnpriced ?? null;
      }
      if (['GLOSSARY_CHANGED', 'GLOSSARY_MISMATCH_UNCONFIRMED'].includes(code)) {
        this.translationReview.reset();
        this.reviewOpen = true;
      }
      // The core asks again: the confirmation did not reach it, so it must be given again.
      if (code === 'NEWER_VERSION_UNCONFIRMED') {
        this.newerAccepted = false;
        this.newerRefused = true;
      }
      // A notice with the choice (set the price, or go on without the limit) explains it; no banner on top.
      if (!interrupted && !(unpriced && options.onUnpriced)) app.fail(cause);
      // A continuation of an interrupted job asks again in its own panel instead of leaving it.
      app.step = kind === 'translate' || kind === 'resume'
        ? (!this.scan ? 'scan' : this.newerRefused && options.fromInterrupted ? 'world' : 'run')
        : origin;
      // An unfinished job of this world must be settled first: take the person to where that happens.
      if (code === 'RECOVERY_REQUIRED') await app.recovery.openInterrupted();
      return null;
    } finally {
      app.busy = '';
      this.stopClock();
      this.progress = emptyProgress();
      const cancelled = this.cancelling || outcome?.status === 'cancelled';
      this.cancelling = false;
      announce(app, 'translate',
        !!outcome && (outcome.status === 'completed' || outcome.status === 'partial' || outcome.status === 'awaiting_review'),
        cancelled, outcome?.status ?? 'failed');
    }
  }

  private get identity() {
    return { worldDir: this.app.worldDir, scanPlanId: this.scan!.scanPlanId };
  }

  async startTranslate(options: TranslateOptions = {}): Promise<void> {
    if (this.app.guards.waitForReviewDrafts(() => void this.startTranslate(options))) return;
    await this.singleFlight(() => this.runTranslate(options));
  }

  /** Runs inside a single flight (see `startTranslate` and the recovery panel's continuation). */
  async runTranslate(options: TranslateOptions): Promise<void> {
    const app = this.app;
    const loaded = this.scan;
    if (!loaded || this.guarded) return;
    // Continuing an interrupted job is the one start allowed while it is open.
    if (app.recovery.interruptedHere.length && !options.fromInterrupted) return;
    // The review is stored before the job takes the core; a draft that cannot be stored is not lost
    // because the job's own checkpoint keeps the reviewed choices.
    await this.draft.store();
    // A scan or reset that began while the review was being stored has replaced what was about to be sent.
    if (this.scan !== loaded || app.isBusy) return;
    const hadResume = !!this.resume;
    const planId = loaded.scanPlanId;
    const kind: Operation = options.resume ? 'resume' : 'translate';
    const outcome = await this.runOperation(kind, () => callBackend<TranslationResult>(options.resume ? 'translate.resume' : 'translate.start', {
      worldDir: app.worldDir,
      fingerprint: loaded.fingerprint,
      scanPlanId: loaded.scanPlanId,
      excludedCandidateIds: [...this.excluded],
      candidateOverrides: this.effectiveOverrides,
      manualOnly: this.manualOnly,
      provider: app.settings.provider,
      model: app.settings.model,
      ...(app.settings.provider === 'custom' ? { baseUrl: app.settings.base_url } : {}),
      wireFormat: app.settings.wire_format,
      failurePolicy: this.failurePolicy,
      ...(this.newerAccepted && needsNewerConfirmation(loaded.chunkCoverage) ? { acceptNewerVersion: true } : {}),
      ...(options.budgetOverride ? { budgetOverride: true } : {}),
      ...(options.unpricedCapAck ? { unpricedCapAck: true } : {}),
      ...(options.budgetDisabled ? { budgetDisabled: true } : {})
    }), {
      persist: true, keepResult: false, fromInterrupted: options.fromInterrupted,
      onUnpriced: () => this.startTranslate({ ...options, unpricedCapAck: true })
    });
    if (outcome) {
      // A new translation replaces the job, so edits made to an older one no longer apply.
      if (!options.resume) this.translationReview.clear();
      await this.settle(outcome, planId);
    } else if (!options.resume && hadResume) {
      // Starting over drops the saved checkpoint; ask what is left rather than offer a stale resume.
      void callBackend<ResumeStatus>('resume.status', { worldDir: app.worldDir })
        .then((resumable) => this.applyResume(resumable))
        .catch(() => { this.resume = null; });
    }
    if (this.draft.dirty) this.draft.scheduleSave(0);
  }

  /** A run that failed before writing anything: start it again from the scan that is still on screen. */
  translateAgain(): void {
    const app = this.app;
    if (!this.scan || app.isBusy || !app.stepReached.run) return;
    this.result = null;
    this.resultAt = 0;
    app.banner = null;
    app.step = 'run';
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
      ...(app.settings.provider === 'custom' ? { baseUrl: app.settings.base_url } : {}),
      wireFormat: app.settings.wire_format,
      ...(options.refreshGlossary ? { refreshGlossary: true } : {}),
      ...(options.budgetOverride ? { budgetOverride: true } : {}),
      ...(options.unpricedCapAck ? { unpricedCapAck: true } : {})
    }), { persist: true, keepResult: true, onUnpriced: () => this.retryFailed({ ...options, unpricedCapAck: true }) });
    if (outcome) await this.settle(outcome);
  }

  /**
   * The person agreed to run without the spending limit after the core refused (or the estimate
   * showed the model has no price). Runs the refused request again with `unpricedCapAck`.
   * With nothing refused, only the run screen's pre-start consent may begin a translation; a review
   * or a result that is open must never be replaced by a fresh paid start from here.
   */
  async consentUnpriced(): Promise<void> {
    const again = this.unpricedRetry;
    this.unpricedRetry = null;
    if (again) { await again(); return; }
    if (this.reviewOpen || this.result || this.resume?.status === 'awaiting_review') return;
    await this.startTranslate({ resume: !!this.resume, unpricedCapAck: true });
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
    if (outcome) await this.settle(outcome, this.scan?.scanPlanId);
  }

  /** Handle what a translate-type request returned: into the review, or onto the result screen. */
  private async settle(outcome: TranslationResult, planId?: string): Promise<void> {
    const app = this.app;
    this.reviewResumed = false;
    if (outcome.status === 'awaiting_review') {
      this.reviewOutcome = outcome;
      app.step = 'run';
      this.reviewOpen = true;
      this.translationReview.reset();
    } else {
      this.result = outcome;
      this.resultAt = Date.now();
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
      // The review has been applied; a stored draft would only come back as a stale suggestion.
      if (outcome.status === 'completed' && planId) void this.draft.clear(planId);
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
    await this.app.openFolder(this.app.worldDir, 'world');
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
