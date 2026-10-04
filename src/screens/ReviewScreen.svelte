<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { app } from '../lib/app.svelte';
  import type { Candidate, GlossaryEntry } from '../lib/api';
  import type { SortMode, StateFilter } from '../lib/candidates.svelte';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import { formatNumber } from '../lib/format';
  import CandidateTable from '../components/CandidateTable.svelte';
  import CandidateDetail from '../components/CandidateDetail.svelte';
  import Dialog from '../components/Dialog.svelte';
  import Icon from '../components/Icon.svelte';
  import GlossarySheet from '../components/GlossarySheet.svelte';

  const source = app.candidates;
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
  let glossaryOpen = $state(false);
  let glossaryEntry = $state<GlossaryEntry | null>(null);

  function openGlossary(sourceText = '', targetText = ''): void {
    glossaryEntry = sourceText ? { source: sourceText, target: targetText, mode: 'translate', note: '', caseSensitive: false } : null;
    glossaryOpen = true;
  }

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

  // Changes to who is included only change what a state filter shows. Reload it after a pause.
  $effect(() => {
    void app.excluded.size;
    void Object.keys(app.overrides).length;
    if (source.state !== 'all') source.refetchSoon(350);
    void app.loadEstimate();
  });

  const states: { value: StateFilter; key: MessageKey }[] = [
    { value: 'all', key: 'review.state.all' },
    { value: 'included', key: 'review.state.included' },
    { value: 'excluded', key: 'review.state.excluded' },
    { value: 'manual', key: 'review.state.manual' }
  ];
  const kindEntries = $derived(Object.entries(source.kinds).sort((a, b) => b[1] - a[1]));

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

  onMount(() => {
    const undo = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z' || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('textarea, [contenteditable="true"], input:not([type="checkbox"]):not([type="radio"])')) return;
      if (app.undoIncluded()) event.preventDefault();
    };
    window.addEventListener('keydown', undo);
    return () => window.removeEventListener('keydown', undo);
  });
</script>

