import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { notificationsAvailable, resetPluginProbe, sendNotification } from '../../src/lib/plugins';

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
