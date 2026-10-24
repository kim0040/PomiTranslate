import type { AppState } from '../app.svelte';

/**
 * Leave protection: unsaved settings, glossary edits, wizard drafts and edits to the translation
 * table are never dropped silently, whether the user navigates away or replaces the job. Closing
 * the window or quitting is the desktop shell's question (see `ExitGate`); this class only tells it
 * whether anything is unsaved.
 */
export class LeaveGuards {
  /** Set by the settings screen while it holds changes that are not saved yet. */
  settingsDirty = $state(false);
  /** Set by the glossary screen while its list has edits that are not saved yet. */
  glossaryDirty = $state(false);
  /** Draft values held by SetupWizard, including a key that has not been saved yet. */
  wizardDirty = $state(false);
  /** A move away from settings or the glossary that waits until the user saves or drops the changes there. */
  pendingLeave = $state<(() => void) | null>(null);
  /** A navigation or job replacement waiting for the user to keep or discard edits to the translation table. */
  pendingReviewLeave = $state<(() => void) | null>(null);
  /** Set by the settings or glossary screen (whichever is open): saves its draft and says whether that worked. */
  saveDraft: (() => Promise<boolean>) | null = null;

  constructor(private readonly app: AppState) {}

  /** Anything the person typed or changed that has not been saved: what the shell asks about on close. */
  get unsaved(): boolean {
    return this.settingsDirty || this.glossaryDirty || this.wizardDirty || this.app.translationReview.dirtyCount > 0;
  }

  /**
   * Only edits to the translation table are unsaved. They have no draft that could be saved and are
   * written to the world only by the separate apply confirmation, so closing offers stay or discard.
   */
  get reviewOnly(): boolean {
    return this.app.translationReview.dirtyCount > 0 && !this.settingsDirty && !this.glossaryDirty && !this.wizardDirty;
  }

  /**
   * Leave the current page. Unsaved settings or glossary edits are never dropped silently: the move
   * waits until that screen asks whether to save them, drop them, or stay.
   */
  leave(next: () => void): void {
    const run = () => {
      if (this.app.page === 'settings') this.app.returnStep = null;
      next();
    };
    if ((this.app.page === 'settings' && this.settingsDirty) || (this.app.page === 'glossary' && this.glossaryDirty)) this.pendingLeave = run;
    else run();
  }

  /** Run `next` once edits to the translation table are kept or discarded; true when it has to wait. */
  waitForReviewDrafts(next: () => void): boolean {
    if (this.app.translationReview.dirtyCount === 0) return false;
    this.pendingReviewLeave = next;
    return true;
  }

  /** Answer for a move that waited on unsaved settings or glossary edits. */
  resolveLeave(proceed: boolean): void {
    const next = this.pendingLeave;
    this.pendingLeave = null;
    if (!proceed || !next) return;
    this.settingsDirty = false;
    this.glossaryDirty = false;
    next();
  }

  /** Keep review edits open, or explicitly discard them before the waiting action proceeds. */
  resolveReviewLeave(discard: boolean): void {
    const next = this.pendingReviewLeave;
    this.pendingReviewLeave = null;
    if (!discard) return;
    this.app.translationReview.discardDrafts();
    next?.();
  }
}
