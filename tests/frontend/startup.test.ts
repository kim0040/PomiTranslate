import { beforeEach, describe, expect, it, vi } from 'vitest';

const { backend, listen } = vi.hoisted(() => ({ backend: vi.fn(), listen: vi.fn() }));
vi.mock('../../src/lib/api', async () => ({
  ...await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api'),
  callBackend: backend, onProgress: listen, onCloseBlocked: listen, onZoomFailed: listen
}));
import { AppState, defaultSettings } from '../../src/lib/app.svelte';
import { BackendError } from '../../src/lib/api';

// A current install: app state already lives in the settings file, so start-up reads it and saves nothing.
const prefs = { theme: 'system' as const, notice_accepted: true, tutorial_seen: true, setup_dismissed: true, update_auto_check: true, update_last_check: Date.now() / 1000, update_skipped_version: '' };
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
  it('carries the notice answer from web storage into the settings file once, without the wizard or tour', async () => {
    backend.mockImplementation(async (type: string) => type === 'app.bootstrap'
      ? { ...payload(), settings: defaultSettings(), prefs: { ...prefs, notice_accepted: false, tutorial_seen: false, setup_dismissed: false } }
      : { prefs: { ...prefs } });
    const app = new AppState();
    await app.boot();
    expect(backend).toHaveBeenCalledWith('prefs.set', { prefs: { notice_accepted: true, tutorial_seen: true, setup_dismissed: true } });
    expect(app.showNotice).toBe(false);
    expect(app.showWizard).toBe(false);
    expect(app.showTour).toBe(false);
    app.destroy();
  });

  it('a fresh install opens the wizard with the notice first, and the tour after "later"', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    backend.mockImplementation(async (type: string) => type === 'app.bootstrap'
      ? { ...payload(), settings: { ...defaultSettings(), app_prefs: {} }, prefs: { ...prefs, notice_accepted: false, tutorial_seen: false, setup_dismissed: false } }
      : { prefs: { ...prefs } });
    const app = new AppState();
    await app.boot();
    expect(app.showNotice).toBe(true);
    expect(app.showWizard).toBe(true);
    expect(app.showTour).toBe(false);
    app.acceptNotice();
    expect(backend).toHaveBeenCalledWith('prefs.set', { prefs: { notice_accepted: true } });
    // The tour waits until the wizard is put off or finished.
    expect(app.showWizard).toBe(true);
    expect(app.showTour).toBe(false);
    app.dismissWizard();
    expect(app.showWizard).toBe(false);
    expect(backend).toHaveBeenCalledWith('prefs.set', { prefs: { setup_dismissed: true } });
    expect(app.showTour).toBe(true);
    app.finishTour();
    expect(backend).toHaveBeenCalledWith('prefs.set', { prefs: { tutorial_seen: true } });
    app.destroy();
  });

  it('a finished setup counts the guide as seen and lands on the world step', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    backend.mockImplementation(async (type: string) => type === 'app.bootstrap'
      ? { ...payload(), settings: { ...defaultSettings(), app_prefs: {} }, prefs: { ...prefs, notice_accepted: true, tutorial_seen: false, setup_dismissed: false } }
      : { prefs: { ...prefs } });
    const app = new AppState();
    await app.boot();
    expect(app.showWizard).toBe(true);
    app.step = 'scan';
    app.finishSetup(true);
    expect(app.showWizard).toBe(false);
    expect(app.step).toBe('world');
    expect(app.showTour).toBe(true);
    expect(backend).toHaveBeenCalledWith('prefs.set', { prefs: { setup_dismissed: true, tutorial_seen: true } });
    app.destroy();
  });
});

describe('when the setup wizard opens by itself', () => {
  const boot = async (settings: Partial<ReturnType<typeof defaultSettings>>, extra: { apiKeyStored: boolean; setup_dismissed: boolean }) => {
    backend.mockImplementation(async (type: string) => type === 'app.bootstrap'
      ? { ...payload(), settings: { ...defaultSettings(), ...settings, app_prefs: prefs }, apiKeyStored: extra.apiKeyStored, prefs: { ...prefs, setup_dismissed: extra.setup_dismissed } }
      : { prefs: { ...prefs } });
    const app = new AppState();
    await app.boot();
    return app;
  };

  it('opens when there is no usable provider and it was not put off', async () => {
    const app = await boot({ model: '' }, { apiKeyStored: false, setup_dismissed: false });
    expect(app.showWizard).toBe(true);
    app.destroy();
  });

  it('opens when only the key is missing', async () => {
    const app = await boot({ model: 'some-model' }, { apiKeyStored: false, setup_dismissed: false });
    expect(app.showWizard).toBe(true);
    app.destroy();
  });

  it('stays closed once it was put off, and when a model and a key exist', async () => {
    const putOff = await boot({ model: '' }, { apiKeyStored: false, setup_dismissed: true });
    expect(putOff.showWizard).toBe(false);
    putOff.destroy();
    const ready = await boot({ model: 'some-model' }, { apiKeyStored: true, setup_dismissed: false });
    expect(ready.showWizard).toBe(false);
    ready.destroy();
  });

  it('can be opened again by hand, but not while the first-run notice is unanswered', async () => {
    const app = await boot({ model: 'some-model' }, { apiKeyStored: true, setup_dismissed: true });
    app.openWizard();
    expect(app.showWizard).toBe(true);
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
    expect(listen).toHaveBeenCalledTimes(3);
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
    expect(stop).toHaveBeenCalledTimes(3);
  });
});
