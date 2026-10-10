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

const scanPlan = (scanPlanId: string, candidateCount = 2) => ({
  status: 'completed', candidateCount, providerRequests: 0, fingerprint: `fingerprint-${scanPlanId}`,
  scanPlanId, dryRun: true, candidates: []
});
const previousJob = { world: 'OldWorld', at: 1790672300, status: 'completed' as const, translated: 55, failed: 0, changedFiles: 8, candidateCount: 99 };

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

  it('a fresh install opens the wizard with the notice first, and "later" does not start the tour', async () => {
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
    // The tour is optional: it never starts by itself, not even after the wizard is put off.
    expect(app.showWizard).toBe(true);
    expect(app.showTour).toBe(false);
    app.dismissWizard();
    expect(app.showWizard).toBe(false);
    expect(backend).toHaveBeenCalledWith('prefs.set', { prefs: { setup_dismissed: true } });
    expect(app.showTour).toBe(false);
    // Help starts it on request, and finishing it counts the guide as seen.
    app.showTour = true;
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

describe('review undo and per-world summaries', () => {
  it('invalidates the old bulk undo action when a new scan plan replaces the review', async () => {
    backend.mockImplementation(async (type: string) => {
      if (type === 'settings.set') return { settings: defaultSettings(), apiKeyStored: false, credentialMode: 'local' };
      if (type === 'scan.start') return scanPlan('new-plan', 1);
      return {};
    });
    const app = new AppState();
    app.worldDir = '/world-a';
    app.scan = scanPlan('old-plan');
    app.lastJob = previousJob;
    app.setIncludedMany(['old-a', 'old-b'], false);
    const staleUndo = app.toasts.at(-1)?.action;

    await app.startScan();
    staleUndo?.run();

    expect(app.scan?.scanPlanId).toBe('new-plan');
    expect(app.includedCount).toBe(1);
    expect(app.excluded.size).toBe(0);
    expect(app.lastJob).toEqual(previousJob); // A same-world rescan keeps translation history.
    expect(app.toasts.some((toast) => toast.action?.label === '되돌리기')).toBe(false);
    app.destroy();
  });

  it('refuses undo when its recorded scan plan or world no longer matches', () => {
    const app = new AppState();
    app.worldDir = '/world-a';
    app.scan = scanPlan('plan-a');
    app.setIncludedMany(['old-a'], false);
    app.scan = scanPlan('plan-b');
    app.excluded.clear();
    app.excluded.add('new-b');

    expect(app.undoIncluded()).toBe(false);
    expect([...app.excluded]).toEqual(['new-b']);

    app.scan = scanPlan('plan-b');
    app.excluded.clear();
    app.setIncludedMany(['new-c'], false);
    app.worldDir = '/world-b';
    expect(app.undoIncluded()).toBe(false);
    expect([...app.excluded]).toEqual(['new-c']);
    app.destroy();
  });

  it('clears undo actions on resume application and restore', async () => {
    const app = new AppState();
    app.worldDir = '/world-a';
    app.scan = scanPlan('plan-a');
    app.setIncludedMany(['old-a'], false);
    const resumedUndo = app.toasts.at(-1)?.action;
    app.job.applyResume({ available: false, lastJob: null, lastScan: null });
    resumedUndo?.run();
    expect([...app.excluded]).toEqual(['old-a']);
    expect(app.toasts.some((toast) => toast.action)).toBe(false);

    app.scan = scanPlan('plan-a');
    app.setIncludedMany(['old-a'], false);
    const restoreUndo = app.toasts.at(-1)?.action;
    backend.mockImplementation(async (type: string) => type === 'restore.start'
      ? { status: 'restored', recoverySetId: 'recovery' }
      : type === 'backups.list' ? { backups: [] } : {});
    expect(await app.restore('backup-a')).toBe(true);
    restoreUndo?.run();
    expect(app.scan).toBeNull();
    expect(app.excluded.size).toBe(0);
    expect(app.toasts.some((toast) => toast.action)).toBe(false);
    app.destroy();
  });

  it('clears the previous world job and scan summary when selecting or removing a world', async () => {
    backend.mockImplementation(async (type: string) => {
      if (type === 'world.inspect') return { validJavaWorld: true, kind: 'java_world', writeBlockers: [] };
      if (type === 'worlds.remember') return { worlds: [] };
      if (type === 'worlds.forget') return { worlds: [] };
      if (type === 'backups.list') return { backups: [] };
      if (type === 'resume.status') return { available: false, lastJob: null, lastScan: null };
      return {};
    });
    const app = new AppState();
    app.worldDir = '/OldWorld';
    app.scan = scanPlan('old-plan');
    app.lastJob = previousJob;
    app.lastScan = { at: 1790672000, candidateCount: 99 };
    app.setIncludedMany(['old-a'], false);
    const staleUndo = app.toasts.at(-1)?.action;

    await app.useWorld('/NewWorld');
    staleUndo?.run();
    expect(app.lastJob).toBeNull();
    expect(app.lastScan).toBeNull();
    expect(app.scan).toBeNull();
    expect(app.excluded.size).toBe(0);

    app.lastJob = previousJob;
    app.lastScan = { at: 1790672000, candidateCount: 99 };
    await app.forgetWorld('/NewWorld');
    expect(app.lastJob).toBeNull();
    expect(app.lastScan).toBeNull();
    app.destroy();
  });
});
