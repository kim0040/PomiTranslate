<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { app } from '../lib/app.svelte';
  import type { Candidate } from '../lib/api';
  import type { SortMode, StateFilter } from '../lib/candidates.svelte';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import { formatNumber } from '../lib/format';
  import CandidateTable from '../components/CandidateTable.svelte';
  import CandidateDetail from '../components/CandidateDetail.svelte';
  import Dialog from '../components/Dialog.svelte';
  import Icon from '../components/Icon.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Popover from '../components/Popover.svelte';

  const source = app.candidates;
  // Why Start will not be available on the next screen, said here while it can still be fixed.
  const blockerLabel: Record<string, MessageKey> = {
    recovery: 'setup.short.recovery', credential: 'setup.short.credential', interrupted: 'setup.short.interrupted',
    model: 'setup.short.model', key: 'setup.short.key'
  };
  const blockedText = $derived(app.runBlockers.map((reason) => t(blockerLabel[reason])).join(', '));
  const draftText = $derived(
    app.draftState === 'saving' ? t('review.draft.saving')
      : app.draftState === 'saved' ? t('review.draft.saved')
      : app.draftState === 'error' ? t('review.draft.error')
      : ''
  );
  let selected = $state<Candidate | null>(null);
  // When the list area is too narrow for a side panel the detail is a sheet. It opens on a click or
  // Enter, never on arrow keys or Space, so moving through the list and toggling rows stays a
  // keyboard-only task.
  let detailOpen = $state(false);
  function select(candidate: Candidate, open: boolean): void {
    selected = candidate;
    if (open) detailOpen = true;
  }
  let wide = $state(true);
  // Below this the side panel is a sheet; up to the second width it is the narrower panel.
  const PANEL_MIN = 680;
  const PANEL_FULL = 940;
  let workareaWidth = $state(PANEL_FULL);
  let workarea: HTMLElement | undefined = $state();
  let busyBulk = $state(false);
  let query = $state(source.query);

  async function setWide(next: boolean): Promise<void> {
    if (next === wide) return;
    const focus = document.activeElement;
    const editing = focus instanceof HTMLElement && focus.id === 'manual-translation';
    const inDetail = focus instanceof HTMLElement && !!focus.closest('.detail, dialog');
    // Going narrow, the sheet takes over only what the user was working on in the panel.
    if (!next) detailOpen = !!selected && (editing || inDetail);
    wide = next;
    await tick();
    if (editing) document.getElementById('manual-translation')?.focus();
    else if (inDetail && wide) document.querySelector<HTMLElement>('tr[aria-selected="true"]')?.focus();
  }

  // The list area, not the window, decides: the sidebar and its rail change the room left over.
  $effect(() => {
    const element = workarea;
    if (!element) return;
    // A local: reading `workareaWidth` back here would make this effect re-observe on every resize.
    const initial = element.clientWidth;
    workareaWidth = initial;
    wide = initial >= PANEL_MIN;
    let frame = 0;
    // Applied on the next frame: changing the columns inside the callback trips a ResizeObserver loop.
    const observer = new ResizeObserver(([entry]) => {
      cancelAnimationFrame(frame);
      const width = entry.contentRect.width;
      frame = requestAnimationFrame(() => {
        workareaWidth = width;
        void setWide(width >= PANEL_MIN);
      });
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  });

  // A choice only changes what a state filter shows. Reload it after a pause, without emptying the
  // list. The estimate is reloaded by the app itself, debounced, when a choice changes.
  $effect(() => {
    void app.reviewVersion;
    untrack(() => {
      if (source.state !== 'all') source.refetchSoon(350);
    });
  });
  // Opening the screen with no estimate yet asks for one; choices made here refresh it themselves.
  $effect(() => {
    untrack(() => {
      if (!app.estimate && !app.estimateLoading) void app.loadEstimate();
    });
  });

  const states: { value: StateFilter; key: MessageKey }[] = [
    { value: 'all', key: 'review.state.all' },
    { value: 'included', key: 'review.state.included' },
    { value: 'excluded', key: 'review.state.excluded' },
    { value: 'manual', key: 'review.state.manual' }
  ];
  // Category and sort live in a popover; the badge says how many of them are not at their default.
  const activeFilters = $derived((source.kind ? 1 : 0) + (source.sort !== 'order' ? 1 : 0));
  // A refetch empties the source's counts for a moment; the chips keep the last list so the one just
  // pressed is not rebuilt (which would drop keyboard focus out of the popover).
  let kindEntries = $state<[string, number][]>([]);
  $effect(() => {
    const entries = Object.entries(source.kinds).sort((a, b) => b[1] - a[1]);
    if (entries.length) kindEntries = entries;
  });

  function setQuery(value: string): void {
    query = value;
    source.query = value;
    source.refetchSoon();
  }
  function setKind(kind: string): void {
    source.kind = source.kind === kind ? '' : kind;
    source.reset();
  }
  function setState(value: StateFilter): void {
    source.state = value;
    source.reset();
  }
  function setSort(value: SortMode): void {
    source.sort = value;
    source.reset();
  }
  function clearFilters(): void {
    query = '';
    source.query = '';
    source.kind = '';
    source.state = 'all';
    source.reset();
  }
  async function bulk(include: boolean): Promise<void> {
    busyBulk = true;
    try {
      app.setIncludedMany(await source.allIds(), include);
    } catch (cause) {
      app.fail(cause);
    } finally {
      busyBulk = false;
    }
  }
</script>

<div class="review">
  <PageHeader title={t('review.title')} lead={t('review.lead')} />

  <div class="toolbar">
    <div class="search">
      <Icon name="search" size={15} />
      <input
        id="review-search"
        class="input"
        type="search"
        value={query}
        placeholder={t('review.search')}
        aria-label={t('review.searchLabel')}
        oninput={(event) => setQuery(event.currentTarget.value)}
      />
    </div>
    <div class="segmented" role="group" aria-label={t('review.state')}>
      {#each states as item (item.value)}
        <button type="button" aria-pressed={source.state === item.value} onclick={() => setState(item.value)}>{t(item.key)}</button>
      {/each}
    </div>
    <Popover label={t('review.filters')} icon="sliders" badge={activeFilters} badgeLabel={t('review.filtersActive')}>
      <div class="field">
        <span class="label">{t('scan.summary.kinds')}</span>
        <div class="kinds" role="group" aria-label={t('scan.summary.kinds')}>
          <button type="button" class="chip" aria-pressed={!source.kind} onclick={() => setKind('')}>{t('review.allKinds')}</button>
          {#each kindEntries as [kind, count] (kind)}
            <button type="button" class="chip" aria-pressed={source.kind === kind} onclick={() => setKind(kind)}>
              {t(`kind.${kind}` as MessageKey)} <span class="num n">{formatNumber(count, app.locale)}</span>
            </button>
          {/each}
        </div>
      </div>
      <div class="field">
        <label class="label" for="review-sort">{t('review.sort')}</label>
        <select id="review-sort" class="select" value={source.sort} onchange={(event) => setSort(event.currentTarget.value as SortMode)}>
          <option value="order">{t('review.sort.order')}</option>
          <option value="source">{t('review.sort.source')}</option>
          <option value="count">{t('review.sort.count')}</option>
          <option value="kind">{t('review.sort.kind')}</option>
        </select>
      </div>
      {#if source.filtered}<button type="button" class="btn btn-quiet btn-sm reset" onclick={clearFilters}>{t('review.clearFilters')}</button>{/if}
    </Popover>
  </div>

  <div class="workarea" class:wide class:compact={workareaWidth < PANEL_FULL} bind:this={workarea}>
    <div class="tablewrap"><CandidateTable selectedId={selected?.id ?? ''} onSelect={select} /></div>
    {#if wide}<div class="detailwrap"><CandidateDetail candidate={selected} /></div>{/if}
  </div>

  <footer class="foot">
    <div class="meta">
      <!-- The three counts are the state of the whole review, so they sit beside the button that leaves it. -->
      <span class="counts num" role="status" aria-live="polite">
        <span class="included">{t('review.included', { count: formatNumber(app.includedCount, app.locale) })}</span>
        <span>{t('review.excluded', { count: formatNumber(app.excluded.size, app.locale) })}</span>
        <span>{t('review.manual', { count: formatNumber(app.manualCount, app.locale) })}</span>
      </span>
      <span class="num muted rows">{t('review.rows', { total: formatNumber(source.total, app.locale) })}</span>
      <!-- Always present, so the footer does not change height as the draft is saved. -->
      <span class="hint draft" class:error={app.draftState === 'error'} aria-live="off">{draftText}</span>
    </div>
    <div class="next">
      {#if app.includedCount === 0}<span class="hint" role="alert">{t('review.nothingIncluded')}</span>
      {:else if blockedText}
        <span class="hint blocked">{t('review.blocked', { reasons: blockedText })}</span>
        {#if app.runBlockers.some((reason) => reason !== 'interrupted')}
          <button type="button" class="btn btn-secondary btn-sm" disabled={app.busy === 'settings'} onclick={() => app.openSettingsFor('review')}>{t('setup.open')}</button>
        {/if}
      {/if}
      <Popover label={t('review.bulk')} placement="up">
        <p class="hint">{t('review.bulkNote', { count: formatNumber(source.total, app.locale) })}</p>
        <button type="button" class="btn btn-secondary btn-sm" disabled={busyBulk || source.total === 0} onclick={() => bulk(false)}>{t('review.excludeVisible')}</button>
        <button type="button" class="btn btn-secondary btn-sm" disabled={busyBulk || source.total === 0} onclick={() => bulk(true)}>{t('review.includeVisible')}</button>
      </Popover>
      <button type="button" class="btn btn-primary btn-lg" disabled={app.includedCount === 0} onclick={() => app.goStep('run')}>
        {t('review.toRun')} <Icon name="chevron-right" size={16} />
      </button>
    </div>
  </footer>
</div>

{#if !wide && selected && detailOpen}
  <Dialog title={t('review.detail.title')} onClose={() => (detailOpen = false)}>
    <CandidateDetail candidate={selected} showHeading={false} />
    {#snippet actions()}<button type="button" class="btn btn-primary" onclick={() => (detailOpen = false)}>{t('common.close')}</button>{/snippet}
  </Dialog>
{/if}

<style>
  .review { animation: pomi-enter var(--dur-base) var(--ease-out) backwards; display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; gap: var(--space-3); height: 100%; min-height: 440px; max-width: var(--page-max); }
  .toolbar { display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; }
  .search { position: relative; flex: 1 1 180px; min-width: 160px; }
  .search :global(.icon) { position: absolute; inset-inline-start: 9px; top: 50%; translate: 0 -50%; color: var(--text-secondary); pointer-events: none; }
  .search .input { padding-inline-start: 32px; }
  .kinds { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .chip { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 0 10px; border-radius: var(--radius-full); border: 1px solid var(--border-control); background: var(--bg-surface); color: var(--text); font-size: var(--text-sm); font-weight: 500; transition: background-color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease); }
  .chip .n { color: var(--text-secondary); font-weight: 500; }
  .chip[aria-pressed='true'] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-soft-text); font-weight: 600; }
  .chip[aria-pressed='true'] .n { color: inherit; }
  @media (hover: hover) { .chip[aria-pressed='false']:hover { background: var(--bg-hover); } }
  .reset { justify-self: start; }
  .workarea { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-3); min-height: 0; }
  .workarea.wide { grid-template-columns: minmax(0, 1fr) 360px; }
  .workarea.wide.compact { grid-template-columns: minmax(0, 1fr) 300px; }
  .tablewrap, .detailwrap { min-height: 0; height: 100%; }
  .foot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3) var(--space-4); flex-wrap: wrap; padding-top: var(--space-3); border-top: 1px solid var(--border); }
  .meta { display: flex; align-items: center; gap: var(--space-2) var(--space-4); flex-wrap: wrap; min-width: 0; }
  .counts { display: inline-flex; gap: var(--space-3); font-size: var(--text-sm); color: var(--text-secondary); }
  .counts .included { color: var(--success-text); font-weight: 600; }
  .rows { font-size: var(--text-sm); }
  .draft { min-width: 7em; }
  .draft.error { color: var(--danger-text); }
  .blocked { color: var(--warning-text); }
  .next { display: flex; align-items: center; gap: var(--space-3); margin-inline-start: auto; }
  /* Short windows: the lead is a nicety, the rows are the work. */
  @media (max-height: 700px) { .review :global(.page-head .lead) { display: none; } }
  @media (max-width: 1100px) { .rows { display: none; } }
  @media (max-width: 640px), (max-height: 520px) {
    .review { height: auto; min-height: 0; grid-template-rows: auto auto minmax(300px, 1fr) auto; }
    .workarea { min-height: 300px; }
    /* The page scrolls here, so the next-step button stays pinned to the bottom of the pane. */
    .foot { position: sticky; inset-block-end: calc(-1 * var(--pane-pad-bottom, var(--space-3))); z-index: 2; padding-block-end: var(--space-3); background: var(--bg-page); }
  }
</style>
