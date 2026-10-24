import {
  callBackend,
  type BootstrapPayload, type InterruptedJob, type RecoveryResult, type ResumeStatus
} from '../api';
import { needsNewerConfirmation } from '../chunk-coverage';
import { t } from '../i18n/index.svelte';
import { emptyProgress } from '../workflow';
import type { AppState } from '../app.svelte';
import { announce } from './notifications';
import { samePath } from './types';

/**
 * Work an earlier run left half done, found at start-up: undo it (restore from the backup the run
 * made), keep the files as they are, or continue the remaining work from the same checkpoint.
 */
export class Recovery {
  jobs = $state<InterruptedJob[]>([]);
  /** The finished recovery the person is looking at (its job leaves the list once decided). */
  result = $state<{ job: InterruptedJob; result: RecoveryResult } | null>(null);
  jobId = $state('');
  /** The blocking job to point at after a request was refused with RECOVERY_REQUIRED. */
  highlightedJobId = $state('');
  /** The interrupted job whose continuation waits for the newer-version confirmation, shown in the recovery panel itself. */
  continuation = $state<InterruptedJob | null>(null);
  /** The saved scan the continuation was asked for; the confirmation is only sent while the loaded resume and scan are still this one. */
  private continuationPlan = '';
  /** Bumped whenever the loaded job context is dropped; a recovery lookup that began under an older value is discarded. */
  private generation = 0;

  constructor(private readonly app: AppState) {}

  /** Interrupted work on the world that is open. Translating or restoring it first would hide it. */
  get interruptedHere(): InterruptedJob[] {
    return this.jobs.filter((job) => samePath(job.worldPath, this.app.worldDir));
  }

  /** The job context was dropped (scan, reset, world switch): a pending continuation belongs to a context that is gone. */
  contextDropped(): void {
    this.continuation = null;
    this.continuationPlan = '';
    this.generation++;
  }

  /**
   * Decide what to do with work an earlier run left half done: undo it (restore from the backup the
   * run made) or keep the files as they are. The core makes a recovery backup first and keeps any
   * file that changed since as a conflict instead of overwriting it.
   */
  async recover(job: InterruptedJob, mode: 'rollback' | 'keep', options: { acceptConflicts?: boolean } = {}): Promise<RecoveryResult | null> {
    const app = this.app;
    if (app.isBusy) return null;
    if (this.continuation?.jobId === job.jobId) this.cancelContinuation();
    app.busy = 'recovery';
    this.jobId = job.jobId;
    app.banner = null;
    app.job.progress = { ...emptyProgress(), phase: 'recovery', startedAt: Date.now() };
    let result: RecoveryResult | null = null;
    try {
      result = await callBackend<RecoveryResult>('recovery.start', {
        jobId: job.jobId, mode, ...(mode === 'keep' && options.acceptConflicts ? { acceptConflicts: true } : {})
      });
      this.result = { job, result };
      // A decided job no longer needs attention; one that is partial or in conflict stays listed.
      if (result.state !== 'partial' && result.state !== 'recovery_conflict') this.jobs = this.jobs.filter((item) => item.jobId !== job.jobId);
      // Undoing an unpublished resume puts the earlier job back in the list: the core knows, not this page.
      if (result.settledBy === 'unpublished_continuation') await this.refresh();
      if (samePath(job.worldPath, app.worldDir)) {
        app.job.reset();
        app.step = 'world';
        await app.loadBackups().catch(() => {});
      }
    } catch (cause) {
      app.fail(cause);
    } finally {
      app.busy = '';
      this.jobId = '';
      app.job.progress = emptyProgress();
    }
    announce(app, 'recovery', !!result && (result.state === 'rolled_back' || result.state === 'kept'), false);
    return result;
  }

  /** Ask the core which jobs are still open; the list stays as it was when the core cannot answer. */
  private async refresh(): Promise<void> {
    try {
      const boot = await callBackend<BootstrapPayload>('app.bootstrap');
      this.jobs = Array.isArray(boot.interruptedJobs) ? boot.interruptedJobs : this.jobs;
    } catch { /* the list stays as it was */ }
  }

