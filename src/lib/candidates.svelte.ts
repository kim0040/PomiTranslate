import { BackendError, callBackend, type Candidate, type CandidatePage } from './api';
import { describeError } from './errors';
import { pagesFor } from './virtual';

export const PAGE_SIZE = 200;
export const MAX_CACHED_PAGES = 12;
export type StateFilter = 'all' | 'included' | 'excluded' | 'manual';
export type SortMode = 'order' | 'source' | 'count' | 'kind';

/**
 * The candidate list as the review screen sees it: filtered, sorted and paged by the sidecar so
 * the total and the rows can never disagree, and only the pages in view are ever loaded.
 */
export class CandidateSource {
  query = $state('');
  kind = $state('');
  state = $state<StateFilter>('all');
  sort = $state<SortMode>('order');
  total = $state(0);
  kinds = $state<Record<string, number>>({});
  loading = $state(false);
  error = $state('');
  /** Bumped when rows arrive, so a row read inside an effect re-runs. */
  version = $state(0);

  private pages = new Map<number, Candidate[]>();
  private inflight = new Map<number, Promise<void>>();
  private token = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scanPlanId = '';
  private ids: () => { excluded: string[]; manual: string[] };

  constructor(ids: () => { excluded: string[]; manual: string[] }) {
    this.ids = ids;
  }

  get filtered(): boolean {
    return !!this.query.trim() || !!this.kind || this.state !== 'all';
  }

  /** Start over for a scan plan, or after any filter changed. */
  reset(scanPlanId = this.scanPlanId, seed?: Candidate[], seedTotal?: number): void {
    this.scanPlanId = scanPlanId;
    this.token += 1;
    this.pages.clear();
    this.inflight.clear();
    this.error = '';
    this.kinds = {};
    if (seed && !this.filtered && this.sort === 'order') {
      this.pages.set(0, seed.slice(0, PAGE_SIZE));
      this.total = seedTotal ?? seed.length;
      this.version += 1;
    } else {
      this.total = 0;
    }
    // Preview rows do not contain authoritative kind totals. Refresh page zero once.
    this.ensure(0, Math.min(PAGE_SIZE, Math.max(this.total, 1)), !!seed);
  }

  /** Re-run the query after a short pause, so typing does not send a request per key. */
  refetchSoon(delay = 200): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reset(), delay);
  }

  rowAt(index: number): Candidate | undefined {
    void this.version;
    const page = Math.floor(index / PAGE_SIZE);
    const rows = this.pages.get(page);
    if (rows) {
      this.pages.delete(page);
      this.pages.set(page, rows); // most recently used, without creating reactive row copies
    }
    return rows?.[index % PAGE_SIZE];
  }

  /** Return a row after its page has loaded. Used by keyboard navigation across page boundaries. */
  async row(index: number): Promise<Candidate | undefined> {
    const loaded = this.rowAt(index);
    if (loaded || !this.scanPlanId || index < 0 || index >= this.total) return loaded;
    const page = Math.floor(index / PAGE_SIZE);
    this.ensure(index, index + 1);
    await this.inflight.get(page);
    return this.rowAt(index);
  }

  /** Load whichever pages cover rows start..end that are not here yet. */
  ensure(start: number, end: number, refresh = false): void {
    if (!this.scanPlanId) return;
    for (const page of pagesFor(start, Math.max(end, start + 1), PAGE_SIZE)) {
      if ((refresh || !this.pages.has(page)) && !this.inflight.has(page)) {
        let request: Promise<void>;
        request = this.load(page).finally(() => {
          if (this.inflight.get(page) === request) this.inflight.delete(page);
          this.loading = this.inflight.size > 0;
        });
        this.inflight.set(page, request);
        this.loading = true;
      }
    }
  }

  private async load(page: number): Promise<void> {
    const token = this.token;
    const { excluded, manual } = this.ids();
    try {
      const response = await callBackend<CandidatePage>('candidates.page', {
        scanPlanId: this.scanPlanId,
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE,
        query: this.query,
        kind: this.kind,
        state: this.state,
        sort: this.sort,
        excludedCandidateIds: this.state === 'all' ? [] : excluded,
        overrideCandidateIds: this.state === 'manual' ? manual : []
      });
      if (token !== this.token) return; // the filters changed while this was in flight
      this.pages.delete(page);
      this.pages.set(page, response.candidates);
      while (this.pages.size > MAX_CACHED_PAGES) this.pages.delete(this.pages.keys().next().value!);
      this.total = response.total;
      this.kinds = response.kinds;
      this.version += 1;
    } catch (cause) {
      if (token === this.token) this.error = describeError(cause);
    }
  }

  /** Every id matching the current filters, to include or exclude them all at once. */
  async allIds(): Promise<string[]> {
    const token = this.token;
    const { excluded, manual } = this.ids();
    const filter = {
      scanPlanId: this.scanPlanId, query: this.query, kind: this.kind, state: this.state,
      excludedCandidateIds: this.state === 'all' ? [] : excluded,
      overrideCandidateIds: this.state === 'manual' ? manual : []
    };
    const ids: string[] = [];
    for (let offset = 0; ; offset += 500) {
      const response = await callBackend<CandidatePage>('candidates.page', {
        ...filter,
        offset,
        limit: 500,
        sort: 'order'
      });
      if (token !== this.token) throw new BackendError('The filters changed during this operation.', 'CANDIDATE_QUERY_CHANGED');
      ids.push(...response.candidates.map((candidate) => candidate.id));
      if (!response.hasMore) return ids;
    }
  }
}
