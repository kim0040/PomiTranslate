import { t, type MessageKey } from '../i18n/index.svelte';
import { baseName } from '../format';
import { sendCompletionNotification } from '../native';
import type { AppState } from '../app.svelte';

/**
 * An OS notification when a long job ends while the window is in the background. Short jobs and a
 * focused window stay quiet; so does a user who turned the notifications off.
 */
export function notifyAfterJob(app: AppState, kind: 'scan' | 'translation' | 'restore', startedAt: number, result: {
  status: string; candidates?: number; translated?: number; failed?: number;
}): void {
  if (Date.now() - startedAt < 10_000 || !app.prefs.notify_on_finish ||
      typeof document === 'undefined' || document.hasFocus()) return;
  const world = baseName(app.worldDir) || t('native.notification.unknownWorld');
  let body: string;
  if (kind === 'scan') {
    body = result.status === 'completed'
      ? t('native.notification.scanDone', { world, count: result.candidates ?? 0 })
      : t('native.notification.scanFailed', { world });
  } else if (kind === 'restore') {
    body = result.status === 'completed'
      ? t('native.notification.restoreDone', { world })
      : t('native.notification.restoreFailed', { world });
  } else if (result.status === 'awaiting_review') {
    body = t('native.notification.reviewReady', { world });
  } else if (result.status === 'budget_stopped') {
    body = t('native.notification.budgetStopped', { world });
  } else {
    const status = result.status === 'completed' || result.status === 'partial' || result.status === 'cancelled'
      ? result.status : 'failed';
    body = t('native.notification.translationDone', {
      world,
      status: t(`native.notification.status.${status}` as MessageKey),
      translated: result.translated ?? 0,
      failed: result.failed ?? 0
    });
  }
  void sendCompletionNotification(t('native.notification.title'), body);
}
