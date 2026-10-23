import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock, isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { AppState } from '../../src/lib/app.svelte';
import type { ChunkCoverage } from '../../src/lib/api';
import {
  compressionName, dimension, distributionOverflow, fileNotes, hasUninspected, leftOutChunks, leftOutFiles, leftOutText, needsNewerConfirmation, versionSummary
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

  it('trusts the exact flags and range when the distribution leaves chunks out', () => {
    // One itemised version, but the core says the versions are mixed: the other chunks were counted as overflow.
    const truncated = coverage({
      flags: { mixed: true, newer: true, missing: false },
      chunkVersions: { min: 4000, max: 5000, truncated: true, overflow: 1, distribution: [{ dataVersion: 4000, state: 'known', count: 1 }] }
    });
    expect(versionSummary(truncated)).toEqual({ kind: 'mixed', min: 4000, max: 5000 });
    expect(distributionOverflow(truncated)).toBe(1);
    expect(distributionOverflow(coverage())).toBe(0);
    // Everything read lies in the overflow: the exact range still names the version, and a missing one stays missing.
    const onlyOverflow = coverage({ chunkVersions: { min: 4100, max: 4100, truncated: true, overflow: 70, distribution: [] } });
    expect(versionSummary(onlyOverflow)).toEqual({ kind: 'single', version: 4100 });
    const missingOnly = coverage({
      flags: { mixed: false, newer: false, missing: true },
      chunkVersions: { min: null, max: null, truncated: true, overflow: 3, distribution: [] }
    });
    expect(versionSummary(missingOnly)).toEqual({ kind: 'unversioned' });
  });

  it('counts a summary continued from an old checkpoint as incompletely inspected', () => {
    expect(hasUninspected(coverage({ partial: true }))).toBe(true);
    expect(hasUninspected(coverage({ partial: false }))).toBe(false);
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

describe('continuing an interrupted job of a newer world', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setLocale('en');
  });

  const newer = coverage({ flags: { mixed: true, newer: true, missing: false }, chunkVersions: { min: 4189, max: 4800, distribution: [] } });
  const job = {
    jobId: 'job-1', kind: 'translate', worldPath: '/worlds/Roguefire', worldName: 'Roguefire', createdAt: '2026-09-30T09:12:00+09:00',
    unitsTotal: 10, unitsVerified: 4, unitsUnknown: 0, needsAttention: true, legacy: false, state: 'partial', blocking: true
  } as any;

  function core(refuse = false) {
    const sent: { type: string; payload: Record<string, any> }[] = [];
    invokeMock.mockImplementation(async (command: string, args: any) => {
      if (command !== 'sidecar_request') return undefined;
      const { type, payload, id } = args.request;
      sent.push({ type, payload });
      const ok = (body: unknown) => ({ v: 1, id, type: 'response.ok', payload: body });
      if (type === 'resume.status') {
        return ok({ available: true, scanPlanId: 'plan', fingerprint: 'f', candidateCount: 1, candidates: [], chunkCoverage: newer, status: 'partial', savedAt: 1 });
      }
      if (type === 'translate.resume') {
        if (refuse || payload.acceptNewerVersion !== true) {
          return { v: 1, id, type: 'response.error', error: { code: 'NEWER_VERSION_UNCONFIRMED', message: 'x', recoverable: true } };
        }
        return ok({ status: 'completed', candidateCount: 1, changedFileCount: 1 });
      }
      if (type === 'settings.set') return ok({ settings: { provider: 'openai', model: 'fixture' }, apiKeyStored: true });
      return ok({ available: false, backups: [], usage: null });
    });
    return sent;
  }

  function opened() {
    const app = new AppState();
    app.worldDir = '/worlds/Roguefire';
    app.interruptedJobs = [job];
    app.step = 'world';
    return app;
  }

  it('asks in the recovery flow first, keeps the job, and sends the confirmation unchanged', async () => {
    const sent = core();
    const app = opened();
    await app.continueInterrupted(job);
    // Nothing was sent to translate, the job stays selected and the person is still on the world screen.
    expect(sent.some((item) => item.type === 'translate.resume')).toBe(false);
    expect(app.continuation?.jobId).toBe('job-1');
    expect(app.step).toBe('world');
    expect(app.newerAccepted).toBe(false);
    // Confirming without ticking does nothing.
    await app.confirmContinuation();
    expect(sent.some((item) => item.type === 'translate.resume')).toBe(false);

    app.newerAccepted = true;
    await app.confirmContinuation();
    const resume = sent.find((item) => item.type === 'translate.resume');
    expect(resume?.payload.acceptNewerVersion).toBe(true);
    expect(app.continuation).toBeNull();
  });

  it('stays on the confirmation when the core still refuses it', async () => {
    core(true);
    const app = opened();
    await app.continueInterrupted(job);
    app.newerAccepted = true;
    await app.confirmContinuation();
    expect(app.step).toBe('world');
    expect(app.continuation?.jobId).toBe('job-1');
    expect(app.newerAccepted).toBe(false);
    expect(app.banner?.message).toContain('newer game version');
  });

  it('keeps a tick given earlier for the same saved scan, and drops it on cancel', async () => {
    const sent = core();
    const app = opened();
    await app.continueInterrupted(job);
    app.cancelContinuation();
    expect(app.continuation).toBeNull();
    expect(app.newerAccepted).toBe(false);
    // The run step's box was ticked for this saved scan: Continue goes ahead without asking again.
    app.newerAccepted = true;
    await app.continueInterrupted(job);
    expect(sent.filter((item) => item.type === 'translate.resume')).toHaveLength(1);
    expect(sent.find((item) => item.type === 'translate.resume')?.payload.acceptNewerVersion).toBe(true);
  });
});

