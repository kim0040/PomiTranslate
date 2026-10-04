import { callBackend, type TranslationCounts, type TranslationPage, type TranslationPageMeta, type TranslationRow, type TranslationState } from './api';
import { pagesFor } from './virtual';
import type { EditReason } from './workflow';

export const REVIEW_PAGE_SIZE = 100;
export const MAX_REVIEW_PAGES = 12;
/** Longest edit the sidecar accepts. Longer text is refused there too; this only marks the row early. */
export const MAX_EDIT_CHARS = 32000;

export const emptyCounts = (): TranslationCounts => ({ all: 0, translated: 0, failed: 0, kept: 0, edited: 0 });

export type TranslationPlan = { worldDir: string; scanPlanId: string };

/** One page of the complete translation table, for the review view and for the result's failure list. */
export function fetchTranslationPage(
  plan: TranslationPlan,
  params: { query?: string; state?: TranslationState; offset?: number; limit?: number; draftIds?: string[] }
): Promise<TranslationPage> {
  return callBackend<TranslationPage>('translations.page', {
    worldDir: plan.worldDir,
    scanPlanId: plan.scanPlanId,
    query: params.query ?? '',
    state: params.state ?? 'all',
    offset: params.offset ?? 0,
    limit: params.limit ?? REVIEW_PAGE_SIZE,
    ...(params.draftIds?.length ? { draftIds: params.draftIds } : {})
  });
}

export type DisplayedRow = { text: string; status: TranslationRow['status']; draft: boolean };

/**
 * The translation table as the review view sees it: paged by the sidecar so the total and the rows
 * agree, with the user's unsaved edits held here. Drafts live in app state, not in the view, so
 * navigating away and back (or opening settings) loses nothing.
 *
 * A draft is a string (new text) or null (go back to the AI answer, discarding a saved edit).
 * The shape matches the `edits` map of `translate.apply` and `translate.reapply` exactly.
 */
export class TranslationReview {
  query = $state('');
  state = $state<TranslationState>('all');
  total = $state(0);
  counts = $state<TranslationCounts>(emptyCounts());
  meta = $state<TranslationPageMeta | null>(null);
  loading = $state(false);
  error = $state('');
  /** True once the first page of this job arrived. */
  loaded = $state(false);
  /** Bumped when rows arrive, so a row read inside an effect re-runs. */
  version = $state(0);
  /** Bumped when the table starts over (a retry, a new filter), so selections can be dropped. */
  generation = $state(0);
  drafts = $state<Record<string, string | null>>({});
  /** Refusals the sidecar reported for rows, by candidate id. Cleared when that row is edited. */
  refused = $state<Record<string, EditReason>>({});

  private pages = new Map<number, TranslationRow[]>();
  private inflight = new Map<number, Promise<void>>();
  private token = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private countsTimer: ReturnType<typeof setTimeout> | undefined;
  private plan: () => TranslationPlan | null;

  constructor(plan: () => TranslationPlan | null) {
    this.plan = plan;
  }

  get filtered(): boolean {
    return !!this.query.trim() || this.state !== 'all';
  }

  get dirtyCount(): number {
    return Object.keys(this.drafts).length;
  }

  /** Rows that will be written by the next apply: translated by the AI or edited by hand. */
  get applyCount(): number {
    return this.counts.translated + this.counts.edited;
  }

  private draftIds(): string[] {
    return Object.entries(this.drafts).filter(([, value]) => value !== null).map(([id]) => id);
  }

  /** Forget everything about the job: filters, rows and drafts. */
  clear(): void {
    clearTimeout(this.timer);
    clearTimeout(this.countsTimer);
    this.token += 1;
    this.pages.clear();
    this.inflight.clear();
    this.query = '';
    this.state = 'all';
    this.total = 0;
    this.counts = emptyCounts();
    this.meta = null;
    this.loading = false;
    this.error = '';
    this.loaded = false;
    this.drafts = {};
    this.refused = {};
    this.generation += 1;
    this.version += 1;
  }

  /** Start over for the same job (after a filter, or after rows changed on the sidecar). */
  reset(): void {
    this.token += 1;
    this.pages.clear();
    this.inflight.clear();
    this.error = '';
    this.generation += 1;
    this.version += 1;
    this.ensure(0, REVIEW_PAGE_SIZE, true);
  }

