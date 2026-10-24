import { BackendError } from '../api';
import { describeError } from '../errors';
import { newDiagnosticId } from '../diagnostics';
import { t } from '../i18n/index.svelte';
import type { Toast, Tone, ToastAction } from './types';

export type Banner = { id: number; tone: 'error' | 'warning'; message: string; count: number; action?: 'enter-key' };

/** The most banners shown at once; a flood of failures should not push the page off screen. */
const MAX_BANNERS = 3;

/** What the feedback needs to know about the rest of the app (absent in unit tests). */
export type FeedbackHost = {
  /** True while a confirmed quit waits for the job to stop: the app is on its way out and errors raised then are noise. */
  quitting(): boolean;
  /** The saved Custom key predates address binding (CREDENTIAL_ENDPOINT_UNBOUND): Settings must ask for it again. */
  keyNeedsReentry(): void;
};

/**
 * The error banners and the toasts: everything the app tells the user outside a screen's own
 * content. A new error is added beside the older ones (the same message only counts up), so a
 * second failure never hides the reason for the first.
 */
export class Feedback {
  banners = $state<Banner[]>([]);
  toasts = $state<Toast[]>([]);
  /** Dialogs currently open, and the latest error to show inside them. */
  dialogDepth = $state(0);
  dialogError = $state('');
  /** The last failure the person was shown, for the diagnostics copy. */
  lastError = $state<{ code: string; id: string; at: number } | null>(null);
  private serial = 0;

  constructor(private readonly host?: FeedbackHost) {}

  /** The newest banner, if any. Setting it adds a banner; setting null clears them all. */
  get banner(): Banner | null {
    return this.banners.at(-1) ?? null;
  }

  set banner(value: { tone: 'error' | 'warning'; message: string; action?: 'enter-key' } | null) {
    if (value) this.addBanner(value.tone, value.message, value.action);
    else this.banners = [];
  }

  addBanner(tone: 'error' | 'warning', message: string, action?: 'enter-key'): void {
    const same = this.banners.find((banner) => banner.message === message && banner.tone === tone);
    if (same) {
      this.banners = this.banners.map((banner) => (banner === same ? { ...banner, count: banner.count + 1 } : banner));
      return;
    }
    this.banners = [...this.banners, { id: ++this.serial, tone, message, count: 1, ...(action ? { action } : {}) }].slice(-MAX_BANNERS);
  }

  dismissBanner(id: number): void {
    this.banners = this.banners.filter((banner) => banner.id !== id);
  }

  /**
   * Show a toast. One that offers an action, and every error, stays until it is dismissed: they
   * carry something to read or press, which a timer must not take away. Plain news leaves on its
   * own after `ms` (components/Toasts.svelte holds that timer while the pointer or focus is on the
   * toast). The same message is never stacked twice.
   */
  notify(message: string, tone: Tone = 'info', ms = 5200, action?: ToastAction): number {
    // While a confirmed quit waits for the job to stop, the refreshes the end of the job sets off are
    // refused (APP_QUITTING) and nothing reported then can be acted on.
    if (tone === 'error' && this.host?.quitting()) return 0;
    // Behind an open dialog a toast cannot be reached, so an error raised meanwhile is shown inside
    // the dialog instead (one place, announced once) and not queued as a second copy.
    if (tone === 'error' && this.dialogDepth > 0) {
      this.dialogError = message;
      return 0;
    }
    const same = this.toasts.find((toast) => toast.message === message && toast.tone === tone && !toast.action && !action);
    if (same) return same.id;
    const id = ++this.serial;
    this.toasts = [...this.toasts, { id, tone, message, ms: tone === 'error' || action ? 0 : ms, action }];
    return id;
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((toast) => toast.id !== id);
  }

  /** Called by each open Dialog. Returns the function that says it closed. */
  registerDialog(): () => void {
    this.dialogDepth += 1;
    this.dialogError = '';
    return () => {
      this.dialogDepth = Math.max(0, this.dialogDepth - 1);
      if (!this.dialogDepth) this.dialogError = '';
    };
  }

  /**
   * A readable message for a failed call, in the display language. A code the shell or core sent
   * maps to catalog text with a next step; anything else gets the generic text and an error id the
   * diagnostics copy carries. The raw English message of a failure is never shown.
   */
  describe(cause: unknown): string {
    const code = cause instanceof BackendError ? cause.code : '';
    // A Custom key saved before keys were tied to an address: the fix is entering it again, so
    // Settings is told to take the person to that field.
    if (code === 'CREDENTIAL_ENDPOINT_UNBOUND') this.host?.keyNeedsReentry();
    const message = describeError(cause);
    if (message !== t('error.default')) return message;
    const id = newDiagnosticId();
    // Written outside any render: describe runs from handlers, never from a template.
    this.lastError = { code: code || 'UNKNOWN', id, at: Date.now() };
    return `${message} ${t('error.copyDiagnostics')} ${t('error.id', { id })}`;
  }

  fail(cause: unknown): void {
    if (this.host?.quitting()) return;
    const message = this.describe(cause);
    this.addBanner('error', message, cause instanceof BackendError && cause.code === 'CREDENTIAL_ENDPOINT_UNBOUND' ? 'enter-key' : undefined);
    if (this.dialogDepth > 0) this.dialogError = message;
  }
}