describe('one recovery action at a time, bound to the context it was asked in', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setLocale('en');
  });

  const newer = coverage({ flags: { mixed: true, newer: true, missing: false }, chunkVersions: { min: 4189, max: 4800, distribution: [] } });
  const job = {
    jobId: 'job-A', kind: 'translate', worldPath: '/worlds/A', worldName: 'A', createdAt: '2026-09-30T09:12:00+09:00',
    unitsTotal: 10, unitsVerified: 4, unitsUnknown: 0, needsAttention: true, legacy: false, state: 'partial', blocking: true
  } as any;
  const saved = { available: true, scanPlanId: 'plan-A', fingerprint: 'fingerprint-A', candidateCount: 1, candidates: [], chunkCoverage: newer, status: 'partial', savedAt: 1 };

  /** A core whose draft save and recovery lookup can be held back; everything else answers at once. */
  function gatedCore() {
    const sent: { type: string; payload: Record<string, any> }[] = [];
    const held: { draft?: () => void; status?: () => void } = {};
    const gates = { draft: false, status: false };
    invokeMock.mockImplementation(async (command: string, args: any) => {
      if (command !== 'sidecar_request') return undefined;
      const { type, payload, id } = args.request;
      sent.push({ type, payload });
      const ok = (body: unknown) => ({ v: 1, id, type: 'response.ok', payload: body });
      if (type === 'review.draft.set' && gates.draft) {
        gates.draft = false;
        return new Promise((resolve) => { held.draft = () => resolve(ok({})); });
      }
      if (type === 'resume.status') {
        if (gates.status) {
          gates.status = false;
          return new Promise((resolve) => { held.status = () => resolve(ok(saved)); });
        }
        return ok(saved);
      }
      if (type === 'translate.resume') return ok({ status: 'completed', candidateCount: 1, changedFileCount: 1 });
      if (type === 'scan.start') {
        return ok({
          status: 'completed', scanPlanId: 'plan-new', fingerprint: 'fingerprint-new', candidateCount: 1, candidates: [], providerRequests: 0,
          dryRun: true, chunkCoverage: coverage()
        });
      }
      if (type === 'settings.set') return ok({ settings: { provider: 'openai', model: 'fixture' }, apiKeyStored: true });
      if (type === 'world.inspect') return ok({ validJavaWorld: payload.worldDir !== '/worlds/not-a-world' });
      if (type === 'worlds.remember') return ok({ worlds: [] });
      if (type === 'app.bootstrap') return ok({ interruptedJobs: [] });
      return ok({ available: false, backups: [], usage: null });
    });
    return { sent, held, gates };
  }

  function opened() {
    const app = new AppState();
    app.worldDir = '/worlds/A';
    app.interruptedJobs = [job];
    app.step = 'world';
    return app;
  }

  it('sends one resume when Continue is clicked twice while the review is being stored', async () => {
    const { sent, held, gates } = gatedCore();
    const app = opened();
    await app.continueInterrupted(job);
    expect(app.continuation?.jobId).toBe('job-A');
    app.newerAccepted = true;
    app.draftDirty = true;
    gates.draft = true;
    const first = app.confirmContinuation();
    await vi.waitFor(() => expect(held.draft).toBeTypeOf('function'));
    // The review is still being stored: the job has not taken the core, yet the button is already off and a second click is ignored.
    expect(app.isBusy).toBe(false);
    expect(app.starting).toBe(true);
    await app.confirmContinuation();
    await app.continueInterrupted(job);
    held.draft!();
    await first;
    expect(sent.filter((item) => item.type === 'review.draft.set')).toHaveLength(1);
    expect(sent.filter((item) => item.type === 'translate.resume')).toHaveLength(1);
    expect(app.starting).toBe(false);
  });

  it('releases the guard when the start fails', async () => {
    gatedCore();
    const app = opened();
    await app.continueInterrupted(job);
    app.newerAccepted = true;
    invokeMock.mockImplementation(async (command: string, args: any) => {
      if (command !== 'sidecar_request') return undefined;
      const { type, id } = args.request;
      if (type === 'translate.resume') return { v: 1, id, type: 'response.error', error: { code: 'INTERNAL', message: 'x', recoverable: true } };
      return { v: 1, id, type: 'response.ok', payload: { settings: { provider: 'openai', model: 'fixture' }, apiKeyStored: true, available: false, backups: [], usage: null } };
    });
    await app.confirmContinuation();
    expect(app.starting).toBe(false);
  });

  it('drops a recovery lookup that a new scan has outlived', async () => {
    const { sent, held, gates } = gatedCore();
    const app = opened();
    gates.status = true;
    const pending = app.continueInterrupted(job);
    await vi.waitFor(() => expect(held.status).toBeTypeOf('function'));
    // The core answers in order: the scan queues behind the held lookup, so the lookup is released first.
    const scanning = app.startScan();
    held.status!();
    await pending;
    await scanning;
    // The fresh scan stays alone: the old checkpoint, job and confirmation do not come back.
    expect(app.scan?.scanPlanId).toBe('plan-new');
    expect(app.resume).toBeNull();
    expect(app.continuation).toBeNull();
    expect(app.newerAccepted).toBe(false);
    expect(app.starting).toBe(false);
    expect(sent.some((item) => item.type === 'translate.resume')).toBe(false);
  });

  it('drops a recovery lookup that a world switch or a cancel has outlived', async () => {
    const { sent, held, gates } = gatedCore();
    const app = opened();
    gates.status = true;
    const pending = app.continueInterrupted(job);
    await vi.waitFor(() => expect(held.status).toBeTypeOf('function'));
    app.cancelContinuation();
    held.status!();
    await pending;
    expect(app.scan).toBeNull();
    expect(app.continuation).toBeNull();
    expect(sent.some((item) => item.type === 'translate.resume')).toBe(false);

    held.status = undefined;
    gates.status = true;
    const again = app.continueInterrupted(job);
    await vi.waitFor(() => expect(held.status).toBeTypeOf('function'));
    const switching = app.useWorld('/worlds/B');
    held.status!();
    await again;
    await switching;
    expect(app.worldDir).toBe('/worlds/B');
    expect(app.continuation).toBeNull();
    expect(app.newerAccepted).toBe(false);
    expect(sent.some((item) => item.type === 'translate.resume')).toBe(false);
  });

  it('keeps a recovery lookup when the folder picked meanwhile is not a world', async () => {
    const { held, gates } = gatedCore();
    const app = opened();
    gates.status = true;
    const pending = app.continueInterrupted(job);
    await vi.waitFor(() => expect(held.status).toBeTypeOf('function'));
    // The core answers in order, so the folder is inspected after the held lookup is answered.
    const picking = app.useWorld('/worlds/not-a-world');
    held.status!();
    await pending;
    await picking;
    expect(app.banner?.tone).toBe('error');
    // Nothing changed: the same world, and its saved job waits for the newer-version confirmation.
    expect(app.worldDir).toBe('/worlds/A');
    expect(app.continuation?.jobId).toBe('job-A');
    expect(app.resume?.scanPlanId).toBe('plan-A');
  });

  it('does not send a confirmation whose scan no longer matches the one it was asked for', async () => {
    const { sent } = gatedCore();
    const app = opened();
    await app.continueInterrupted(job);
    expect(app.continuation?.jobId).toBe('job-A');
    app.newerAccepted = true;
    // Another scan replaced the one the question was about while the panel stayed open.
    app.scan = { ...app.scan!, scanPlanId: 'plan-other' };
    await app.confirmContinuation();
    expect(sent.some((item) => item.type === 'translate.resume')).toBe(false);
    expect(app.continuation).toBeNull();
    expect(app.newerAccepted).toBe(false);
    expect(app.starting).toBe(false);
  });
});
