import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock, isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { AppState } from '../../src/lib/app.svelte';
import type { ChunkCoverage } from '../../src/lib/api';
import {
  compressionName, dimension, fileNotes, hasUninspected, leftOutChunks, leftOutFiles, leftOutText, needsNewerConfirmation, versionSummary
} from '../../src/lib/chunk-coverage';
import { setLocale } from '../../src/lib/i18n/index.svelte';

const coverage = (over: Partial<ChunkCoverage> = {}): ChunkCoverage => ({
  version: 1,
  levelDataVersion: 4189,
  levelDataVersions: [{ world: 'Roguefire', dataVersion: 4189 }],
  newestCovered: 4556,
  chunkVersions: { min: 4189, max: 4189, distribution: [{ dataVersion: 4189, state: 'known', count: 12 }] },
  flags: { mixed: false, newer: false, missing: false },
  counts: { processed: 12, skipped_unsupported: 0, unreadable: 0, not_inspected: 0, total: 12 },
  groups: [],
  files: { scanned: 2, unreadable: 0, notInspected: 0, detectedUnsupported: {} },
  ...over
});

describe('reading a chunk coverage', () => {
  it('names a single version, a mix, an unversioned world and an unread one', () => {
    expect(versionSummary(coverage())).toEqual({ kind: 'single', version: 4189 });
    expect(versionSummary(coverage({ chunkVersions: { min: 4189, max: 4556, distribution: [
      { dataVersion: 4189, state: 'known', count: 3 }, { dataVersion: 4556, state: 'known', count: 2 }] } })))
      .toEqual({ kind: 'mixed', min: 4189, max: 4556 });
    // A chunk without a version is a version of its own: one numbered version beside it is already a mix.
    expect(versionSummary(coverage({ chunkVersions: { min: 4189, max: 4189, distribution: [
      { dataVersion: null, state: 'missing', count: 1 }, { dataVersion: 4189, state: 'known', count: 3 }] } })).kind).toBe('mixed');
    expect(versionSummary(coverage({ chunkVersions: { min: null, max: null, distribution: [{ dataVersion: null, state: 'missing', count: 4 }] } })))
      .toEqual({ kind: 'unversioned' });
    expect(versionSummary(coverage({ chunkVersions: { min: null, max: null, distribution: [] } }))).toEqual({ kind: 'none' });
  });

  it('says when part of the world was not searched', () => {
    expect(hasUninspected(undefined)).toBe(false);
    expect(hasUninspected(coverage())).toBe(false);
    const skipped = coverage({ counts: { processed: 5, skipped_unsupported: 2, unreadable: 1, not_inspected: 0, total: 8 } });
    expect(leftOutChunks(skipped)).toBe(3);
    expect(hasUninspected(skipped)).toBe(true);
    // Files count too: a world whose only region files are .linear has no chunk counts at all.
    const linear = coverage({ files: { scanned: 0, unreadable: 0, notInspected: 0, detectedUnsupported: { linear: 2, mcr: 1 } } });
    expect(leftOutFiles(linear)).toBe(3);
    expect(hasUninspected(linear)).toBe(true);
  });

  it('gates only on the newer flag the core sets, never on a number', () => {
    expect(needsNewerConfirmation(undefined)).toBe(false);
    expect(needsNewerConfirmation(coverage())).toBe(false);
    expect(needsNewerConfirmation(coverage({ chunkVersions: { min: 9999, max: 9999, distribution: [] } }))).toBe(false);
    expect(needsNewerConfirmation(coverage({ flags: { mixed: false, newer: true, missing: false } }))).toBe(true);
  });

  it('writes one line of what was left out, in the words the screen supplies', () => {
    const left = coverage({
      counts: { processed: 5, skipped_unsupported: 2, unreadable: 1, not_inspected: 4, total: 12 },
      files: { scanned: 2, unreadable: 1, notInspected: 0, detectedUnsupported: { linear: 3 } }
    });
    expect(fileNotes(left)).toEqual([{ kind: 'unreadable', count: 1 }, { kind: 'detected', format: 'linear', count: 3 }]);
    const line = leftOutText(left, {
      status: (status) => status,
      file: (note) => (note.kind === 'detected' ? `${note.count} .${note.format}` : `${note.count} ${note.kind}`),
      number: String
    });
    expect(line).toBe('skipped_unsupported 2, unreadable 1, not_inspected 4, 1 unreadable, 3 .linear');
  });

  it('names compressions and dimensions', () => {
    expect([1, 2, 3, 4, 127, null].map(compressionName)).toEqual(['gzip', 'zlib', 'none', 'LZ4', '127', '–']);
    expect(dimension('the_nether').known).toBe('the_nether');
    expect(dimension('mod:deep').known).toBeNull();
  });
});

