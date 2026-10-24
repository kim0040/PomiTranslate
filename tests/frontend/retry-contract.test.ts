import { beforeEach, describe, expect, it, vi } from 'vitest';

const { backend, listen } = vi.hoisted(() => ({ backend: vi.fn(), listen: vi.fn() }));
vi.mock('../../src/lib/api', async () => ({
  ...await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api'),
  callBackend: backend, onProgress: listen, onCloseBlocked: listen, onZoomFailed: listen
}));
import { AppState, defaultSettings } from '../../src/lib/app.svelte';

// The shell validates a Custom provider's endpoint before it reads the stored key, for every request
// that carries one. A retry that leaves out the address or the wire format is refused there, so the
// retry must send exactly what start and resume send.
const prefs = { theme: 'system' as const, notice_accepted: true, tutorial_seen: true, setup_dismissed: true, update_auto_check: true, update_last_check: Date.now() / 1000, update_skipped_version: '', notify_on_finish: true };

async function ready(settings: Record<string, unknown>): Promise<{ app: AppState; sent: Record<string, unknown>[] }> {
  const sent: Record<string, unknown>[] = [];
  const merged = { ...defaultSettings(), model: 'm', last_world_dir: '/w', ...settings };
  backend.mockImplementation(async (type: string, body: Record<string, unknown> = {}) => {
    if (type === 'app.bootstrap') {
      return { notices: { firstLaunch: '', about: '', backupWarning: '', apiWarning: '' }, settings: { ...merged, app_prefs: prefs }, prefs, apiKeyStored: true, worlds: [], worldInspection: null, backups: [], resume: { available: false } };
    }
    if (type === 'settings.set') return { settings: merged, apiKeyStored: true, credentialMode: 'local' };
    if (type === 'translate.start' || type === 'translate.resume' || type === 'translate.retry_failed') {
      sent.push({ type, ...body });
      return { status: 'awaiting_review', candidateCount: 2, changedFileCount: 0 };
    }
    if (type === 'backups.list') return { backups: [] };
    if (type === 'resume.status') return { available: false };
    return { prefs };
  });
  const app = new AppState();
  await app.boot();
  app.job.scan = { status: 'completed', candidateCount: 2, providerRequests: 0, fingerprint: 'f', scanPlanId: 'p', dryRun: true, candidates: [] };
  return { app, sent };
}

beforeEach(() => {
  backend.mockReset();
  listen.mockReset().mockResolvedValue(() => {});
  vi.stubGlobal('localStorage', { getItem: () => 'accepted', setItem: () => {} });
});

describe('failed-only retry and glossary refresh send the same endpoint fields as start', () => {
  for (const wireFormat of ['openai', 'anthropic'] as const) {
    it(`a Custom provider with the ${wireFormat} wire format`, async () => {
      const { app, sent } = await ready({ provider: 'custom', base_url: 'https://llm.example/v1', wire_format: wireFormat });
      await app.startTranslate({ resume: false });
      await app.retryFailed();
      await app.retryFailed({ refreshGlossary: true });
      expect(sent.map((item) => item.type)).toEqual(['translate.start', 'translate.retry_failed', 'translate.retry_failed']);
      const [start, retry, refresh] = sent;
      for (const request of [retry, refresh]) {
        expect(request).toMatchObject({ provider: 'custom', model: 'm', baseUrl: 'https://llm.example/v1', wireFormat });
        expect(request.baseUrl).toBe(start.baseUrl);
        expect(request.wireFormat).toBe(start.wireFormat);
      }
      expect(refresh).toMatchObject({ refreshGlossary: true });
      app.destroy();
    });
  }

  it('a hosted provider sends the wire format but no address', async () => {
    const { app, sent } = await ready({ provider: 'openrouter', base_url: 'https://stale.example/v1', wire_format: 'openai' });
    await app.retryFailed();
    expect(sent[0]).toMatchObject({ type: 'translate.retry_failed', provider: 'openrouter', wireFormat: 'openai' });
    expect(sent[0]).not.toHaveProperty('baseUrl');
    app.destroy();
  });
});
