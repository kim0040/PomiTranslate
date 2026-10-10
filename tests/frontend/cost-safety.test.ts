import { beforeEach, describe, expect, it, vi } from 'vitest';

const { backend, listen } = vi.hoisted(() => ({ backend: vi.fn(), listen: vi.fn() }));
vi.mock('../../src/lib/api', async () => ({
  ...await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api'),
  callBackend: backend, onProgress: listen, onCloseBlocked: listen, onZoomFailed: listen
}));
import { AppState, defaultSettings } from '../../src/lib/app.svelte';
import { BackendError, type Estimate } from '../../src/lib/api';
import { costSafety, COST_CAP_UNPRICED, estimateMinutes, SUGGESTED_CAP_USD } from '../../src/lib/cost-safety';
import { RECOMMENDED_PROVIDER } from '../../src/lib/providers';

const priced = { requests: 3, cost: { low: 0.1, high: 1 } };
const unpriced = { requests: 3, cost: null };

describe('costSafety', () => {
  const base = { manualOnly: false, loading: false, cap: 5 };

  it('is free when nothing goes to the provider', () => {
    expect(costSafety({ ...base, manualOnly: true, estimate: priced })).toBe('free');
    expect(costSafety({ ...base, estimate: { requests: 0, cost: null } })).toBe('free');
  });

  it('waits for the estimate instead of guessing', () => {
    expect(costSafety({ ...base, estimate: null, loading: true })).toBe('pending');
  });

  it('flags a missing limit however the price looks', () => {
    expect(costSafety({ ...base, cap: 0, estimate: priced })).toBe('unlimited');
    expect(costSafety({ ...base, cap: undefined, estimate: unpriced })).toBe('unlimited');
  });

  it('flags a limit that cannot be enforced when the estimate has no price', () => {
    expect(costSafety({ ...base, estimate: unpriced })).toBe('unpriced');
  });

  it('compares the upper estimate with the limit', () => {
    expect(costSafety({ ...base, cap: 0.5, estimate: priced })).toBe('over');
    expect(costSafety({ ...base, cap: 1, estimate: priced })).toBe('within');
    expect(costSafety({ ...base, cap: 5, estimate: priced })).toBe('within');
  });

  it('suggests a small first limit', () => {
    expect(SUGGESTED_CAP_USD).toBe(5);
  });
});

describe('estimateMinutes', () => {
  it('rounds up, never below a minute, and shares requests across the parallel ones', () => {
    expect(estimateMinutes(1, 4)).toBe(1);
    expect(estimateMinutes(60, 1)).toBe(10);
    expect(estimateMinutes(60, 4)).toBe(3);
    expect(estimateMinutes(60, 0)).toBe(10);
  });

  it('says nothing when there is nothing to estimate', () => {
    expect(estimateMinutes(0, 4)).toBeNull();
    expect(estimateMinutes(undefined, 4)).toBeNull();
    expect(estimateMinutes(Number.NaN, 4)).toBeNull();
  });
});

const prefs = { theme: 'system' as const, notice_accepted: true, tutorial_seen: true, setup_dismissed: true, update_auto_check: true, update_last_check: Date.now() / 1000, update_skipped_version: '', notify_on_finish: true };
const bootPayload = (settings = {}, savedPrefs = prefs, apiKeyStored = true) => ({
  notices: { firstLaunch: '', about: '', backupWarning: '', apiWarning: '' },
  settings: { ...defaultSettings(), ...settings, app_prefs: savedPrefs }, prefs: savedPrefs, apiKeyStored, worlds: [], worldInspection: null,
  backups: [], resume: { available: false }
});
const saved = (settings = {}) => ({ settings: { ...defaultSettings(), model: 'm', ...settings }, apiKeyStored: true, credentialMode: 'local' });

beforeEach(() => {
  backend.mockReset();
  listen.mockReset().mockResolvedValue(() => {});
  vi.stubGlobal('localStorage', { getItem: () => 'accepted', setItem: () => {} });
});

