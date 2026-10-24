import { t, type MessageKey } from '../i18n/index.svelte';
import { baseName } from '../format';
import { requestNotificationPermission, sendNotification } from '../plugins';
import type { AppState } from '../app.svelte';

export type JobKind = 'scan' | 'translate' | 'restore' | 'recovery';

/**
 * Tell the person a job ended while the window is in the background (a system notification). No world
 * text goes in, only the world's folder name. A cancelled job, a user who turned the notifications off,
 * a shell without the plugin and a focused window all stay quiet.
 */
export function announce(app: AppState, kind: JobKind, ok: boolean, cancelled: boolean, status = ''): void {
  if (cancelled || app.prefs.notify_on_finish === false || !app.notificationsSupported) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()) return;
  const world = baseName(app.worldDir) || t('native.notification.unknownWorld');
  // A run that stopped for the translation review, or at the spending limit, has its own sentence.
  if (kind === 'translate' && status === 'awaiting_review') {
    void sendNotification(t('notify.title.done'), t('native.notification.reviewReady', { world }));
    return;
  }
  if (kind === 'translate' && status === 'budget_stopped') {
    void sendNotification(t('notify.title.failed'), t('native.notification.budgetStopped', { world }));
    return;
  }
  void sendNotification(
    t(ok ? 'notify.title.done' : 'notify.title.failed'),
    t(`notify.body.${kind}.${ok ? 'done' : 'failed'}` as MessageKey)
  );
}

/** The Settings switch. Turning it on asks the system for permission once. */
export async function setNotifyOnFinish(app: AppState, on: boolean): Promise<void> {
  if (on && !(await requestNotificationPermission())) {
    app.notify(t('notify.denied'), 'info', 9000);
    await app.setPrefs({ notify_on_finish: false });
  } else {
    await app.setPrefs({ notify_on_finish: on });
  }
}
