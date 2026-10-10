import { describe, expect, it, vi } from 'vitest';

const { callBackendMock } = vi.hoisted(() => ({ callBackendMock: vi.fn() }));

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api');
  return { ...actual, callBackend: callBackendMock };
});

import { t } from '../../src/lib/i18n/index.svelte';
import { CandidateSource, PAGE_SIZE, MAX_CACHED_PAGES } from '../../src/lib/candidates.svelte';

const page = (overrides: Partial<Parameters<typeof callBackendMock>[1]> = {}) => ({
  candidates: [
    { id: 'shop', source: 'Shop', kind: 'sign', occurrences: 3 },
    { id: 'welcome', source: 'Welcome', kind: 'book', occurrences: 1 }
  ],
  offset: 0,
  total: 2,
  hasMore: false,
  kinds: { sign: 1, book: 1 },
  ...overrides
});

describe('CandidateSource query state', () => {
  it('loads the first page and sends the current query, sort, and state', async () => {
    callBackendMock.mockResolvedValueOnce(page());
    const ids = { excluded: ['excluded-id'], manual: ['manual-id'] };
    const source = new CandidateSource(() => ids);
    source.query = 'shop';
    source.kind = 'sign';
    source.state = 'excluded';
    source.sort = 'source';

    source.reset('scan-1');
    await vi.waitFor(() => expect(callBackendMock).toHaveBeenCalledTimes(1));

    expect(callBackendMock).toHaveBeenCalledWith('candidates.page', {
      scanPlanId: 'scan-1',
      offset: 0,
      limit: PAGE_SIZE,
      query: 'shop',
      kind: 'sign',
      state: 'excluded',
      sort: 'source',
      excludedCandidateIds: ['excluded-id'],
      overrideCandidateIds: []
    });
    expect(source.total).toBe(2);
    expect(source.rowAt(0)?.source).toBe('Shop');
    expect(source.filtered).toBe(true);
  });

  it('keeps include-all unfiltered requests independent of local override lists', async () => {
    callBackendMock.mockResolvedValueOnce(page());
    const source = new CandidateSource(() => ({ excluded: ['excluded-id'], manual: ['manual-id'] }));
    source.reset('scan-2');
    await vi.waitFor(() => expect(callBackendMock).toHaveBeenCalledTimes(1));

    expect(callBackendMock).toHaveBeenCalledWith('candidates.page', expect.objectContaining({
      scanPlanId: 'scan-2',
      query: '',
      kind: '',
      state: 'all',
      sort: 'order',
      excludedCandidateIds: [],
      overrideCandidateIds: []
    }));
  });

  it('passes manual IDs only for the manual filter and loads missing pages once', async () => {
    callBackendMock
      .mockResolvedValueOnce(page({ total: 401, hasMore: true }))
      .mockResolvedValueOnce(page({ offset: PAGE_SIZE, total: 401, hasMore: true }));
    const source = new CandidateSource(() => ({ excluded: ['excluded-id'], manual: ['manual-id'] }));
    source.state = 'manual';
    source.reset('scan-3');
    await vi.waitFor(() => expect(callBackendMock).toHaveBeenCalledTimes(1));
    source.ensure(PAGE_SIZE, PAGE_SIZE + 20);
    await vi.waitFor(() => expect(callBackendMock).toHaveBeenCalledTimes(2));

    expect(callBackendMock).toHaveBeenLastCalledWith('candidates.page', expect.objectContaining({
      scanPlanId: 'scan-3',
      offset: PAGE_SIZE,
      limit: PAGE_SIZE,
      state: 'manual',
      sort: 'order',
      excludedCandidateIds: ['excluded-id'],
      overrideCandidateIds: ['manual-id']
    }));
    source.ensure(PAGE_SIZE, PAGE_SIZE + 20);
    expect(callBackendMock).toHaveBeenCalledTimes(2);
  });

  it('does not create one DOM row per candidate when paging a 100k result', async () => {
    callBackendMock.mockResolvedValueOnce(page({ candidates: [], total: 100_000, hasMore: true }));
    const source = new CandidateSource(() => ({ excluded: [], manual: [] }));
    source.reset('large-scan');
    await vi.waitFor(() => expect(callBackendMock).toHaveBeenCalledTimes(1));

    expect(source.total).toBe(100_000);
    expect(source.rowAt(0)).toBeUndefined();
    source.ensure(99_999, 100_000);
    expect(callBackendMock).toHaveBeenCalledTimes(2);
    expect(callBackendMock).toHaveBeenLastCalledWith('candidates.page', expect.objectContaining({
      offset: 99_800,
      limit: PAGE_SIZE
    }));
  });

  it('awaits a missing page for keyboard navigation across a page boundary', async () => {
    const distant = { id: 'distant', source: 'Page two', kind: 'sign', occurrences: 1 };
    callBackendMock
      .mockResolvedValueOnce(page({ total: 401, hasMore: true }))
      .mockResolvedValueOnce(page({ candidates: [distant], offset: PAGE_SIZE, total: 401, hasMore: true }));
    const source = new CandidateSource(() => ({ excluded: [], manual: [] }));
    source.reset('scan-keyboard');
    await vi.waitFor(() => expect(source.total).toBe(401));

    await expect(source.row(PAGE_SIZE)).resolves.toMatchObject({ id: 'distant' });
    expect(callBackendMock).toHaveBeenCalledTimes(2);
  });
  it('loads authoritative kind totals even when resume already supplied preview rows', async () => {
    callBackendMock.mockResolvedValueOnce(page({ total: 100000, kinds: { sign: 60000, book: 40000 } }));
    const source = new CandidateSource(() => ({ excluded: [], manual: [] }));
    source.reset('resumed-plan', [{ id: 'preview', source: 'Preview', kind: 'sign', occurrences: 1 }], 100000);
    expect(source.rowAt(0)?.id).toBe('preview');
    await vi.waitFor(() => expect(source.kinds).toEqual({ sign: 60000, book: 40000 }));
    expect(source.total).toBe(100000);
    expect(callBackendMock).toHaveBeenCalledTimes(1);
  });

  it('discards slow stale pages instead of replacing a newer query count and rows', async () => {
    let resolveOld!: (value: ReturnType<typeof page>) => void;
    callBackendMock.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    callBackendMock.mockResolvedValueOnce(page({ total: 1, candidates: [{ id: 'new', source: 'New query', kind: 'sign', occurrences: 1 }] }));
    const source = new CandidateSource(() => ({ excluded: [], manual: [] }));
    source.reset('fixture');
    source.query = 'new';
    source.reset();
    await vi.waitFor(() => expect(source.total).toBe(1));
    resolveOld(page({ total: 100000 }));
    await Promise.resolve();
    expect(source.total).toBe(1);
    expect(source.rowAt(0)?.id).toBe('new');
  });

  it('can retry a failed page without losing the filter', async () => {
    callBackendMock.mockRejectedValueOnce(new Error('fixture page failure'));
    callBackendMock.mockResolvedValueOnce(page({ total: 1 }));
    const source = new CandidateSource(() => ({ excluded: [], manual: [] }));
    source.query = 'shop';
    source.reset('fixture');
    await vi.waitFor(() => expect(source.error).toBe(t('error.default')));
    source.reset();
    await vi.waitFor(() => expect(source.total).toBe(1));
    expect(source.error).toBe('');
    expect(callBackendMock).toHaveBeenLastCalledWith('candidates.page', expect.objectContaining({ query: 'shop' }));
  });

  it('evicts old pages after traversing a large result and reloads them on return', async () => {
    callBackendMock.mockImplementation(async (_type, payload) => page({
      total: 100000, offset: payload.offset,
      candidates: [{ id: `row-${payload.offset}`, source: `Row ${payload.offset}`, kind: 'sign', occurrences: 1 }]
    }));
    const source = new CandidateSource(() => ({ excluded: [], manual: [] }));
    source.reset('large-fixture');
    await vi.waitFor(() => expect(source.total).toBe(100000));
    for (let index = 1; index <= MAX_CACHED_PAGES + 2; index++) await source.row(index * PAGE_SIZE);
    expect(source.rowAt(0)).toBeUndefined();
    expect(source.rowAt((MAX_CACHED_PAGES + 2) * PAGE_SIZE)?.id).toBe(`row-${(MAX_CACHED_PAGES + 2) * PAGE_SIZE}`);
    expect(await source.row(0)).toMatchObject({ id: 'row-0' });
    expect(callBackendMock).toHaveBeenLastCalledWith('candidates.page', expect.objectContaining({ offset: 0 }));
  });

  it('aborts bulk IDs if the filters change while a page is loading', async () => {
    callBackendMock.mockResolvedValueOnce(page());
    const source = new CandidateSource(() => ({ excluded: [], manual: [] }));
    source.reset('fixture');
    await vi.waitFor(() => expect(source.total).toBe(2));
    let finish!: (value: ReturnType<typeof page>) => void;
    callBackendMock.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const ids = source.allIds();
    const rejected = expect(ids).rejects.toMatchObject({ code: 'CANDIDATE_QUERY_CHANGED' });
    source.query = 'another';
    callBackendMock.mockResolvedValueOnce(page({ total: 0, candidates: [] }));
    source.reset();
    finish(page({ hasMore: true }));
    await rejected;
  });

});
