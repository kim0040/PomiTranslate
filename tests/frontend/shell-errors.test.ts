import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, backend } = vi.hoisted(() => ({ invokeMock: vi.fn(), backend: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock, isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { BackendError, callBackend, fromShellError } from '../../src/lib/api';
import { en } from '../../src/lib/i18n/en';
import { ja } from '../../src/lib/i18n/ja';
import { ko } from '../../src/lib/i18n/ko';
import { setLocale } from '../../src/lib/i18n/index.svelte';
import { AppState } from '../../src/lib/app.svelte';

/** Every stable code the Rust shell can send, read from the one place that defines them. */
function shellCodes(): { all: string[]; update: string[] } {
  const source = readFileSync('src-tauri/src/error.rs', 'utf-8');
  const body = source.slice(source.indexOf('pub mod code'), source.indexOf('#[cfg(test)]\npub const ERROR_CODES'));
  const all = [...body.matchAll(/pub const ([A-Z_]+): &str = "([A-Z_]+)";/g)].map((match) => match[2]);
  return { all, update: all.filter((code) => code.startsWith('UPDATE_')) };
}

describe('shell error codes', () => {
  it('maps a structured shell rejection to a BackendError with the code, not English text', () => {
    const error = fromShellError({ code: 'CREDENTIAL_UNAVAILABLE', message: 'vault broke', detail: 'VAULT_CORRUPT' });
    expect(error).toBeInstanceOf(BackendError);
    expect(error.code).toBe('CREDENTIAL_UNAVAILABLE');
    expect(error.detail).toBe('VAULT_CORRUPT');
    expect(error.origin).toBe('shell');
  });

  it('keeps the old plain-text start-up codes working and turns other text into TRANSPORT', () => {
    expect(fromShellError('CORE_HANDSHAKE_TIMEOUT').code).toBe('CORE_HANDSHAKE_TIMEOUT');
    // Matching English wording is not a contract: text that merely sounds like BUSY is not BUSY.
    expect(fromShellError('Another operation is still running').code).toBe('TRANSPORT');
    expect(fromShellError(new Error('boom')).code).toBe('TRANSPORT');
  });

  it('callBackend surfaces a rejected invoke with its code', async () => {
    invokeMock.mockRejectedValueOnce({ code: 'BUSY', message: 'Another PomiTranslate operation is still running' });
    await expect(callBackend('scan.start')).rejects.toMatchObject({ code: 'BUSY', origin: 'shell' });
    invokeMock.mockRejectedValueOnce({ code: 'CORE_CRASHED', message: 'exit 3' });
    await expect(callBackend('scan.start')).rejects.toMatchObject({ code: 'CORE_CRASHED' });
  });

  it('keeps the detail of a shell error that arrives as a response', async () => {
    invokeMock.mockImplementationOnce((_command, args) => Promise.resolve({
      v: 1, id: args.request.id, type: 'response.error',
      error: { code: 'CREDENTIAL_UNAVAILABLE', message: 'x', detail: 'VAULT_PERMISSIONS' }
    }));
    await expect(callBackend('translate.start')).rejects.toMatchObject({
      code: 'CREDENTIAL_UNAVAILABLE', detail: 'VAULT_PERMISSIONS', origin: 'shell'
    });
  });

  it('has an actionable message in every language for every code the shell can send', () => {
    const { all, update } = shellCodes();
    expect(all.length).toBeGreaterThan(40);
    for (const [name, catalog] of [['ko', ko], ['en', en], ['ja', ja]] as const) {
      const keys = catalog as Record<string, string>;
      for (const code of all) {
        const key = update.includes(code) ? `update.error.${code}` : `error.${code}`;
        expect(keys[key], `${name} is missing ${key}`).toBeTruthy();
      }
    }
  });
});

describe('describing an error for people', () => {
  beforeEach(() => setLocale('en'));

  it('shows catalog text plus the repair step for a storage failure', () => {
    const app = new AppState();
    const text = app.describe(new BackendError('x', 'CREDENTIAL_UNAVAILABLE', 'VAULT_CORRUPT', 'shell'));
    expect(text).toContain(en['error.CREDENTIAL_UNAVAILABLE']);
    expect(text).toContain(en['error.VAULT_CORRUPT']);
  });

  it('never shows raw English from the shell for a code it has no text for', () => {
    const app = new AppState();
    const text = app.describe(new BackendError('os error 5: access denied at C:\\Users\\me', 'SOMETHING_NEW', '', 'shell'));
    expect(text).toContain(en['error.default']);
    expect(text).toContain(en['error.copyDiagnostics']);
    expect(text).not.toContain('os error 5');
  });

  it('never shows the core message either, only the generic text and a diagnostic id', () => {
    const app = new AppState();
    const text = app.describe(new BackendError('The world is read only', 'WORLD_READ_ONLY', '', 'core'));
    expect(text).toContain(en['error.default']);
    expect(text).not.toContain('read only');
    expect(text).toMatch(/Diagnostic ID: [A-Z0-9]+/);
  });
});

describe('the exit and reset flows', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    backend.mockReset();
  });

  it('quits through the shell after the person confirms', async () => {
    invokeMock.mockResolvedValue(undefined);
    const app = new AppState();
    app.exitPrompt = { job: true, dirty: false, phase: 'ask' };
    await app.exitQuit();
    expect(invokeMock).toHaveBeenCalledWith('exit_confirm');
    app.exitStay();
    expect(app.exitPrompt).toBeNull();
  });

  it('saves the settings draft first and stays open when the save fails', async () => {
    invokeMock.mockResolvedValue(undefined);
    const app = new AppState();
    app.exitPrompt = { job: false, dirty: true, phase: 'ask' };
    app.saveDraft = async () => false;
    await app.exitSaveAndQuit();
    expect(invokeMock).not.toHaveBeenCalledWith('exit_confirm');
    app.saveDraft = async () => true;
    await app.exitSaveAndQuit();
    expect(invokeMock).toHaveBeenCalledWith('exit_confirm');
  });

  it('quit now asks the shell to end the core', async () => {
    invokeMock.mockResolvedValue(undefined);
    const app = new AppState();
    await app.exitNow();
    expect(invokeMock).toHaveBeenCalledWith('exit_force');
  });

  it('resets the shell half first and says what is already gone if the core half fails', async () => {
    const calls: string[] = [];
    invokeMock.mockImplementation(async (command: string) => {
      calls.push(command);
      if (command === 'sidecar_request') return { v: 1, id: 'x', type: 'response.error', error: { code: 'OPERATION_FAILED', message: 'x' } };
      return undefined;
    });
    const app = new AppState();
    const reset = await app.resetApp(true);
    expect(reset).toBe(false);
    expect(calls[0]).toBe('native_reset');
    expect(invokeMock).toHaveBeenCalledWith('native_reset', { deleteKeys: true });
    expect(app.banner?.message).toContain(en['reset.partialKeys']);
  });

  it('does not touch the core when the shell half fails', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'native_reset') throw { code: 'CREDENTIAL_UNAVAILABLE', message: 'x', detail: 'VAULT_IO' };
      return undefined;
    });
    const app = new AppState();
    expect(await app.resetApp(true)).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith('sidecar_request', expect.anything());
    expect(app.banner?.message).not.toContain(en['reset.partialKeys']);
  });
});
