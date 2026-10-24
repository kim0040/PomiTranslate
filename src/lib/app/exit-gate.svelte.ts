import { fromShellError } from '../api';
import { t } from '../i18n/index.svelte';
import { cancelExit, cancelUpdate, confirmExit, forceExit, isGoneQuestion, keepWaiting } from '../native';
import type { AppState } from '../app.svelte';

export type ExitPromptState = {
  job: boolean; dirty: boolean; reason: 'quit' | 'update'; intent: number; phase: 'ask' | 'waiting' | 'stuck';
};

/**
 * Leaving the app. The desktop shell owns the question (window close, Alt+F4, Quit, Cmd+Q, an update
 * that restarts the app); this class holds the answer the page gives. A running job offers "cancel and
 * quit" or "keep working"; unsaved work offers save, discard or stay.
 */
export class ExitGate {
  /**
   * The question the shell asked when the window was closed or Quit was chosen: a running job, unsaved
   * settings, or both. `reason: 'update'` is the same question raised by an update that restarts the app.
   * `intent` names the question; every answer carries it. `waiting` follows "cancel and quit"; `stuck`
   * means the job did not stop in time.
   */
  prompt = $state<ExitPromptState | null>(null);

  constructor(private readonly app: AppState) {}

  /** True while a confirmed quit waits for the job to stop. */
  get quitting(): boolean {
    return this.prompt?.phase === 'waiting';
  }

  ask(prompt: { job: boolean; dirty: boolean; reason: 'quit' | 'update'; intent: number }): void {
    this.prompt = { ...prompt, phase: 'ask' };
  }

  waiting(): void {
    this.prompt = { job: true, dirty: false, reason: 'quit', intent: 0, ...this.prompt, phase: 'waiting' };
  }

  stuck(): void {
    this.prompt = { job: true, dirty: false, reason: 'quit', intent: 0, ...this.prompt, phase: 'stuck' };
  }

  /** An install ended however it ended: a question it was waiting on is moot. */
  clearUpdateQuestion(): void {
    if (this.prompt?.reason === 'update') this.prompt = null;
  }

  /**
   * Stay: dismiss the question and tell the shell, which calls off an update that waits for the
   * answer. If the shell no longer has the question, there is nothing more to do.
   */
  stay(): void {
    const prompt = this.prompt;
    this.prompt = null;
    if (prompt?.phase === 'ask' && prompt.intent > 0) void cancelExit(prompt.intent).catch(() => {});
  }

  /**
   * Go on with the question on screen. A quit cancels a running job first and ends when it has
   * stopped; an update question closes here and the install carries on. An answer the shell refuses
   * because the question is gone (it timed out or was replaced) closes the dialog and does nothing else.
   */
  async quit(): Promise<void> {
    const prompt = this.prompt;
    try {
      await confirmExit(prompt?.intent ?? 0);
      if (prompt?.reason === 'update') this.prompt = null;
    } catch (cause) {
      this.prompt = null;
      if (!isGoneQuestion(cause)) this.app.fail(fromShellError(cause));
    }
  }

  /** Save the settings or glossary draft, then go on. A failed save keeps the app open. */
  async saveAndQuit(): Promise<void> {
    const save = this.app.guards.saveDraft;
    const saved = save ? await save() : false;
    if (saved) await this.quit();
    else this.app.notify(t('exit.saveFailed'), 'error', 8000);
  }

  /** "Keep waiting" after the job did not stop in time: the shell repeats the cancel and waits again. */
  async keepWaiting(): Promise<void> {
    try {
      await keepWaiting();
      if (this.prompt) this.prompt = { ...this.prompt, phase: 'waiting' };
    } catch (cause) {
      this.prompt = null;
      this.app.fail(fromShellError(cause));
    }
  }

  /** "Quit now": the job did not stop, so the shell ends the core. */
  async quitNow(): Promise<void> {
    try {
      await forceExit();
    } catch (cause) {
      this.prompt = null;
      this.app.fail(fromShellError(cause));
    }
  }

  async cancelUpdateDownload(): Promise<void> {
    await cancelUpdate();
  }
}
