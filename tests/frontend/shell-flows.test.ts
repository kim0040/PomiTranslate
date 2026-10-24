import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock, isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { AppState } from '../../src/lib/app.svelte';
import { assessReset } from '../../src/lib/reset';
import { BackendError, nativeReset, type InterruptedJob } from '../../src/lib/api';
import { en } from '../../src/lib/i18n/en';
import { setLocale } from '../../src/lib/i18n/index.svelte';

type Handler = (request: { type: string; payload: Record<string, any> }) => unknown;

/** Route `sidecar_request` to a handler that answers with the payload (or throws a core error), and everything else to `others`. */
function route(handler: Handler, others: Record<string, (args: any) => unknown> = {}): void {
  invokeMock.mockImplementation(async (command: string, args: any) => {
    if (command === 'sidecar_request') {
      const request = args.request;
      try {
        return { v: 1, id: request.id, type: 'response.ok', payload: handler(request) };
      } catch (cause) {
        const code = cause instanceof BackendError ? cause.code : 'OPERATION_FAILED';
        return { v: 1, id: request.id, type: 'response.error', error: { code, message: 'x' } };
      }
    }
    if (command in others) return others[command](args);
    return undefined;
  });
}

const prompt = (over: Record<string, unknown> = {}) => ({ job: false, dirty: true, reason: 'quit', intent: 11, phase: 'ask', ...over }) as any;

beforeEach(() => {
  invokeMock.mockReset();
  setLocale('en');
});

describe('the stuck quit dialog', () => {
  it('"Keep waiting" tells the shell and returns to the waiting state', async () => {
    invokeMock.mockResolvedValue(undefined);
    const app = new AppState();
    app.exitGate.prompt = prompt({ job: true, dirty: false, phase: 'stuck' });
    await app.exitKeepWaiting();
    expect(invokeMock).toHaveBeenCalledWith('exit_keep_waiting');
    expect(app.exitPrompt?.phase).toBe('waiting');
    expect(invokeMock).not.toHaveBeenCalledWith('exit_force');
  });

  it('"Quit now" still ends the core by force', async () => {
    invokeMock.mockResolvedValue(undefined);
    const app = new AppState();
    app.exitGate.prompt = prompt({ job: true, dirty: false, phase: 'stuck' });
    await app.exitNow();
    expect(invokeMock).toHaveBeenCalledWith('exit_force');
  });

  it('shows the error and closes the dialog when the shell cannot wait again', async () => {
    invokeMock.mockRejectedValue({ code: 'INTERNAL', message: 'x' });
    const app = new AppState();
    app.exitGate.prompt = prompt({ job: true, dirty: false, phase: 'stuck' });
    await app.exitKeepWaiting();
    expect(app.exitPrompt).toBeNull();
    expect(app.banner?.message).toBeTruthy();
  });
});

