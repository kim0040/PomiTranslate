import { beforeEach, describe, expect, it, vi } from 'vitest';

const { backend, listen } = vi.hoisted(() => ({ backend: vi.fn(), listen: vi.fn() }));
vi.mock('../../src/lib/api', async () => ({
  ...await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api'),
  callBackend: backend, onProgress: listen, onZoomFailed: listen
}));
vi.mock('../../src/lib/native', async () => ({
  ...await vi.importActual<typeof import('../../src/lib/native')>('../../src/lib/native'),
  onExitConfirm: listen, onExitWaiting: listen, onExitStuck: listen, onOpenWorld: listen
}));
import { AppState, defaultSettings } from '../../src/lib/app.svelte';
import { BackendError } from '../../src/lib/api';

// A current install: app state already lives in the settings file, so start-up reads it and saves nothing.
const prefs = { theme: 'system' as const, notice_accepted: true, tutorial_seen: true, update_auto_check: true, update_last_check: Date.now() / 1000, update_skipped_version: '' };
const payload = () => ({
  notices: { firstLaunch: '', about: '', backupWarning: '', apiWarning: '' },
  settings: { ...defaultSettings(), app_prefs: prefs }, prefs, apiKeyStored: false, worlds: [], worldInspection: null,
  backups: [], resume: { available: false }
});

beforeEach(() => {
  backend.mockReset();
  listen.mockReset().mockResolvedValue(() => {});
  vi.stubGlobal('localStorage', { getItem: () => 'accepted' });
});

describe('app state from an earlier version', () => {
  it('carries the notice answer from web storage into the settings file once, without the tour', async () => {
    backend.mockImplementation(async (type: string) => type === 'app.bootstrap'
      ? { ...payload(), settings: defaultSettings(), prefs: { ...prefs, notice_accepted: false, tutorial_seen: false } }
      : { prefs: { ...prefs } });
    const app = new AppState();
    await app.boot();
    expect(backend).toHaveBeenCalledWith('prefs.set', { prefs: { notice_accepted: true, tutorial_seen: true } });
    expect(app.showNotice).toBe(false);
    expect(app.showTour).toBe(false);
    app.destroy();
  });

  it('a fresh install shows the notice first and the tour after it', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    backend.mockImplementation(async (type: string) => type === 'app.bootstrap'
      ? { ...payload(), settings: { ...defaultSettings(), app_prefs: {} }, prefs: { ...prefs, notice_accepted: false, tutorial_seen: false } }
      : { prefs: { ...prefs } });
    const app = new AppState();
    await app.boot();
    expect(app.showNotice).toBe(true);
    expect(app.showTour).toBe(false);
    app.acceptNotice();
    expect(app.showTour).toBe(true);
    app.finishTour();
    expect(backend).toHaveBeenCalledWith('prefs.set', { prefs: { tutorial_seen: true } });
    app.destroy();
  });
});

describe('startup recovery', () => {
  it('starts bootstrap even if event registration never responds', async () => {
    listen.mockReturnValue(new Promise(() => {}));
    backend.mockResolvedValue(payload());
    const app = new AppState();
    await app.boot();
    expect(backend).toHaveBeenCalledExactlyOnceWith('app.bootstrap');
    expect(app.ready).toBe(true);
    expect(app.startupFailed).toBe(false);
    app.destroy();
  });

  it('a timed-out startup can retry without duplicate subscriptions or lost queue state', async () => {
    backend.mockRejectedValueOnce(new BackendError('BOOTSTRAP_TIMEOUT', 'BOOTSTRAP_TIMEOUT'));
    backend.mockResolvedValueOnce(payload());
    const app = new AppState();
    await app.boot();
    expect(app.startupFailed).toBe(true);
    expect(app.busy).toBe('');
    expect(app.banner?.message).not.toContain('BOOTSTRAP_TIMEOUT');
    await app.boot();
    expect(app.startupFailed).toBe(false);
    expect(app.banner).toBeNull();
    expect(app.ready).toBe(true);
    expect(backend).toHaveBeenCalledTimes(2);
    // progress, zoom failure, the three exit events and a second launch's world folder
    expect(listen).toHaveBeenCalledTimes(6);
    app.destroy();
  });

  it('refuses a duplicate boot while bootstrap is pending', async () => {
    let resolve!: (value: ReturnType<typeof payload>) => void;
    backend.mockReturnValue(new Promise((done) => { resolve = done; }));
    const app = new AppState();
    const first = app.boot();
    await app.boot();
    expect(backend).toHaveBeenCalledTimes(1);
    expect(app.ready).toBe(false);
    resolve(payload());
    await first;
    app.destroy();
  });

  it('removes late event subscriptions after the app was destroyed', async () => {
    const stop = vi.fn();
    let resolve!: (value: () => void) => void;
    listen.mockReturnValue(new Promise<() => void>((done) => { resolve = done; }));
    backend.mockResolvedValue(payload());
    const app = new AppState();
    await app.boot();
    app.destroy();
    resolve(stop);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(6);
  });
});