  /** Reload the interrupted jobs (the list only changes at start-up and after a decision) and show them. */
  async openInterrupted(): Promise<void> {
    await this.refresh();
    const here = this.interruptedHere;
    this.highlightedJobId = (here.find((job) => job.blocking) ?? here[0])?.jobId ?? '';
    this.app.step = 'world';
  }

  /** "Continue the remaining work" of a partial job: the same checkpoint, resumed. */
  async continueInterrupted(job: InterruptedJob): Promise<void> {
    const app = this.app;
    const work = app.job;
    if (work.starting || app.isBusy || !samePath(job.worldPath, app.worldDir)) return;
    await work.singleFlight(async () => {
      // A confirmation already given for this same saved scan (on the run step) still counts after it is loaded again.
      const confirmedPlan = work.newerAccepted ? work.scan?.scanPlanId : '';
      const generation = this.generation;
      let status: ResumeStatus;
      try {
        status = await callBackend<ResumeStatus>('resume.status', { worldDir: app.worldDir });
      } catch (cause) {
        if (generation === this.generation) app.fail(cause);
        return;
      }
      // A scan, reset, world switch or cancel happened while the lookup ran: its answer belongs to a context that is gone.
      if (generation !== this.generation) return;
      work.applyResume(status);
      if (!work.resume || !work.scan) {
        app.notify(t('interrupted.continueUnavailable'), 'error');
        return;
      }
      if (confirmedPlan && confirmedPlan === work.scan.scanPlanId) work.newerAccepted = true;
      if (needsNewerConfirmation(work.scan.chunkCoverage) && !work.newerAccepted) {
        // Ask here, in the recovery panel, with the saved job still selected; nothing is sent until it is ticked.
        this.continuation = job;
        this.continuationPlan = work.scan.scanPlanId;
        return;
      }
      await this.runContinuation();
    });
  }

  /** The newer-version box of the recovery panel is ticked: send the continuation with that confirmation. */
  async confirmContinuation(): Promise<void> {
    const app = this.app;
    const work = app.job;
    if (work.starting || !this.continuation || app.isBusy || !work.newerAccepted || !work.scan || !work.resume) return;
    await work.singleFlight(async () => {
      const job = this.continuation;
      // Only the job, scan and checkpoint the question was asked about may be sent.
      if (!job || !samePath(job.worldPath, app.worldDir) || this.continuationPlan !== work.scan?.scanPlanId || work.resume?.scanPlanId !== work.scan?.scanPlanId) {
        this.cancelContinuation();
        app.notify(t('interrupted.continueUnavailable'), 'error');
        return;
      }
      await this.runContinuation();
    });
  }

  /** Leave the confirmation without continuing; the job stays open and the box is unticked. */
  cancelContinuation(): void {
    this.generation++;
    this.continuation = null;
    this.continuationPlan = '';
    this.app.job.newerAccepted = false;
  }

  /** Runs inside the single flight of continueInterrupted / confirmContinuation. */
  private async runContinuation(): Promise<void> {
    const app = this.app;
    const work = app.job;
    if (!work.resume || !work.scan || work.resume.scanPlanId !== work.scan.scanPlanId) {
      app.notify(t('interrupted.continueUnavailable'), 'error');
      return;
    }
    app.step = 'run';
    await work.runTranslate({ resume: true, fromInterrupted: true });
    // Refused for the confirmation: stay on it (it is asked again) instead of leaving for the world screen.
    if (work.newerRefused) return;
    this.continuation = null;
    this.continuationPlan = '';
    // A finished continuation settles the job; its list entry is refreshed from the core.
    await this.openInterrupted();
    if (!this.interruptedHere.length) app.step = 'result';
  }

  closeResult(): void {
    this.result = null;
  }
}