describe('the update question', () => {
  it('Save then confirms with the intent and closes the dialog so the install carries on', async () => {
    invokeMock.mockResolvedValue(undefined);
    const app = new AppState();
    app.exitGate.prompt = prompt({ reason: 'update', intent: 21 });
    app.saveDraft = async () => true;
    await app.exitSaveAndQuit();
    expect(invokeMock).toHaveBeenCalledWith('exit_confirm', { intent: 21 });
    expect(app.exitPrompt).toBeNull();
  });

  it('Discard confirms without saving', async () => {
    invokeMock.mockResolvedValue(undefined);
    const app = new AppState();
    const save = vi.fn(async () => true);
    app.saveDraft = save;
    app.exitGate.prompt = prompt({ reason: 'update', intent: 22 });
    await app.exitQuit();
    expect(save).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith('exit_confirm', { intent: 22 });
    expect(app.exitPrompt).toBeNull();
  });

  it('Cancel tells the shell to call the install off', () => {
    invokeMock.mockResolvedValue(undefined);
    const app = new AppState();
    app.exitGate.prompt = prompt({ reason: 'update', intent: 23 });
    app.exitStay();
    expect(invokeMock).toHaveBeenCalledWith('exit_cancel', { intent: 23 });
    expect(app.exitPrompt).toBeNull();
  });

  it.each(['UPDATE_CANCELLED', 'INVALID_REQUEST'])('%s from an answer means the question is gone: close and do nothing else', async (code) => {
    invokeMock.mockRejectedValue({ code, message: 'gone' });
    const app = new AppState();
    app.exitGate.prompt = prompt({ reason: 'update', intent: 5 });
    await app.exitQuit();
    expect(app.exitPrompt).toBeNull();
    expect(app.banner).toBeNull();
    // A late Cancel for a question that is gone is quiet too.
    app.exitGate.prompt = prompt({ reason: 'update', intent: 5 });
    app.exitStay();
    await Promise.resolve();
    expect(app.banner).toBeNull();
  });

  it('any other refusal of the answer is shown', async () => {
    invokeMock.mockRejectedValue({ code: 'INTERNAL', message: 'x' });
    const app = new AppState();
    app.exitGate.prompt = prompt({ intent: 6 });
    await app.exitQuit();
    expect(app.banner?.message).toBe(en['error.INTERNAL']);
  });

  it('install results are explained: busy, cancelled, and a core whose end is unconfirmed', async () => {
    for (const [code, expected] of [
      ['UPDATE_BUSY', en['update.error.UPDATE_BUSY']],
      ['UPDATE_CANCELLED', en['update.error.UPDATE_CANCELLED']],
      ['CORE_STATE_UNKNOWN', en['error.CORE_STATE_UNKNOWN']]
    ] as const) {
      invokeMock.mockReset();
      invokeMock.mockImplementation(async (command: string) => {
        if (command === 'update_install') throw { code, message: 'x' };
        return undefined;
      });
      const app = new AppState();
      app.exitGate.prompt = prompt({ reason: 'update', intent: 8 });
      await app.installUpdate();
      expect(app.updateState).toBe('error');
      expect(app.updateError).toBe(code);
      // The dialog that was waiting on the install is moot once it ended.
      expect(app.exitPrompt).toBeNull();
      expect(app.describe(new BackendError('x', code, '', 'shell'))).toBe(expected);
    }
  });
});

