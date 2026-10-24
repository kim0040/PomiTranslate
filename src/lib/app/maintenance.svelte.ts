import { BackendError, callBackend, diagnosticsExport, diagnosticsSnapshot, nativeReset } from '../api';
import { expectedLogFolder, formatDiagnostics, newDiagnosticId } from '../diagnostics';
import { hasMessage, t, type MessageKey } from '../i18n/index.svelte';
import { appVersion, dataLocations, inShell } from '../native';
import { assessReset, type ResetShortfall } from '../reset';
import type { AppState } from '../app.svelte';
import { NOTICE_KEY } from './preferences.svelte';

/** Returning to first launch, and the diagnostics a bug report needs. */
export class Maintenance {
  /** What an incomplete reset left behind; the reset dialog shows it and offers a retry. */
  resetShortfall = $state<ResetShortfall | null>(null);

  constructor(private readonly app: AppState) {}

  /**
   * Return to first launch. Removes preferences, recent worlds, model lists and unfinished jobs, and
   * the saved API keys when asked. World backups stay, so every world can still be restored.
   */
  async resetApp(clearKeys: boolean): Promise<boolean> {
    const app = this.app;
    if (app.isBusy) return false;
    this.resetShortfall = null;
    // The shell's half goes first (saved keys when asked, then the run reports). The core's data is
    // reset only when that half fully worked, so a failed step can simply be tried again. If the
    // core's half fails afterwards, the message says that the keys are already gone.
    let nativeDone = false;
    try {
      const shortfall = assessReset(await nativeReset(clearKeys), clearKeys);
      if (shortfall) {
        this.resetShortfall = shortfall;
        app.banner = { tone: 'error', message: this.resetShortfallLines(shortfall).join(' ') };
        return false;
      }
      nativeDone = true;
      await callBackend('app.reset', { confirm: 'reset' });
      try {
        localStorage.removeItem(NOTICE_KEY);
        localStorage.removeItem('pomi.theme.v1');
        localStorage.removeItem('pomi.fontscale.v1');
      } catch { /* nothing cached */ }
      return true;
    } catch (cause) {
      // An incomplete core reset removed what it could; the other failures removed nothing there.
      const incomplete = cause instanceof BackendError && cause.code === 'RESET_INCOMPLETE';
      const partial = !nativeDone
        ? ''
        : ` ${t(incomplete ? (clearKeys ? 'reset.alsoKeys' : 'reset.alsoReports') : clearKeys ? 'reset.partialKeys' : 'reset.partial')}`;
      const message = `${app.describe(cause)}${partial}`;
      app.banner = { tone: 'error', message };
      // The reset question is a modal: an error behind it would not be seen.
      if (app.feedback.dialogDepth > 0) app.feedback.dialogError = message;
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

  /** Save the diagnostics bundle as a file the person can attach; the clipboard copy is the fallback outside the shell. */
  async saveDiagnostics(): Promise<void> {
    if (!inShell()) return this.copyDiagnostics();
    try {
      if (await diagnosticsExport()) this.app.notify(t('diagnostics.saved'), 'success');
    } catch {
      this.app.notify(t('diagnostics.saveFailed'), 'error');
    }
  }

  /** Put what a bug report needs on the clipboard: versions, last error, log folder. No keys, no world text. */
  async copyDiagnostics(): Promise<void> {
    const app = this.app;
    try {
      const shellText = await diagnosticsSnapshot().catch(() => '');
      const places = await dataLocations();
      const text = formatDiagnostics({
        shellText,
        appVersion: await appVersion(''),
        revision: String((import.meta.env as Record<string, unknown>).VITE_BUILD_REVISION ?? ''),
        uiLocale: app.locale,
        browserLocale: typeof navigator === 'undefined' ? '' : navigator.language,
        platform: typeof navigator === 'undefined' ? '' : navigator.platform,
        provider: app.settings.provider,
        model: app.settings.model,
        lastError: app.feedback.lastError,
        logFolder: expectedLogFolder(places?.app)
      });
      await navigator.clipboard.writeText(text);
      app.notify(t('diagnostics.copied'), 'success');
    } catch {
      app.notify(t('diagnostics.copyFailed'), 'error');
    }
  }

  /** The error boundary caught a failure while drawing the app: keep an id for the diagnostics copy. */
  reportCrash(error: unknown): void {
    this.app.feedback.lastError = {
      code: error instanceof Error && error.name ? `UI_${error.name}`.toUpperCase() : 'UI_CRASH', id: newDiagnosticId(), at: Date.now()
    };
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) console.error('[ui] render failure', error);
  }
}
