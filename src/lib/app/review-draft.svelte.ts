import { BackendError, callBackend, type ReviewDraft as StoredDraft } from '../api';
import { t } from '../i18n/index.svelte';
import type { AppState } from '../app.svelte';
import type { TranslationJob } from './translation-job.svelte';
import { UNKNOWN_COMMAND_CODES, type DiscardReason, type DraftState } from './types';

const DRAFT_SAVE_DELAY = 800;
const ESTIMATE_DELAY = 400;

/**
 * The choices made before translating (sentences left out, translations typed by hand), kept in the
 * core per scan plan so closing the app or re-scanning does not lose them. Not to be confused with
 * the edits to the translation table after a run (`TranslationReview`).
 */
export class ReviewDraft {
  state = $state<DraftState>('idle');
  /** The question "drop this unsaved review?" and what to do on yes. */
  prompt = $state<{ reason: DiscardReason; resolve: (agreed: boolean) => void } | null>(null);
  /** Bumped on every include/exclude/override change; screens depend on this instead of the sets. */
  version = $state(0);
  /** The review has changes that are not stored in the core yet. */
  dirty = $state(false);
  /** False once the core answered that it has no draft commands (an older core). */
  supported = $state(true);
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private estimateTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly app: AppState, private readonly job: TranslationJob) {}

  /** Excluded sentences plus manual translations in the review. */
  get count(): number {
    return this.job.excluded.size + Object.keys(this.job.effectiveOverrides).length;
  }

  /**
   * Dropping the review would lose work: it has content and is not stored in the core (or the core
   * cannot store drafts at all). A stored draft is restored on re-scan, so it needs no question.
   */
  get needsConfirm(): boolean {
    return this.count > 0 && (this.dirty || !this.supported);
  }

  /** Forget timers and flags when the job context is dropped. */
  reset(): void {
    if (this.draftTimer) { clearTimeout(this.draftTimer); this.draftTimer = null; }
    if (this.estimateTimer) { clearTimeout(this.estimateTimer); this.estimateTimer = null; }
    this.dirty = false;
    this.state = 'idle';
    this.version += 1;
  }

  dispose(): void {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    if (this.estimateTimer) clearTimeout(this.estimateTimer);
  }

  /**
   * May the review be dropped now? Yes at once when nothing would be lost; otherwise the question
   * is shown (components/DiscardReviewDialog.svelte) and this resolves with the answer. Callers try
   * to store the draft first, so the question only appears when that was not possible.
   */
  async mayDiscard(reason: DiscardReason): Promise<boolean> {
    if (this.dirty) await this.store(true);
    if (!this.needsConfirm) return true;
    this.prompt?.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.prompt = { reason, resolve };
    });
  }

  answer(agreed: boolean): void {
    const prompt = this.prompt;
    this.prompt = null;
    prompt?.resolve(agreed);
  }

  /** A review choice changed (include/exclude or manual text). */
  changed(): void {
    this.version += 1;
    this.job.estimate = null;
    this.job.estimateLoading = true;
    this.dirty = true;
    this.scheduleSave();
    this.scheduleEstimate();
  }

  private scheduleEstimate(): void {
    if (this.estimateTimer) clearTimeout(this.estimateTimer);
    this.estimateTimer = setTimeout(() => {
      this.estimateTimer = null;
      void this.job.loadEstimate();
    }, ESTIMATE_DELAY);
  }

  scheduleSave(delay = DRAFT_SAVE_DELAY): void {
    if (!this.job.scan || !this.supported || this.app.destroyed) return;
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      void this.store();
    }, delay);
  }

  /** Store the review in the core now. Resolves true when nothing is left unstored. */
  async store(force = false): Promise<boolean> {
    if (this.draftTimer) { clearTimeout(this.draftTimer); this.draftTimer = null; }
    const scan = this.job.scan;
    if (!scan || !this.dirty) return !this.dirty;
    if (!this.supported) return false;
    // The core is busy with a job and answers in order; store the draft when it has finished.
    if (this.app.isBusy && !force) return false;
    const version = this.version;
    this.state = 'saving';
    try {
      await callBackend('review.draft.set', {
        scanPlanId: scan.scanPlanId,
        excludedCandidateIds: [...this.job.excluded],
        candidateOverrides: this.job.effectiveOverrides
      });
      if (this.job.scan?.scanPlanId === scan.scanPlanId && version === this.version) this.dirty = false;
      this.state = 'saved';
      return !this.dirty;
    } catch (cause) {
      const code = cause instanceof BackendError ? cause.code : '';
      if (UNKNOWN_COMMAND_CODES.includes(code)) {
        this.supported = false;
        this.state = 'idle';
      } else if (code === 'DRAFT_TOO_LARGE') {
        this.state = 'error';
        this.app.notify(t('review.draft.tooLarge'), 'error');
      } else if (code === 'PLAN_NOT_FOUND') {
        this.state = 'error';
      } else {
        this.state = 'error';
        this.scheduleSave(5000);
      }
      return false;
    }
  }

  /** Bring back the review stored for this scan plan, unless the person already changed it. */
  async restore(planId: string): Promise<void> {
    if (!this.supported) return;
    const version = this.version;
    try {
      const draft = await callBackend<StoredDraft>('review.draft.get', { scanPlanId: planId });
      if (!draft.exists || this.job.scan?.scanPlanId !== planId || version !== this.version) return;
      const ids = draft.excludedCandidateIds ?? [];
      const typed = draft.candidateOverrides ?? {};
      if (!ids.length && !Object.keys(typed).length) return;
      this.job.excluded.clear();
      for (const id of ids) this.job.excluded.add(id);
      this.job.overrides = { ...typed };
      this.dirty = false;
      this.state = 'saved';
      this.version += 1;
      this.job.candidates.refetchSoon(0);
      void this.job.loadEstimate();
      this.app.notify(t('review.draft.restored', { excluded: ids.length, manual: Object.keys(typed).length }), 'info', 6000);
    } catch (cause) {
      if (cause instanceof BackendError && UNKNOWN_COMMAND_CODES.includes(cause.code)) this.supported = false;
      // A draft that cannot be read is simply absent: the review starts empty.
    }
  }

  /** Remove the stored draft once the review has been applied (or thrown away on purpose). */
  async clear(planId: string): Promise<void> {
    if (!this.supported) return;
    try {
      await callBackend('review.draft.clear', { scanPlanId: planId });
    } catch (cause) {
      if (cause instanceof BackendError && UNKNOWN_COMMAND_CODES.includes(cause.code)) this.supported = false;
    }
  }
}