describe('resetting the app', () => {
  const full = { keysDeleted: true, reportsCleared: true, errors: [] };

  it('reads the structured outcome: anything that is not clearly true counts as not done', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    expect(await nativeReset(true)).toEqual({ keysDeleted: false, keysPartiallyDeleted: false, reportsCleared: false, errors: [] });
    invokeMock.mockResolvedValueOnce({ keysDeleted: 'yes', reportsCleared: true, errors: ['VAULT_IO', 7] });
    expect(await nativeReset(true)).toMatchObject({ keysDeleted: false, reportsCleared: true, errors: ['VAULT_IO'] });
  });

  it('assessReset ignores keys when they were not asked for', () => {
    expect(assessReset({ keysDeleted: false, reportsCleared: true, errors: [] }, false)).toBeNull();
    expect(assessReset({ keysDeleted: false, reportsCleared: true, errors: [] }, true)).toMatchObject({ keys: true, reports: false });
    expect(assessReset({ keysDeleted: true, reportsCleared: false, errors: ['RESET_FAILED', 'RESET_FAILED'] }, true)).toEqual({
      keys: false, keysPartial: false, reports: true, errors: ['RESET_FAILED']
    });
  });

  it('continues to the core only when the shell half fully worked', async () => {
    route(() => ({}), { native_reset: () => full });
    const app = new AppState();
    expect(await app.resetApp(true)).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('sidecar_request', expect.objectContaining({ request: expect.objectContaining({ type: 'app.reset' }) }));
    expect(app.resetShortfall).toBeNull();
  });

  it('keys not asked for: a "false" keysDeleted does not stop the reset', async () => {
    route(() => ({}), { native_reset: () => ({ keysDeleted: false, reportsCleared: true, errors: [] }) });
    const app = new AppState();
    expect(await app.resetApp(false)).toBe(true);
  });

  it('an uncertain keychain stops before the core, says what is left and offers a retry that finishes the job', async () => {
    let step = 0;
    route(() => ({}), {
      native_reset: () => (step++ === 0
        ? { keysDeleted: false, keysPartiallyDeleted: true, reportsCleared: true, errors: ['KEYCHAIN_UNCONFIRMED'] }
        : full)
    });
    const app = new AppState();
    expect(await app.resetApp(true)).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith('sidecar_request', expect.anything());
    expect(app.resetShortfall).toMatchObject({ keys: true, keysPartial: true, reports: false, errors: ['KEYCHAIN_UNCONFIRMED'] });
    const lines = app.resetShortfallLines(app.resetShortfall!);
    expect(lines).toContain(en['reset.left.keysPartial']);
    expect(lines).toContain(en['error.KEYCHAIN_UNCONFIRMED']);
    expect(lines).toContain(en['reset.left.retry']);
    expect(app.banner?.message).toContain(en['reset.incomplete']);
    // The retry runs the same call again and, this time, goes on to the core.
    expect(await app.resetApp(true)).toBe(true);
    expect(app.resetShortfall).toBeNull();
  });

  it('reports that are still there stop the reset too', async () => {
    route(() => ({}), { native_reset: () => ({ keysDeleted: true, reportsCleared: false, errors: ['RESET_FAILED'] }) });
    const app = new AppState();
    expect(await app.resetApp(false)).toBe(false);
    expect(app.resetShortfallLines(app.resetShortfall!)).toContain(en['reset.left.reports']);
  });

  it.each(['BUSY', 'UPDATE_BUSY', 'CORE_STATE_UNKNOWN'])('%s refuses the reset: it is explained and nothing else runs', async (code) => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'native_reset') throw { code, message: 'x' };
      return undefined;
    });
    const app = new AppState();
    app.step = 'scan';
    expect(await app.resetApp(true)).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith('sidecar_request', expect.anything());
    const known = code === 'BUSY' ? en['error.busy'] : code === 'UPDATE_BUSY' ? en['update.error.UPDATE_BUSY'] : en['error.CORE_STATE_UNKNOWN'];
    expect(app.banner?.message).toBe(known);
    expect(app.step).toBe('scan');
  });

  it('the credential reset says when it was refused', async () => {
    invokeMock.mockRejectedValue({ code: 'CORE_STATE_UNKNOWN', message: 'x' });
    const app = new AppState();
    expect(await app.resetKeyStorage()).toBe(false);
    expect(app.banner?.message).toBe(en['error.CORE_STATE_UNKNOWN']);
  });
});

describe('a Custom key the older version saved', () => {
  it('is explained, never shown, and the banner leads to the key field', () => {
    const app = new AppState();
    const cause = new BackendError('x', 'CREDENTIAL_ENDPOINT_UNBOUND', '', 'shell');
    expect(app.describe(cause)).toBe(en['error.CREDENTIAL_ENDPOINT_UNBOUND']);
    expect(app.keyReentry).toBe(true);
    app.fail(cause);
    expect(app.banner?.action).toBe('enter-key');
    app.enterKeyAgain();
    expect(app.focusKeyField).toBe(true);
    expect(app.page).toBe('settings');
  });

  it('there is no command that binds a stored key without typing it again', () => {
    const sources = import.meta.glob('../../src/**/*.{ts,svelte}', { query: '?raw', eager: true, import: 'default' }) as Record<string, string>;
    for (const [file, text] of Object.entries(sources)) {
      expect(text.includes('confirmEndpoint'), file).toBe(false);
    }
  });

  it('typing the key again for Custom clears the notice', async () => {
    route((request) => {
      if (request.type === 'settings.set') return { settings: { ...request.payload, provider: 'custom' }, apiKeyStored: true };
      return {};
    });
    const app = new AppState();
    app.settings = { ...app.settings, provider: 'custom', base_url: 'https://example.com/v1' };
    app.keyReentry = true;
    await app.persistSettings('typed-again');
    expect(app.keyReentry).toBe(false);
  });
});

