/**
 * Optional Tauri plugins: system notifications (tauri-plugin-notification) and the window's
 * remembered size and position (tauri-plugin-window-state). They are reached through the
 * plugins' own IPC commands rather than their npm packages, so this page type-checks, runs in the
 * browser preview and works with a shell that has not registered them yet. Every function here
 * answers "not available" instead of throwing, and the screens hide what depends on it.
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

// --- window placement ----------------------------------------------------------------------

export type Rect = { x: number; y: number; width: number; height: number };

const MIN_VISIBLE_WIDTH = 160;
const MIN_VISIBLE_HEIGHT = 80;

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  };
}

/**
 * Where the window should be so that it can be reached. A window that already shows a usable part
 * of some monitor stays where it is; one left on a monitor that is gone (or placed off screen) is
 * moved onto the first monitor and shrunk to fit it. Returns null when nothing needs to change.
 */
export function clampToMonitors(window: Rect, monitors: Rect[]): Rect | null {
  if (!monitors.length || window.width <= 0 || window.height <= 0) return null;
  const needW = Math.min(MIN_VISIBLE_WIDTH, window.width);
  const needH = Math.min(MIN_VISIBLE_HEIGHT, window.height);
  if (monitors.some((monitor) => {
    const shared = overlap(window, monitor);
    return shared.width >= needW && shared.height >= needH;
  })) return null;
  const target = monitors[0];
  const width = Math.min(window.width, target.width);
  const height = Math.min(window.height, target.height);
  return { x: target.x + Math.round((target.width - width) / 2), y: target.y + Math.round((target.height - height) / 2), width, height };
}

/**
 * After the shell restored the saved placement, make sure the window is on a monitor that exists.
 * Best effort: without the permissions or outside the shell nothing happens.
 */
export async function keepWindowOnScreen(): Promise<void> {
  if (!inShell()) return;
  try {
    const api = await import('@tauri-apps/api/window');
    const win = api.getCurrentWindow();
    if ((await win.isMaximized()) || (await win.isFullscreen())) return;
    const [position, size, monitors] = await Promise.all([win.outerPosition(), win.outerSize(), api.availableMonitors()]);
    const fix = clampToMonitors(
      { x: position.x, y: position.y, width: size.width, height: size.height },
      monitors.map((monitor) => ({ x: monitor.position.x, y: monitor.position.y, width: monitor.size.width, height: monitor.size.height }))
    );
    if (!fix) return;
    await win.setSize(new api.PhysicalSize(fix.width, fix.height));
    await win.setPosition(new api.PhysicalPosition(fix.x, fix.y));
  } catch {
    // Placement is a convenience; a missing permission must not break start-up.
  }
}
