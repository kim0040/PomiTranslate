import { finishClose, type CloseSource } from '../native';
import type { AppState } from '../app.svelte';

/**
 * Leave and close protection: unsaved settings, wizard drafts and review edits are never dropped
 * silently, whether the user navigates away, replaces the job, or closes the window.
 */
export class LeaveGuards {
  /** Set by the settings screen while it holds changes that are not saved yet. */
  settingsDirty = $state(false);
  /** A glossary dialog owns its draft and must answer navigation/native close in place. */
  glossaryGuard: { leave: (next: () => void) => void; close: (source: CloseSource) => void } | null = null;
  /** Draft values held by SetupWizard, including a key that has not been saved yet. */
  wizardDirty = $state(false);
  /** A move away from settings that waits until the user saves or drops the changes there. */
  pendingLeave = $state<(() => void) | null>(null);
  /** A navigation or job replacement waiting for the user to keep or discard review drafts. */
  pendingReviewLeave = $state<(() => void) | null>(null);
  /** Set while the pending settings decision was requested by a window close or app quit. */
  pendingCloseSource = $state<CloseSource | null>(null);
  pendingCloseContext = $state<'settings' | 'wizard' | 'review' | null>(null);

  constructor(private readonly app: AppState) {}

  /**
   * Leave the current page. Unsaved settings are never dropped silently: the move waits until the
   * settings screen asks whether to save them, drop them, or stay.
   */
  leave(next: () => void): void {
    const run = () => {
      if (this.app.page === 'settings') this.app.returnStep = null;
      next();
    };
    const guarded = () => {
      if (this.glossaryGuard) this.glossaryGuard.leave(guarded);
      else if (this.app.page === 'settings' && this.settingsDirty) this.pendingLeave = guarded;
      else run();
    };
    guarded();
  }

  waitForReviewDrafts(next: () => void): boolean {
    if (this.app.translationReview.dirtyCount === 0) return false;
    this.pendingReviewLeave = next;
    return true;
  }

  /** Show the existing unsaved-settings choice for a native X or app-quit request. */
  handleCloseRequested(source: CloseSource): void {
    if (this.pendingCloseSource) return;
    if (this.glossaryGuard) {
      this.glossaryGuard.close(source);
      return;
    }
    if (this.app.showWizard) {
      this.pendingCloseSource = source;
      this.pendingCloseContext = 'wizard';
      return;
    }
    if (this.app.translationReview.dirtyCount > 0) {
      this.pendingCloseSource = source;
      this.pendingCloseContext = 'review';
      return;
    }
    if (!this.settingsDirty) {
      void finishClose(source);
      return;
    }
    this.app.page = 'settings';
    this.pendingCloseSource = source;
    this.pendingCloseContext = 'settings';
    this.pendingLeave = () => {
      this.pendingCloseSource = null;
      this.pendingCloseContext = null;
      void finishClose(source);
    };
  }

  /** Answer for a move that waited on unsaved settings. */
  resolveLeave(proceed: boolean): void {
    const next = this.pendingLeave;
    this.pendingLeave = null;
    if (!proceed || !next) {
      this.pendingCloseSource = null;
      this.pendingCloseContext = null;
      return;
    }
    this.settingsDirty = false;
    next();
  }

  /** Keep review edits open, or explicitly discard them before the waiting action proceeds. */
  resolveReviewLeave(discard: boolean): void {
    const next = this.pendingReviewLeave;
    const source = this.pendingCloseSource;
    this.pendingReviewLeave = null;
    this.pendingCloseSource = null;
    this.pendingCloseContext = null;
    if (!discard) return;
    this.app.translationReview.discardDrafts();
    if (source) this.handleCloseRequested(source);
    else next?.();
  }

  /** GlossarySheet resolves its own edits first, then returns a native close to this guard. */
  continueCloseAfterGlossary(source: CloseSource): void {
    this.glossaryGuard = null;
    this.settingsDirty = false;
    this.handleCloseRequested(source);
  }

  continueWizardClose(): void {
    if (this.pendingCloseContext !== 'wizard') return;
    this.pendingCloseSource = null;
    this.pendingCloseContext = null;
  }

  discardWizardAndClose(): void {
    if (this.pendingCloseContext !== 'wizard' || !this.pendingCloseSource) return;
    const source = this.pendingCloseSource;
    this.app.showWizard = false;
    this.wizardDirty = false;
    this.pendingCloseSource = null;
    this.pendingCloseContext = null;
    void finishClose(source);
  }

  finishWizardAndClose(): void {
    if (this.pendingCloseContext !== 'wizard' || !this.pendingCloseSource) return;
    const source = this.pendingCloseSource;
    this.app.finishSetup(false);
    this.wizardDirty = false;
    this.pendingCloseSource = null;
    this.pendingCloseContext = null;
    void finishClose(source);
  }
}