describe('recovery results', () => {
  const job = (over: Partial<InterruptedJob> = {}): InterruptedJob => ({
    jobId: 'cont', kind: 'translate', worldPath: '/w', worldName: 'w', createdAt: '2026-10-01T00:00:00Z',
    unitsTotal: 3, unitsVerified: 1, unitsUnknown: 0, needsAttention: true, legacy: false, state: 'partial', ...over
  });

  it('an undone unpublished resume refreshes the list so the earlier job is listed again', async () => {
    const earlier = job({ jobId: 'earlier' });
    route((request) => {
      if (request.type === 'recovery.start') {
        return { jobId: 'cont', mode: 'rollback', state: 'rolled_back', settledBy: 'unpublished_continuation', restoredFiles: 0, keptFiles: 0, conflicts: [], quarantineDir: null };
      }
      if (request.type === 'app.bootstrap') return { interruptedJobs: [earlier] };
      return {};
    });
    const app = new AppState();
    app.worldDir = '/elsewhere';
    app.recovery.jobs = [job()];
    const result = await app.recover(job(), 'rollback');
    expect(result?.settledBy).toBe('unpublished_continuation');
    expect(app.interruptedJobs.map((item) => item.jobId)).toEqual(['earlier']);
    expect(app.recoveryResult?.result.state).toBe('rolled_back');
  });

  it('a Keep that could not quarantine stays listed, with the reason', async () => {
    route((request) => {
      if (request.type === 'recovery.start') {
        return {
          jobId: 'cont', mode: 'keep', state: 'recovery_conflict', errorCode: 'DISK_FULL', restoredFiles: 0, keptFiles: 0,
          conflicts: [{ path: 'region/r.0.0.mca', rootKind: 'world', code: 'UNIT_INCONSISTENT' }], quarantineDir: '/q'
        };
      }
      return {};
    });
    const app = new AppState();
    app.worldDir = '/elsewhere';
    app.recovery.jobs = [job()];
    await app.recover(job(), 'keep', { acceptConflicts: true });
    expect(invokeMock).toHaveBeenCalledWith('sidecar_request', expect.objectContaining({
      request: expect.objectContaining({ payload: { jobId: 'cont', mode: 'keep', acceptConflicts: true } })
    }));
    expect(app.interruptedJobs.map((item) => item.jobId)).toEqual(['cont']);
    expect(app.recoveryResult?.result.errorCode).toBe('DISK_FULL');
  });

  it('a full disk or a failed journal write says the world is unchanged when nothing is listed', () => {
    const app = new AppState();
    for (const code of ['DISK_FULL', 'JOURNAL_WRITE_FAILED']) {
      expect(app.describe(new BackendError('x', code))).toContain('was not changed');
    }
  });
});