describe('a refused start for a model without a price', () => {
  async function ready(): Promise<{ app: AppState; starts: Record<string, unknown>[] }> {
    const starts: Record<string, unknown>[] = [];
    backend.mockImplementation(async (type: string, body: Record<string, unknown> = {}) => {
      if (type === 'app.bootstrap') return bootPayload({ model: 'm', max_cost_usd: 5, last_world_dir: '/w' });
      if (type === 'settings.set') return saved({ max_cost_usd: 5 });
      if (type === 'translate.start' || type === 'translate.retry_failed') {
        starts.push({ type, ...body });
        if (!body.unpricedCapAck) throw new BackendError(COST_CAP_UNPRICED, COST_CAP_UNPRICED);
        return { status: 'completed', candidateCount: 2, changedFileCount: 1, costCapEnforced: false };
      }
      if (type === 'backups.list') return { backups: [] };
      if (type === 'resume.status') return { available: false };
      if (type === 'estimate.get') return { candidateCount: 2, requests: 2, sourceChars: 10, inputTokens: 10, outputTokens: 10, price: null, cost: { low: 0.1, high: 0.2 } };
      return { prefs };
    });
    const app = new AppState();
    await app.boot();
    app.job.scan = { status: 'completed', candidateCount: 2, providerRequests: 0, fingerprint: 'f', scanPlanId: 'p', dryRun: true, candidates: [] };
    return { app, starts };
  }

  it('is seen up front when the estimate has no price and a limit is set', async () => {
    const { app } = await ready();
    app.job.estimate = { candidateCount: 2, requests: 2, sourceChars: 10, inputTokens: 10, outputTokens: 10, price: null, cost: null } as Estimate;
    expect(app.costSafety).toBe('unpriced');
    expect(app.unpriced).toBe(true);
    app.job.estimate = { ...app.job.estimate, cost: { low: 0.1, high: 0.2 } };
    expect(app.costSafety).toBe('within');
    expect(app.unpriced).toBe(false);
    app.destroy();
  });

  it('keeps the request, shows the notice instead of a banner, and sends the agreement only when asked', async () => {
    const { app, starts } = await ready();
    await app.startTranslate({ resume: false });
    expect(starts).toHaveLength(1);
    expect(starts[0]).not.toHaveProperty('unpricedCapAck');
    expect(app.unpricedNotice).toBe(true);
    expect(app.costSafety).toBe('unpriced');
    expect(app.banner).toBeNull();
    expect(app.step).toBe('run');

    await app.consentUnpriced();
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({ type: 'translate.start', unpricedCapAck: true });
    expect(app.unpricedNotice).toBe(false);
    expect(app.result?.costCapEnforced).toBe(false);
    expect(app.step).toBe('result');
    app.destroy();
  });

  it('does the same for retrying failed rows, with the same agreement field', async () => {
    const { app, starts } = await ready();
    await app.retryFailed();
    expect(starts[0]).toMatchObject({ type: 'translate.retry_failed' });
    expect(starts[0]).not.toHaveProperty('unpricedCapAck');
    expect(app.unpricedNotice).toBe(true);
    await app.consentUnpriced();
    expect(starts[1]).toMatchObject({ type: 'translate.retry_failed', unpricedCapAck: true });
    app.destroy();
  });

  it('forgets the refusal when the estimate is calculated again', async () => {
    const { app } = await ready();
    await app.startTranslate({ resume: false });
    expect(app.unpricedNotice).toBe(true);
    await app.loadEstimate();
    expect(app.unpricedNotice).toBe(false);
    app.destroy();
  });
});

describe('the provider a fresh install shows', () => {
  const freshPrefs = { ...prefs, notice_accepted: false, tutorial_seen: false, setup_dismissed: false };
  const bootWith = async (settings: Record<string, unknown>, savedPrefs: typeof prefs, apiKeyStored: boolean, stored: string | null = null) => {
    vi.stubGlobal('localStorage', { getItem: () => stored, setItem: () => {} });
    backend.mockImplementation(async (type: string) => {
      if (type !== 'app.bootstrap') return { prefs: savedPrefs };
      const payload = bootPayload({ provider: 'openai', ...settings }, savedPrefs, apiKeyStored);
      // An install from before app state lived in the settings file has no copy of it there.
      if (stored === 'accepted') delete (payload.settings as Record<string, unknown>).app_prefs;
      return payload;
    });
    const app = new AppState();
    await app.boot();
    return app;
  };

  it('matches the wizard recommendation', async () => {
    const app = await bootWith({ model: '' }, freshPrefs, false);
    expect(app.settings.provider).toBe(RECOMMENDED_PROVIDER);
    app.destroy();
  });

  it('never changes a provider someone already set up', async () => {
    const withModel = await bootWith({ model: 'gpt-x' }, freshPrefs, false);
    expect(withModel.settings.provider).toBe('openai');
    withModel.destroy();
    const withKey = await bootWith({ model: '' }, freshPrefs, true);
    expect(withKey.settings.provider).toBe('openai');
    withKey.destroy();
    const answered = await bootWith({ model: '' }, prefs, false);
    expect(answered.settings.provider).toBe('openai');
    answered.destroy();
    const earlier = await bootWith({ model: '' }, freshPrefs, false, 'accepted');
    expect(earlier.settings.provider).toBe('openai');
    earlier.destroy();
  });
});
