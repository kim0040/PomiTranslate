/**
 * The window around the page: title, theme, Dock/taskbar progress, menu commands and dropped
 * folders. Every call is best effort. A browser preview has none of it, and a missing permission
 * must never break the workflow, so failures are swallowed here and nowhere else.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type Unsubscribe = () => void;
export type CloseSource = 'window' | 'quit';
let notificationPermissionRequested = false;
export type MenuAction = 'open-world' | 'settings' | 'find' | 'help' | 'tour' | 'shortcuts' | 'licenses' | 'report' | 'updates'
  | 'theme-system' | 'theme-light' | 'theme-dark';

export function inShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /mac/i.test(data?.platform || navigator.platform || navigator.userAgent);
}

async function currentWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

async function quietly(action: () => Promise<unknown>): Promise<void> {
  if (!inShell()) return;
  try {
    await action();
  } catch {
    // Window chrome is decoration; the job continues without it.
  }
}

// Window calls run one after another, so a slow early call can never overwrite a newer state
// (a stale title, or progress arriving after the job already cleared it).
let chain: Promise<void> = Promise.resolve();
function queued(action: () => Promise<unknown>): Promise<void> {
  chain = chain.then(() => quietly(action));
  return chain;
}

export function setWindowTitle(title: string): Promise<void> {
  document.title = title;
  return queued(async () => (await currentWindow()).setTitle(title));
}

/** Dock (macOS) and taskbar (Windows) progress. `null` clears it. */
export function setTaskProgress(percent: number | null, paused = false): Promise<void> {
  return queued(async () => {
    const { ProgressBarStatus } = await import('@tauri-apps/api/window');
    const window = await currentWindow();
    if (percent === null) await window.setProgressBar({ status: ProgressBarStatus.None });
    else await window.setProgressBar({
      status: paused ? ProgressBarStatus.Paused : percent <= 0 ? ProgressBarStatus.Indeterminate : ProgressBarStatus.Normal,
      progress: Math.max(0, Math.min(100, Math.round(percent)))
    });
  });
}

/** Bounce the Dock icon / flash the taskbar once when a long job ends in the background. */
export async function requestAttention(): Promise<void> {
  if (typeof document !== 'undefined' && document.hasFocus()) return;
  await quietly(async () => {
    const { UserAttentionType } = await import('@tauri-apps/api/window');
    await (await currentWindow()).requestUserAttention(UserAttentionType.Informational);
  });
}

/** Native title bar and window background follow the app theme, so nothing flashes white. */
export function setWindowTheme(choice: 'system' | 'light' | 'dark', background: string): Promise<void> {
  return queued(async () => {
    const window = await currentWindow();
    await window.setTheme(choice === 'system' ? null : choice);
    await window.setBackgroundColor(background);
  });
}

export type MenuLabels = {
  openWorld: string; settings: string; find: string;
  help: string; tour: string; shortcuts: string; licenses: string; report: string; updates: string;
  appearance: string; themeSystem: string; themeLight: string; themeDark: string;
};

export async function setMenuLabels(labels: MenuLabels): Promise<void> {
  await quietly(() => invoke('set_menu_labels', { labels }));
}

/** Tick the matching item in View > Appearance. */
export async function setMenuTheme(choice: 'system' | 'light' | 'dark'): Promise<void> {
  await quietly(() => invoke('set_menu_theme', { choice }));
}

export async function onMenu(handler: (action: MenuAction) => void): Promise<Unsubscribe> {
  return listen<MenuAction>('pomi-menu', ({ payload }) => handler(payload));
}

/** Keep Rust's close guard in step with the settings draft currently shown by the page. */
export async function setUnsavedSettings(unsaved: boolean): Promise<void> {
  await quietly(() => invoke('set_unsaved_settings', { unsaved }));
}

export async function closeGuardAck(): Promise<void> {
  await quietly(() => invoke('close_guard_ack'));
}

/** The event is acknowledged before the UI opens its confirmation dialog. */
export async function onCloseRequested(handler: (source: CloseSource) => void): Promise<Unsubscribe> {
  return listen<CloseSource>('pomi-close-requested', ({ payload }) => {
    void closeGuardAck();
    if (payload === 'window' || payload === 'quit') handler(payload);
  });
}

/** Finish the close or quit after the person saved or discarded their settings. */
export async function finishClose(source: CloseSource): Promise<void> {
  await quietly(() => invoke('finish_close', { source }));
}

/** Ask permission only when a long job finishes in the background. */
export async function sendCompletionNotification(title: string, body: string): Promise<void> {
  if (!inShell() || (typeof document !== 'undefined' && document.hasFocus())) return;
  try {
    const notifications = await import('@tauri-apps/plugin-notification');
    let granted = await notifications.isPermissionGranted();
    if (!granted && !notificationPermissionRequested) {
      notificationPermissionRequested = true;
      granted = (await notifications.requestPermission()) === 'granted';
    }
    if (granted) await notifications.sendNotification({ title, body });
  } catch {
    // A denied permission or unavailable plugin must not affect the completed job.
  }
}

/** A folder (or a world's level.dat) dropped on the window. */
export async function onDropPath(handler: (path: string) => void, hover: (over: boolean) => void): Promise<Unsubscribe> {
  const stops = await Promise.all([
    listen<{ paths?: string[] }>('tauri://drag-enter', () => hover(true)),
    listen('tauri://drag-leave', () => hover(false)),
    listen<{ paths?: string[] }>('tauri://drag-drop', ({ payload }) => {
      hover(false);
      const first = payload?.paths?.[0];
      if (first) handler(first.replace(/[\\/]level\.dat$/i, ''));
    })
  ]);
  return () => stops.forEach((stop) => stop());
}

/**
 * Open a web page or the contact address in the system's own browser or mail app. The shell only
 * accepts known addresses; a browser preview falls back to a new tab.
 */
export async function openExternal(url: string): Promise<void> {
  if (!inShell()) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  await invoke('open_external', { url });
}

export type DataLocations = { data: string; app: string };

export async function dataLocations(): Promise<DataLocations | null> {
  if (!inShell()) return null;
  try {
    return await invoke<DataLocations>('data_locations');
  } catch {
    return null;
  }
}

export async function revealDataFolder(): Promise<void> {
  await invoke('reveal_data_folder');
}

export async function appVersion(fallback: string): Promise<string> {
  if (!inShell()) return fallback;
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return fallback;
  }
}

export type UpdateInfo = {
  status: 'available' | 'current';
  currentVersion: string;
  version?: string | null;
  notes?: string | null;
  date?: string | null;
  canInstall: boolean;
  releaseUrl: string;
};

/** Ask the release feed for a newer version. Rejects with a short code (UPDATE_*) on failure. */
export async function checkForUpdate(): Promise<UpdateInfo> {
  if (!inShell()) throw new Error('UPDATE_UNAVAILABLE_IN_PREVIEW');
  return invoke<UpdateInfo>('update_check');
}

/** Download, verify and install, then the app restarts. Rejects with a short code (UPDATE_*). */
export async function installUpdate(): Promise<void> {
  await invoke('update_install');
}

export async function onUpdateProgress(handler: (downloaded: number, total: number | null) => void): Promise<Unsubscribe> {
  return listen<{ downloaded: number; total: number | null }>('pomi-update-progress', ({ payload }) => handler(payload.downloaded, payload.total ?? null));
}

/** Open the selected world's folder in the file manager. The shell refuses anything but a Java world folder. */
export async function revealWorldFolder(worldDir: string): Promise<void> {
  await invoke('reveal_world_folder', { worldDir });
}