<div class="review">
  <header class="head">
    <div class="titles">
      <h1>{t('review.title')}</h1>
      <p class="lead">{t('review.lead')}</p>
    </div>
    <div class="counts" role="status" aria-live="polite">
      <span class="pill pill-success num">{t('review.included', { count: formatNumber(app.includedCount, app.locale) })}</span>
      <span class="pill num">{t('review.excluded', { count: formatNumber(app.excluded.size, app.locale) })}</span>
      <span class="pill pill-accent num">{t('review.manual', { count: formatNumber(app.manualCount, app.locale) })}</span>
    </div>
  </header>

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
    <label class="sort">
      <span class="sr-only">{t('review.sort')}</span>
      <select class="select" value={source.sort} onchange={(event) => setSort(event.currentTarget.value as SortMode)}>
        <option value="order">{t('review.sort')}: {t('review.sort.order')}</option>
        <option value="source">{t('review.sort')}: {t('review.sort.source')}</option>
        <option value="count">{t('review.sort')}: {t('review.sort.count')}</option>
        <option value="kind">{t('review.sort')}: {t('review.sort.kind')}</option>
      </select>
    </label>
    <button type="button" class="btn btn-secondary btn-sm" disabled={!app.worldDir} onclick={() => openGlossary()}>
      <Icon name="book" size={15} /> {t('glossary.worldButton')}
    </button>
  </div>

  <div class="chips" role="group" aria-label={t('scan.summary.kinds')}>
    <button type="button" class="chip" aria-pressed={!source.kind} onclick={() => setKind('')}>
      {t('review.allKinds')}
    </button>
    {#each kindEntries as [kind, count] (kind)}
      <button type="button" class="chip" aria-pressed={source.kind === kind} onclick={() => setKind(kind)}>
        {t(`kind.${kind}` as MessageKey)} <span class="num n">{formatNumber(count, app.locale)}</span>
      </button>
    {/each}
  </div>

  <div class="workarea" class:wide class:compact={workareaWidth < PANEL_FULL} class:empty-compact={!selected && workareaWidth < PANEL_FULL} bind:this={workarea}>
    <div class="tablewrap"><CandidateTable selectedId={selected?.id ?? ''} onSelect={select} /></div>
    {#if wide && selected}
      <div class="detailwrap"><CandidateDetail candidate={selected} onQuickAdd={openGlossary} /></div>
    {:else if wide && workareaWidth < PANEL_FULL}
      <div class="detail-hint" role="status" title={t('review.detail.emptyShort')}><Icon name="list" size={17} /><span class="sr-only">{t('review.detail.emptyShort')}</span></div>
    {:else if wide}
      <div class="detailwrap"><CandidateDetail candidate={null} onQuickAdd={openGlossary} /></div>
    {/if}
  </div>

  <footer class="foot">
    <div class="meta">
      <span class="num muted">{t('review.rows', { total: formatNumber(source.total, app.locale) })}</span>
      {#if source.filtered}<button type="button" class="btn btn-quiet btn-sm" onclick={clearFilters}>{t('review.clearFilters')}</button>{/if}
      <button type="button" class="btn btn-secondary btn-sm" disabled={busyBulk || source.total === 0} onclick={() => bulk(false)}>{t('review.excludeVisible')}</button>
      <button type="button" class="btn btn-secondary btn-sm" disabled={busyBulk || source.total === 0} onclick={() => bulk(true)}>{t('review.includeVisible')}</button>
      <span class="hint">{t('review.bulkNote', { count: formatNumber(source.total, app.locale) })}</span>
    </div>
    <div class="next">
      {#if app.includedCount === 0}<span class="hint" role="alert">{t('review.nothingIncluded')}</span>{/if}
      <button type="button" class="btn btn-primary btn-lg" disabled={app.includedCount === 0} onclick={() => app.goStep('run')}>
        {t('review.toRun')} <Icon name="chevron-right" size={16} />
      </button>
    </div>
  </footer>
</div>

{#if !wide && selected && detailOpen}
  <Dialog title={t('review.detail.title')} onClose={() => (detailOpen = false)}>
    <CandidateDetail candidate={selected} onQuickAdd={openGlossary} showHeading={false} />
    {#snippet actions()}<button type="button" class="btn btn-primary" onclick={() => (detailOpen = false)}>{t('common.close')}</button>{/snippet}
  </Dialog>
{/if}

<GlossarySheet bind:open={glossaryOpen} world={app.worldDir} initialEntry={glossaryEntry} initialScope="world" />

<style>
  .review { animation: pomi-enter var(--dur-base) var(--ease-out) backwards; display: grid; grid-template-rows: auto auto auto minmax(0, 1fr) auto; gap: var(--space-3); height: 100%; min-height: 460px; }
  .head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
  h1 { font-size: var(--text-2xl); }
  .lead { color: var(--text-secondary); margin-top: var(--space-1); }
  .counts { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .toolbar { display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; }
  .search { position: relative; flex: 1 1 260px; min-width: 200px; }
  .search :global(.icon) { position: absolute; inset-inline-start: 9px; top: 50%; translate: 0 -50%; color: var(--text-secondary); pointer-events: none; }
  .search .input { padding-inline-start: 32px; }
  .sort { flex: 0 0 auto; }
  .sort .select { width: auto; min-width: 200px; }
  .chips { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .chip { display: inline-flex; align-items: center; gap: 6px; min-height: 26px; padding: 0 10px; border-radius: var(--radius-full); border: 1px solid var(--border-control); background: var(--bg-surface); color: var(--text); font-size: var(--text-sm); font-weight: 600; transition: background-color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease); }
  .chip .n { color: var(--text-secondary); font-weight: 500; }
  .chip[aria-pressed='true'] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-soft-text); }
  .chip[aria-pressed='true'] .n { color: inherit; }
  @media (hover: hover) { .chip[aria-pressed='false']:hover { background: var(--bg-hover); } }
  .workarea { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-3); min-height: 0; }
  .workarea.wide { grid-template-columns: minmax(0, 1fr) 340px; }
  .workarea.wide.compact { grid-template-columns: minmax(0, 1fr) 280px; }
  .workarea.wide.empty-compact { grid-template-columns: minmax(0, 1fr) 40px; }
  .tablewrap, .detailwrap { min-width: 0; min-height: 0; height: 100%; }
  .detail-hint { display: grid; place-items: start center; padding-top: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-surface); color: var(--text-secondary); }
  .foot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; padding-top: var(--space-3); border-top: 1px solid var(--border); }
  .meta { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .next { display: flex; align-items: center; gap: var(--space-3); margin-inline-start: auto; }
  /* Only the bulk note gives way; the "nothing included" alert explains the disabled button. */
  @media (max-width: 1100px) { .meta .hint { display: none; } }
  @media (max-width: 640px), (max-height: 650px) {
    .review { height: auto; min-height: 0; grid-template-rows: auto auto auto minmax(300px, 1fr) auto; }
    .workarea { min-height: 300px; }
    /* The page scrolls here, so the next-step button stays pinned to the bottom of the pane. */
    .foot { position: sticky; inset-block-end: calc(-1 * var(--pane-pad-bottom, var(--space-3))); z-index: 2; padding-block-end: var(--space-3); background: var(--bg-page); }
  }
</style>