describe('the newer-version confirmation in the app', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setLocale('en');
  });

  // Enough of the core's other answers for a start to get as far as the translate request.
  const answer = (type: string) =>
    type === 'settings.set' ? { settings: { provider: 'openai', model: 'fixture' }, apiKeyStored: true } : { available: false, backups: [], usage: null };

  const scanned = (flags: ChunkCoverage['flags']) => ({
    status: 'completed', candidateCount: 1, providerRequests: 0, fingerprint: 'f', scanPlanId: 'p', dryRun: true,
    chunkCoverage: coverage({ flags })
  });

  it('holds the run back until it is confirmed, and a new scan asks again', () => {
    const app = new AppState();
    app.scan = scanned({ mixed: true, newer: true, missing: false });
    expect(app.newerPending).toBe(true);
    app.newerAccepted = true;
    expect(app.newerPending).toBe(false);
    app.scan = scanned({ mixed: false, newer: false, missing: false });
    expect(app.newerPending).toBe(false);
  });

  it('sends the confirmation only when it was given for a scan that needs it', async () => {
    const sent: Record<string, unknown>[] = [];
    invokeMock.mockImplementation(async (command: string, args: any) => {
      if (command !== 'sidecar_request') return undefined;
      const request = args.request;
      if (request.type === 'translate.start') {
        sent.push(request.payload);
        return { v: 1, id: request.id, type: 'response.ok', payload: { status: 'completed', candidateCount: 1, changedFileCount: 1 } };
      }
      return { v: 1, id: request.id, type: 'response.ok', payload: answer(request.type) };
    });
    const app = new AppState();
    app.worldDir = '/worlds/Roguefire';
    app.scan = scanned({ mixed: true, newer: true, missing: false }) as any;
    app.newerAccepted = true;
    await app.startTranslate();
    expect(sent[0].acceptNewerVersion).toBe(true);

    const ordinary = new AppState();
    ordinary.worldDir = '/worlds/Roguefire';
    ordinary.scan = scanned({ mixed: false, newer: false, missing: false }) as any;
    ordinary.newerAccepted = true; // a stale tick never turns a covered scan into one that needs it
    await ordinary.startTranslate();
    expect('acceptNewerVersion' in sent[1]).toBe(false);
  });

  it('forgets the confirmation when the core says it did not arrive', async () => {
    invokeMock.mockImplementation(async (command: string, args: any) => {
      if (command !== 'sidecar_request') return undefined;
      const request = args.request;
      if (request.type === 'translate.start') {
        return { v: 1, id: request.id, type: 'response.error', error: { code: 'NEWER_VERSION_UNCONFIRMED', message: 'x', recoverable: true } };
      }
      return { v: 1, id: request.id, type: 'response.ok', payload: answer(request.type) };
    });
    const app = new AppState();
    app.worldDir = '/worlds/Roguefire';
    app.scan = scanned({ mixed: true, newer: true, missing: false }) as any;
    app.newerAccepted = true;
    await app.startTranslate();
    expect(app.newerAccepted).toBe(false);
    expect(app.banner?.message).toContain('newer game version');
    expect(app.step).toBe('run');
  });
});