  refetchSoon(delay = 250): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reset(), delay);
  }

  rowAt(index: number): TranslationRow | undefined {
    void this.version;
    const page = Math.floor(index / REVIEW_PAGE_SIZE);
    const rows = this.pages.get(page);
    if (rows) {
      this.pages.delete(page);
      this.pages.set(page, rows);
    }
    return rows?.[index % REVIEW_PAGE_SIZE];
  }

  async row(index: number): Promise<TranslationRow | undefined> {
    const loaded = this.rowAt(index);
    if (loaded || index < 0 || index >= this.total) return loaded;
    const page = Math.floor(index / REVIEW_PAGE_SIZE);
    this.ensure(index, index + 1);
    await this.inflight.get(page);
    return this.rowAt(index);
  }

  ensure(start: number, end: number, refresh = false): void {
    if (!this.plan()) return;
    for (const page of pagesFor(start, Math.max(end, start + 1), REVIEW_PAGE_SIZE)) {
      if ((refresh || !this.pages.has(page)) && !this.inflight.has(page)) {
        const request: Promise<void> = this.load(page).finally(() => {
          if (this.inflight.get(page) === request) this.inflight.delete(page);
          this.loading = this.inflight.size > 0;
        });
        this.inflight.set(page, request);
        this.loading = true;
      }
    }
  }

  private apply(response: TranslationPage): void {
    this.total = response.total;
    this.counts = { ...emptyCounts(), ...response.counts };
    this.meta = response.meta;
    this.loaded = true;
  }

  private async load(page: number): Promise<void> {
    const token = this.token;
    const plan = this.plan();
    if (!plan) return;
    try {
      const response = await fetchTranslationPage(plan, {
        query: this.query, state: this.state, offset: page * REVIEW_PAGE_SIZE, draftIds: this.draftIds()
      });
      if (token !== this.token) return;
      this.pages.delete(page);
      this.pages.set(page, response.rows);
      while (this.pages.size > MAX_REVIEW_PAGES) this.pages.delete(this.pages.keys().next().value!);
      this.apply(response);
      this.version += 1;
    } catch (cause) {
      if (token === this.token) this.error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  /** Counts and metadata only, without disturbing the visible rows or the scroll position. */
  refreshCounts(delay = 450): void {
    clearTimeout(this.countsTimer);
    this.countsTimer = setTimeout(async () => {
      const token = this.token;
      const plan = this.plan();
      if (!plan) return;
      try {
        const response = await fetchTranslationPage(plan, { query: this.query, state: this.state, limit: 1, draftIds: this.draftIds() });
        if (token !== this.token) return;
        this.counts = { ...emptyCounts(), ...response.counts };
        this.meta = response.meta;
      } catch {
        // The chips keep their last numbers; the next page load reports a lasting problem.
      }
    }, delay);
  }

  /** Every id in the table, to find the first refused row beyond the loaded pages. */
  async indexOfId(id: string): Promise<number> {
    const plan = this.plan();
    if (!plan) return -1;
    for (let offset = 0; ; offset += 500) {
      const response = await fetchTranslationPage(plan, { query: this.query, state: this.state, offset, limit: 500 });
      const at = response.rows.findIndex((row) => row.id === id);
      if (at >= 0) return offset + at;
      if (!response.hasMore) return -1;
    }
  }

  // --- drafts ------------------------------------------------------------------------------

  /** What the table and the detail panel show for a row, with its unsaved edit on top. */
  display(row: TranslationRow): DisplayedRow {
    const draft = this.drafts[row.id];
    if (draft === undefined) return { text: row.translated, status: row.status, draft: false };
    if (draft === null) {
      const status = !row.ai ? 'failed' : row.ai === row.source ? 'kept' : 'translated';
      return { text: row.ai, status, draft: true };
    }
    return { text: draft, status: 'edited', draft: true };
  }

  /** Why a row cannot be written yet: the sidecar's refusal, or an obvious problem found while typing. */
  reasonFor(id: string): EditReason | '' {
    const draft = this.drafts[id];
    if (typeof draft === 'string') {
      if (!draft.trim()) return 'empty';
      if (draft.length > MAX_EDIT_CHARS) return 'too_long';
    }
    return this.refused[id] ?? '';
  }

  get refusedIds(): string[] {
    return Object.keys(this.refused);
  }

  setDraft(row: TranslationRow, text: string): void {
    const drafts = { ...this.drafts };
    if (text === row.translated) delete drafts[row.id];
    else if (row.status === 'edited' && text === row.ai) drafts[row.id] = null;
    else drafts[row.id] = text;
    this.drafts = drafts;
    this.dropRefusal(row.id);
    this.refreshCounts();
  }

  /** Back to the AI's answer. A saved edit is discarded by sending null; an unsaved one is just dropped. */
  revert(row: TranslationRow): void {
    const drafts = { ...this.drafts };
    if (row.status === 'edited') drafts[row.id] = null;
    else delete drafts[row.id];
    this.drafts = drafts;
    this.dropRefusal(row.id);
    this.refreshCounts();
  }

  /** True when the row can go back to the AI's answer: it has an edit (saved or not) and an AI answer exists. */
  canRevert(row: TranslationRow): boolean {
    const draft = this.drafts[row.id];
    if (draft === null) return false;
    if (typeof draft === 'string') return !!row.ai || row.status === 'edited';
    return row.status === 'edited';
  }

  private dropRefusal(id: string): void {
    if (!(id in this.refused)) return;
    const refused = { ...this.refused };
    delete refused[id];
    this.refused = refused;
  }

  setRefused(reasons: Record<string, EditReason>): void {
    this.refused = reasons;
  }

  /** The edits map for apply and reapply. */
  edits(): Record<string, string | null> {
    return { ...this.drafts };
  }

  /** After a successful write the drafts are in the world; the table starts over from the sidecar. */
  settle(): void {
    this.drafts = {};
    this.refused = {};
  }
}
