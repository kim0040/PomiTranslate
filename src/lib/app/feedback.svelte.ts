import { describeError } from '../errors';
import type { Tone, ToastAction } from './types';

export type Banner = { id: number; tone: 'error' | 'warning'; message: string; count: number };

/** The most banners shown at once; a flood of failures should not push the page off screen. */
const MAX_BANNERS = 3;

/**
 * The error banners and the toasts: everything the app tells the user outside a screen's own
 * content. A new error is added beside the older ones (the same message only counts up), so a
 * second failure never hides the reason for the first.
 */
export class Feedback {
  banners = $state<Banner[]>([]);
  toasts = $state<{ id: number; tone: Tone; message: string; action?: ToastAction }[]>([]);
  private serial = 0;

  /** The newest banner, if any. Setting it adds a banner; setting null clears them all. */
  get banner(): Banner | null {
    return this.banners.at(-1) ?? null;
  }

  set banner(value: { tone: 'error' | 'warning'; message: string } | null) {
    if (value) this.addBanner(value.tone, value.message);
    else this.banners = [];
  }

  addBanner(tone: 'error' | 'warning', message: string): void {
    const same = this.banners.find((banner) => banner.message === message && banner.tone === tone);
    if (same) {
      this.banners = this.banners.map((banner) => (banner === same ? { ...banner, count: banner.count + 1 } : banner));
      return;
    }
    this.banners = [...this.banners, { id: ++this.serial, tone, message, count: 1 }].slice(-MAX_BANNERS);
  }

  dismissBanner(id: number): void {
    this.banners = this.banners.filter((banner) => banner.id !== id);
  }

  /**
   * Show a toast. One that offers an action, and every error, stays until it is dismissed: they
   * carry something to read or press, which a timer must not take away. Plain news fades after `ms`.
   * The same message is never stacked twice.
   */
  notify(message: string, tone: Tone = 'info', ms = 5200, action?: ToastAction): number {
    const same = this.toasts.find((toast) => toast.message === message && toast.tone === tone && !toast.action && !action);
    if (same) return same.id;
    const id = ++this.serial;
    this.toasts = [...this.toasts, { id, tone, message, action }];
    if (ms > 0 && tone !== 'error' && !action) setTimeout(() => this.dismissToast(id), ms);
    return id;
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((toast) => toast.id !== id);
  }

  /** A readable message for a failed call. Codes the shell or core sent map to catalog text. */
  describe(cause: unknown): string {
    return describeError(cause);
  }

  fail(cause: unknown): void {
    this.addBanner('error', this.describe(cause));
  }
}