describe('review drafts and backups talk to the core', () => {
  it('lists usage with the last copies and deletes one only with the acknowledgement', async () => {
    const calls: Array<{ type: string; payload: Record<string, any> }> = [];
    route((request) => {
      calls.push({ type: request.type, payload: request.payload });
      if (request.type === 'backups.list') {
        return {
          backups: [{ backupSetId: 'b1', createdAt: '2026-10-01T00:00:00Z', fileCount: 2, verified: true, kind: 'translation' }],
          usage: { worldBytes: 10, worldCount: 1, appBytes: 20, appBytesApproximate: true, lastCopyIds: ['b1'] }
        };
      }
      if (request.type === 'backups.delete') return { deleted: true };
      return {};
    });
    const app = new AppState();
    app.worldDir = '/w';
    await app.loadBackups();
    expect(app.backupUsage).toMatchObject({ appBytes: 20, appBytesApproximate: true, lastCopyIds: ['b1'] });
    expect(await app.deleteBackup('b1', 'app', true)).toBe(true);
    expect(calls.find((call) => call.type === 'backups.delete')?.payload).toMatchObject({ backupSetId: 'b1', location: 'app', acknowledgeLastCopy: true });
  });

  it('a refused delete of the last copy is explained and the list is reloaded', async () => {
    let listed = 0;
    route((request) => {
      if (request.type === 'backups.list') { listed += 1; return { backups: [], usage: { worldBytes: 0, worldCount: 0, appBytes: 0, lastCopyIds: [] } }; }
      if (request.type === 'backups.delete') throw new BackendError('x', 'BACKUP_LAST_COPY');
      return {};
    });
    const app = new AppState();
    app.worldDir = '/w';
    expect(await app.deleteBackup('b1', 'app', false)).toBe(false);
    expect(app.banner?.message).toBe(en['error.BACKUP_LAST_COPY']);
    expect(app.backupAdminSupported).toBe(true);
    expect(listed).toBe(1);
  });

  it('an older core that answers UNKNOWN_MESSAGE hides the controls instead of failing for good', async () => {
    route((request) => {
      if (request.type === 'backups.delete') throw new BackendError('x', 'UNKNOWN_MESSAGE');
      return { backups: [] };
    });
    const app = new AppState();
    app.worldDir = '/w';
    await app.deleteBackup('b1');
    expect(app.backupAdminSupported).toBe(false);
  });

  it('stores, reads and clears the review draft through the core', async () => {
    const seen: string[] = [];
    const ids = ['a'.repeat(20), 'b'.repeat(20)];
    route((request) => {
      seen.push(request.type);
      if (request.type === 'review.draft.get') return { scanPlanId: 'p', exists: true, savedAt: 1, excludedCandidateIds: [ids[0]], candidateOverrides: { [ids[1]]: 'typed' } };
      return { saved: true };
    });
    const app = new AppState();
    app.scan = { scanPlanId: 'p'.repeat(64), status: 'completed', fingerprint: 'f' } as any;
    app.excluded.add(ids[0]);
    app.job.draft.dirty = true;
    expect(await app.storeReview(true)).toBe(true);
    expect(seen).toContain('review.draft.set');
    await app.job.draft.restore(app.scan!.scanPlanId);
    expect(app.excluded.has(ids[0])).toBe(true);
    expect(app.overrides[ids[1]]).toBe('typed');
    await app.job.draft.clear(app.scan!.scanPlanId);
    expect(seen).toContain('review.draft.clear');
  });
});

describe('a system keychain entry that could not be deleted', () => {
  it('deleting a key answers KEYCHAIN_UNCONFIRMED with the try-again-or-remove-it text and asks nothing else', async () => {
    const seen: string[] = [];
    route((request) => {
      seen.push(request.type);
      throw new BackendError('x', 'KEYCHAIN_UNCONFIRMED');
    });
    const app = new AppState();
    expect(await app.deleteApiKey()).toBe(false);
    expect(app.banner?.message).toBe(en['error.KEYCHAIN_UNCONFIRMED']);
    expect(en['error.KEYCHAIN_UNCONFIRMED']).toContain('PomiTranslate');
    expect(seen).toEqual(['credentials.delete']);
  });

  it('a reset that cannot delete the entry says the same and goes no further', async () => {
    route(() => ({}), { native_reset: () => ({ keysDeleted: false, keysPartiallyDeleted: false, reportsCleared: true, errors: ['KEYCHAIN_UNCONFIRMED'] }) });
    const app = new AppState();
    expect(await app.resetApp(true)).toBe(false);
    expect(app.resetShortfallLines(app.resetShortfall!)).toContain(en['error.KEYCHAIN_UNCONFIRMED']);
    expect(invokeMock).not.toHaveBeenCalledWith('sidecar_request', expect.anything());
  });
});
