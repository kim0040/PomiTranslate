import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { clampToMonitors, notificationsAvailable, resetPluginProbe, sendNotification } from '../../src/lib/plugins';

const screen = { x: 0, y: 0, width: 1920, height: 1080 };

describe('window placement', () => {
  it('leaves a window that shows a usable part of a monitor alone', () => {
    expect(clampToMonitors({ x: 100, y: 80, width: 1180, height: 800 }, [screen])).toBeNull();
    // Mostly off the right edge but 300 px still visible.
    expect(clampToMonitors({ x: 1620, y: 80, width: 1180, height: 800 }, [screen])).toBeNull();
  });

  it('moves a window left on a monitor that is gone onto the remaining one, centred', () => {
    const moved = clampToMonitors({ x: 3000, y: 200, width: 1180, height: 800 }, [screen]);
    expect(moved).toEqual({ x: 370, y: 140, width: 1180, height: 800 });
  });

  it('shrinks a window that is larger than the monitor', () => {
    const moved = clampToMonitors({ x: -4000, y: 0, width: 2600, height: 1500 }, [screen]);
    expect(moved).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it('keeps a window that sits on the second monitor to the left (negative coordinates)', () => {
    const left = { x: -1280, y: 0, width: 1280, height: 1024 };
    expect(clampToMonitors({ x: -1200, y: 50, width: 900, height: 700 }, [screen, left])).toBeNull();
  });

  it('does nothing when no monitor is reported', () => {
    expect(clampToMonitors({ x: 0, y: 0, width: 800, height: 600 }, [])).toBeNull();
  });
});

describe('notification plugin', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetPluginProbe();
    Object.assign(globalThis, { window: { __TAURI_INTERNALS__: {} } });
  });

  it('is unavailable when the shell has no such command, and nothing is sent', async () => {
    invokeMock.mockRejectedValue(new Error('Command plugin:notification|is_permission_granted not found'));
    expect(await notificationsAvailable()).toBe(false);
    expect(await sendNotification('a', 'b')).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith('plugin:notification|notify', expect.anything());
  });

  it('sends only when permission is already granted', async () => {
    invokeMock.mockImplementation(async (command: string) => (command === 'plugin:notification|is_permission_granted' ? true : null));
    expect(await sendNotification('Done', 'Translation finished')).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('plugin:notification|notify', { options: { title: 'Done', body: 'Translation finished' } });
  });

  it('does not send after a denied permission', async () => {
    invokeMock.mockImplementation(async (command: string) => (command === 'plugin:notification|is_permission_granted' ? false : null));
    expect(await sendNotification('Done', 'x')).toBe(false);
  });
});
