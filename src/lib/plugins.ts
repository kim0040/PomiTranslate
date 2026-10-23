/**
 * Optional Tauri plugin: system notifications (tauri-plugin-notification), reached through the
 * plugin's own IPC commands so this page type-checks, runs in the browser preview and works with a
 * shell that has not registered it yet. Every function here answers "not available" instead of
 * throwing, and the screens hide what depends on it. The window's remembered size and position,
 * and keeping it on a connected monitor, belong to the shell (tauri-plugin-window-state and its
 * window_geometry clamp); the page does not repeat it.
 */
import { invoke } from '@tauri-apps/api/core';
import { inShell } from './native';

// --- notifications -------------------------------------------------------------------------

let notificationsSupported: boolean | null = null;

/** True when the shell has the notification plugin. Asked once; a browser preview is never supported. */
export async function notificationsAvailable(): Promise<boolean> {
  if (notificationsSupported !== null) return notificationsSupported;
  if (!inShell()) return (notificationsSupported = false);
  try {
    await invoke('plugin:notification|is_permission_granted');
    notificationsSupported = true;
  } catch {
    notificationsSupported = false;
  }
  return notificationsSupported;
}

/** Forget what was learned, for tests that switch the shell fixture. */
export function resetPluginProbe(): void {
  notificationsSupported = null;
}

async function permissionGranted(request: boolean): Promise<boolean> {
  try {
    if ((await invoke<boolean | null>('plugin:notification|is_permission_granted')) === true) return true;
    if (!request) return false;
    return (await invoke<string>('plugin:notification|request_permission')) === 'granted';
  } catch {
    return false;
  }
}

/** Ask the system for permission. Called when the person turns notifications on. */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!(await notificationsAvailable())) return false;
  return permissionGranted(true);
}

/**
 * Show one notification. The text is chosen by the caller from the catalog and never contains
 * world text, a path or a key. Returns whether the system accepted it.
 */
export async function sendNotification(title: string, body: string): Promise<boolean> {
  if (!(await notificationsAvailable()) || !(await permissionGranted(false))) return false;
  try {
    await invoke('plugin:notification|notify', { options: { title, body } });
    return true;
  } catch {
    return false;
  }
}
