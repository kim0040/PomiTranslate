import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendError } from '../../src/lib/api';
import { Feedback } from '../../src/lib/app/feedback.svelte';
import { describeError } from '../../src/lib/errors';
import { t } from '../../src/lib/i18n/index.svelte';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('error banners', () => {
  it('keep earlier errors when a new one arrives, and count a repeat instead of stacking it', () => {
    const feedback = new Feedback();
    feedback.fail(new BackendError('BUSY', 'BUSY'));
    feedback.fail(new BackendError('TRANSPORT', 'TRANSPORT'));
    feedback.fail(new BackendError('BUSY', 'BUSY'));
    expect(feedback.banners.map((banner) => [banner.message, banner.count])).toEqual([[t('error.BUSY'), 2], [t('error.TRANSPORT'), 1]]);
    expect(feedback.banner?.message).toBe(t('error.TRANSPORT'));
  });

  it('can be dismissed one by one, and setting null clears them all', () => {
    const feedback = new Feedback();
    feedback.addBanner('error', 'one');
    feedback.addBanner('warning', 'two');
    feedback.dismissBanner(feedback.banners[0].id);
    expect(feedback.banners.map((banner) => banner.message)).toEqual(['two']);
    feedback.banner = null;
    expect(feedback.banners).toEqual([]);
  });

  it('shows at most three at once, newest last', () => {
    const feedback = new Feedback();
    for (const message of ['a', 'b', 'c', 'd']) feedback.addBanner('error', message);
    expect(feedback.banners.map((banner) => banner.message)).toEqual(['b', 'c', 'd']);
  });
});

describe('toasts', () => {
  it('fade after their time, unless they are errors or offer an action', () => {
    const feedback = new Feedback();
    feedback.notify('plain news', 'success', 1000);
    feedback.notify('a failure', 'error', 1000);
    feedback.notify('undo this', 'info', 1000, { label: 'Undo', run: () => {} });
    vi.advanceTimersByTime(60_000);
    expect(feedback.toasts.map((toast) => toast.message)).toEqual(['a failure', 'undo this']);
  });

  it('never stack the same message twice', () => {
    const feedback = new Feedback();
    const first = feedback.notify('same', 'info');
    expect(feedback.notify('same', 'info')).toBe(first);
    expect(feedback.toasts).toHaveLength(1);
  });

  it('can be dismissed by hand', () => {
    const feedback = new Feedback();
    const id = feedback.notify('stays', 'error');
    feedback.dismissToast(id);
    expect(feedback.toasts).toEqual([]);
  });
});

describe('describeError', () => {
  it('maps a code to catalog text and never shows a tool message', () => {
    expect(describeError(new BackendError('BUSY', 'BUSY'))).toBe(t('error.BUSY'));
    expect(describeError(new BackendError('The translation core answered a different request.', 'SOMETHING_NEW'))).toBe(t('error.default'));
    expect(describeError(new Error('fetch failed: ECONNRESET'))).toBe(t('error.default'));
    expect(describeError('plain string')).toBe(t('error.default'));
  });
});
