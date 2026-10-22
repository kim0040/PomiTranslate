/**
 * The window around the page: title, theme, Dock/taskbar progress, menu commands and dropped
 * folders. Every call is best effort. A browser preview has none of it, and a missing permission
 * must never break the workflow, so failures are swallowed here and nowhere else.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { fromShellError } from './api';

type Unsubscribe = () => void;
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
  quitItem: string; fileMenu: string; editMenu: string; viewMenu: string; windowMenu: string; helpMenu: string;
  undo: string; redo: string; cut: string; copy: string; paste: string; selectAll: string;
  minimize: string; maximize: string; closeWindow: string; about: string; services: string;
  hide: string; hideOthers: string; showAll: string; fullscreen: string;
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
  try {
    await invoke('open_external', { url });
  } catch (cause) {
    throw fromShellError(cause);
  }
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
  try {
    await invoke('reveal_data_folder');
  } catch (cause) {
    throw fromShellError(cause);
  }
}

/**
 * Show a file or folder the app made (a quarantine folder, a report) in Finder or Explorer.
 * Returns false when the shell has no such command or refused; the caller then shows the path.
 */
export async function revealPath(path: string): Promise<boolean> {
  if (!inShell()) return false;
  try {
    await invoke('reveal_path', { path });
    return true;
  } catch {
    return false;
  }
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
  try {
    return await invoke<UpdateInfo>('update_check');
  } catch (cause) {
    throw new Error(fromShellError(cause).code);
  }
}

/** Download, verify and install, then the app restarts. Rejects with a short code (UPDATE_*). */
export async function installUpdate(): Promise<void> {
  try {
    await invoke('update_install');
  } catch (cause) {
    throw new Error(fromShellError(cause).code);
  }
}

/** Stop a download in progress; the install call then rejects with UPDATE_CANCELLED. */
export async function cancelUpdate(): Promise<void> {
  await quietly(() => invoke('update_cancel'));
}

export async function onUpdateProgress(handler: (downloaded: number, total: number | null) => void): Promise<Unsubscribe> {
  return listen<{ downloaded: number; total: number | null }>('pomi-update-progress', ({ payload }) => handler(payload.downloaded, payload.total ?? null));
}

/** A world folder given to a second launch of the app. */
export async function onOpenWorld(handler: (path: string) => void): Promise<Unsubscribe> {
  return listen<string>('pomi-open-world', ({ payload }) => {
    if (typeof payload === 'string' && payload) handler(payload);
  });
}

// --- leaving the app ------------------------------------------------------------------------

/** What the shell asks about when the window is closed or Quit is chosen. */
export type ExitPrompt = { job: boolean; dirty: boolean };

export async function onExitConfirm(handler: (prompt: ExitPrompt) => void): Promise<Unsubscribe> {
  return listen<ExitPrompt>('pomi-exit-confirm', ({ payload }) => handler(payload));
}

/** The core was asked to stop; the shell quits when it has. */
export async function onExitWaiting(handler: () => void): Promise<Unsubscribe> {
  return listen('pomi-exit-waiting', () => handler());
}

/** The core did not stop within the wait; "Quit now" is offered. */
export async function onExitStuck(handler: () => void): Promise<Unsubscribe> {
  return listen('pomi-exit-stuck', () => handler());
}

/** Tell the shell whether the settings screen holds unsaved changes. */
export async function setSettingsDirty(dirty: boolean): Promise<void> {
  await quietly(() => invoke('exit_set_settings_dirty', { dirty }));
}

/** Quit. A running job is cancelled first. */
export async function confirmExit(): Promise<void> {
  await invoke('exit_confirm');
}

/** Quit now, ending the core if it did not stop. */
export async function forceExit(): Promise<void> {
  await invoke('exit_force');
}
