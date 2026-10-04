<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { app } from '../lib/app.svelte';
  import { formatRequestRange } from '../lib/format';
  import type { Estimate, GlossaryEntry, TranslationRow, TranslationState } from '../lib/api';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import { formatNumber, formatUsd } from '../lib/format';
  import { exceedsCap } from '../lib/workflow';
  import TranslationTable from './TranslationTable.svelte';
  import TranslationDetail from './TranslationDetail.svelte';
  import ApplyDialog from './ApplyDialog.svelte';
  import Callout from './Callout.svelte';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';
  import GlossarySheet from './GlossarySheet.svelte';

  const review = app.translationReview;
  // A job that was written once can only be written again by restoring its own backup first.
  const corrections = $derived(review.meta?.applied ?? app.step === 'result');
  let selected = $state<TranslationRow | null>(null);
  let detailOpen = $state(false);
  let table: TranslationTable | undefined = $state();
  let confirmApply = $state(false);
  let confirmBudget = $state(false);
  let confirmRecoveryRestore = $state(false);
  let refreshingGlossary = $state(false);
  let query = $state(review.query);
  let glossaryOpen = $state(false);
  let glossaryEntry = $state<GlossaryEntry | null>(null);

  function openGlossary(sourceText = '', targetText = ''): void {
    glossaryEntry = sourceText ? { source: sourceText, target: targetText, mode: 'translate', note: '', caseSensitive: false } : null;
    glossaryOpen = true;
  }

  function select(row: TranslationRow, open: boolean): void {
    selected = row;
    if (open) detailOpen = true;
  }
  // A retry or a new filter replaces the rows; a selection from the old table would show stale text.
  $effect(() => {
    void review.generation;
    selected = null;
    detailOpen = false;
  });

  // When the list area is too narrow for a side panel the detail is a sheet.
  let wide = $state(true);
  const PANEL_MIN = 680;
  const PANEL_FULL = 940;
  let workareaWidth = $state(PANEL_FULL);
  let workarea: HTMLElement | undefined = $state();

  async function setWide(next: boolean): Promise<void> {
    if (next === wide) return;
    const focus = document.activeElement;
    const editing = focus instanceof HTMLElement && focus.id === 'translation-edit';
    const inDetail = focus instanceof HTMLElement && !!focus.closest('.detail, dialog');
    if (!next) detailOpen = !!selected && (editing || inDetail);
    wide = next;
    await tick();
    if (editing) document.getElementById('translation-edit')?.focus();
    else if (inDetail && wide) document.querySelector<HTMLElement>('tr[aria-selected="true"]')?.focus();
  }

  $effect(() => {
    const element = workarea;
    if (!element) return;
    const initial = element.clientWidth;
    workareaWidth = initial;
    wide = initial >= PANEL_MIN;
    let frame = 0;
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

  const states: { value: TranslationState; key: MessageKey }[] = [
    { value: 'all', key: 'translationReview.state.all' },
    { value: 'translated', key: 'translationReview.state.translated' },
    { value: 'failed', key: 'translationReview.state.failed' },
    { value: 'kept', key: 'translationReview.state.kept' },
    { value: 'edited', key: 'translationReview.state.edited' },
    { value: 'glossary_mismatch', key: 'translationReview.state.glossaryMismatch' }
  ];

  function setQuery(value: string): void {
    query = value;
    review.query = value;
    review.refetchSoon();
  }
  function setState(value: TranslationState): void {
    review.state = value;
    review.reset();
  }
  function clearFilters(): void {
    query = '';
    review.query = '';
    review.state = 'all';
    review.reset();
  }

  const failedCount = $derived(review.counts.failed);
  const retryCount = $derived(review.meta?.retryCount ?? review.counts.failed);
  const staleCount = $derived(review.meta?.glossaryRefreshCount ?? review.meta?.glossaryStaleCount ?? 0);
  const retryEstimate = $derived(review.meta?.retryEstimate ?? null);
  const glossaryRefreshEstimate = $derived(review.meta?.glossaryRefreshEstimate ?? null);
  const estimate = $derived(refreshingGlossary ? glossaryRefreshEstimate : retryEstimate);
  function estimateLabel(value: Estimate | null): string {
    if (!value) return t('run.cost.unknown');
    const band = value.cost
      ? t('run.cost.band', { low: formatUsd(value.cost.low, app.locale), high: formatUsd(value.cost.high, app.locale) })
      : t('run.cost.unknown');
    const reasoning = value.reasoningIncluded ? ` · ${t('run.estimate.reasoning')}` : '';
    const source = value.priceSource === 'user' ? ` · ${t('settings.price.userBasis')}` : '';
    const requests = formatRequestRange(value, app.locale);
    const requestRange = requests ? ` · ${requests}` : '';
    return `${band}${reasoning}${source}${requestRange}`;
  }
  const estimateText = $derived(estimateLabel(estimate));
  const glossaryRefreshEstimateText = $derived(estimateLabel(glossaryRefreshEstimate));
  const retryOverBudget = $derived(exceedsCap(retryEstimate, app.settings.max_cost_usd));
  const actionCount = $derived(corrections && !review.meta?.glossaryRefreshed ? review.dirtyCount : review.applyCount);
  const canApply = $derived(!app.busy && !review.loading && staleCount === 0 && (corrections ? review.dirtyCount > 0 || !!review.meta?.glossaryRefreshed : review.applyCount > 0 || review.dirtyCount > 0));
  const cost = $derived(review.meta?.usage?.cost_reported ? review.meta.usage.cost ?? 0 : null);
  const recoverySetId = $derived(review.meta?.status === 'reapply_interrupted' ? review.meta.recoverySetId ?? '' : '');

  function retry(): void {
    refreshingGlossary = false;
    if (retryOverBudget) confirmBudget = true;
    else void app.retryFailed();
  }
  function retryAnyway(): void {
    confirmBudget = false;
    void app.retryFailed({ budgetOverride: true, refreshGlossary: refreshingGlossary });
  }

  function refreshGlossary(): void {
    refreshingGlossary = true;
    if (exceedsCap(glossaryRefreshEstimate, app.settings.max_cost_usd)) confirmBudget = true;
    else void app.retryFailed({ refreshGlossary: true });
  }

  function restoreRecoverySnapshot(): void {
    const backupSetId = recoverySetId;
    confirmRecoveryRestore = false;
    if (backupSetId) void app.restore(backupSetId);
  }

  async function jumpToProblem(): Promise<void> {
    const id = review.refusedIds[0];
    if (!id) return;
    if (review.filtered) clearFilters();
    const index = await review.indexOfId(id);
    if (index < 0) return;
    await table?.reveal(index);
    const row = await review.row(index);
    if (row) select(row, !wide);
  }
  // After a refused apply the view is rebuilt; it opens on the first row to fix, with its reason.
  onMount(() => {
    if (review.refusedIds.length) void tick().then(jumpToProblem);
  });
</script>

<div class="review">
  <div class="top">
  <header class="head">
    <div class="titles">
      <h1>{corrections ? t('translationReview.correctionsTitle') : t('translationReview.title')}</h1>
      <p class="lead">{corrections ? t('translationReview.correctionsLead') : t('translationReview.lead')}</p>
    </div>
    <div class="counts" role="status" aria-live="polite">
      <span class="pill pill-success num">{t('translationReview.count.translated', { count: formatNumber(review.counts.translated, app.locale) })}</span>
      {#if failedCount > 0}<span class="pill pill-danger num">{t('translationReview.count.failed', { count: formatNumber(failedCount, app.locale) })}</span>{/if}
      <span class="pill pill-accent num">{t('translationReview.count.edited', { count: formatNumber(review.counts.edited, app.locale) })}</span>
      {#if review.counts.glossary_mismatch > 0}<span class="pill pill-warning num">{t('translationReview.count.glossaryMismatch', { count: formatNumber(review.counts.glossary_mismatch, app.locale) })}</span>{/if}
      {#if review.dirtyCount > 0}<span class="pill pill-warning num">{t('translationReview.count.unsaved', { count: formatNumber(review.dirtyCount, app.locale) })}</span>{/if}
    </div>
  </header>

  {#if staleCount > 0}
    <Callout tone="warning" title={t('glossary.changedTitle')} role="alert">
      {t('glossary.changedHelp', { count: formatNumber(staleCount, app.locale) })}
      <p class="refresh-estimate num">{t('translationReview.retryCost', { cost: glossaryRefreshEstimateText })}</p>
      {#snippet actions()}
        <button type="button" class="btn btn-secondary btn-sm" disabled={!!app.busy || !app.canRun} onclick={refreshGlossary}>
          <Icon name="refresh" size={15} /> {t('glossary.retranslate', { count: formatNumber(staleCount, app.locale) })}
        </button>
      {/snippet}
    </Callout>
  {/if}

  {#if app.reviewResumed && !corrections}
    <Callout tone="info" title={t('translationReview.resumed')}>{t('translationReview.resumedHelp')}</Callout>
  {/if}

  {#if recoverySetId}
    <Callout tone="danger" title={t('translationReview.reapplyInterrupted.title')} role="alert">
      {t('translationReview.reapplyInterrupted.body')}
      {#snippet actions()}
        <button type="button" class="btn btn-secondary btn-sm" disabled={!!app.busy} onclick={() => (confirmRecoveryRestore = true)}>{t('translationReview.reapplyInterrupted.restore')}</button>
        <button type="button" class="btn btn-primary btn-sm" disabled={!canApply || !!app.busy} onclick={() => (confirmApply = true)}>{t('translationReview.reapplyInterrupted.retry')}</button>
      {/snippet}
    </Callout>
  {/if}

  {#if review.refusedIds.length}
    <Callout tone="danger" title={t('translationReview.refused', { count: formatNumber(review.refusedIds.length, app.locale) })} role="alert">
      {t('translationReview.refusedHelp')}
      {#snippet actions()}
        <button type="button" class="btn btn-secondary btn-sm" onclick={jumpToProblem}>{t('translationReview.refusedJump')}</button>
      {/snippet}
    </Callout>
  {/if}
  </div>

  <div class="toolbar">
    <div class="search">
      <Icon name="search" size={15} />
      <input
        id="translation-search"
        class="input"
        type="search"
        value={query}
        placeholder={t('translationReview.search')}
        aria-label={t('translationReview.searchLabel')}
        oninput={(event) => setQuery(event.currentTarget.value)}
      />
    </div>
    <div class="chips" role="group" aria-label={t('review.state')}>
      {#each states as item (item.value)}
        <button type="button" class="chip" aria-pressed={review.state === item.value} onclick={() => setState(item.value)}>
          {t(item.key)} <span class="num n">{formatNumber(review.counts[item.value], app.locale)}</span>
        </button>
      {/each}
    </div>
    <button type="button" class="btn btn-secondary btn-sm" disabled={!app.worldDir} onclick={() => openGlossary()}>
      <Icon name="book" size={15} /> {t('glossary.worldButton')}
    </button>
  </div>

  <div class="workarea" class:wide class:compact={workareaWidth < PANEL_FULL} bind:this={workarea}>
    <div class="tablewrap"><TranslationTable bind:this={table} {review} selectedId={selected?.id ?? ''} onSelect={select} /></div>
    {#if wide}<div class="detailwrap"><TranslationDetail {review} row={selected} onQuickAdd={openGlossary} /></div>{/if}
  </div>

  <footer class="foot">
    <div class="meta">
      {#if corrections}
        <button type="button" class="btn btn-secondary btn-sm" onclick={() => app.closeReview()}><Icon name="chevron-left" size={14} /> {t('translationReview.back')}</button>
      {/if}
      <span class="num muted">{t('review.rows', { total: formatNumber(review.total, app.locale) })}</span>
      {#if review.filtered}<button type="button" class="btn btn-quiet btn-sm" onclick={clearFilters}>{t('review.clearFilters')}</button>{/if}
      {#if cost !== null}<span class="num muted">{t('translationReview.costSoFar', { cost: formatUsd(cost, app.locale) })}</span>{/if}
    </div>
    <div class="next">
      {#if retryCount > 0}
        <div class="retry">
          <button type="button" class="btn btn-secondary" disabled={!!app.busy || !app.canRun} onclick={retry}>
            <Icon name="refresh" size={16} /> {t('translationReview.retry', { count: formatNumber(retryCount, app.locale) })}
          </button>
          <span class="hint num">{t('translationReview.retryCost', { cost: estimateText })}</span>
        </div>
      {/if}
      <button type="button" class="btn btn-primary btn-lg" disabled={!canApply} onclick={() => (confirmApply = true)}>
        <Icon name="check" size={16} />
        {corrections ? t('translationReview.reapply', { count: formatNumber(actionCount, app.locale) }) : t('translationReview.apply', { count: formatNumber(actionCount, app.locale) })}
      </button>
    </div>
  </footer>
</div>

{#if !wide && selected && detailOpen}
  <Dialog title={t('translationReview.detail.title')} onClose={() => (detailOpen = false)}>
    <TranslationDetail {review} row={selected} onQuickAdd={openGlossary} showHeading={false} />
    {#snippet actions()}<button type="button" class="btn btn-primary" onclick={() => (detailOpen = false)}>{t('common.close')}</button>{/snippet}
  </Dialog>
{/if}

<GlossarySheet bind:open={glossaryOpen} world={app.worldDir} initialEntry={glossaryEntry} initialScope="world" />

{#if confirmApply}
  <ApplyDialog {corrections} onClose={() => (confirmApply = false)} onConfirm={() => { confirmApply = false; void app.applyTranslations(); }} />
{/if}

{#if confirmBudget}
  <Dialog title={t('run.budget.title')} onClose={() => (confirmBudget = false)}>
    <p>{t(refreshingGlossary ? 'glossary.refreshBudget' : 'translationReview.retryBudget', { high: formatUsd(estimate?.cost?.high ?? 0, app.locale), cap: formatUsd(app.settings.max_cost_usd ?? 0, app.locale) })}</p>
    {#if formatRequestRange(estimate, app.locale)}<p class="estimate-requests">{formatRequestRange(estimate, app.locale)}</p>{/if}
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" data-autofocus onclick={() => (confirmBudget = false)}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-primary" onclick={retryAnyway}>{t('run.budget.anyway')}</button>
    {/snippet}
  </Dialog>
{/if}

{#if confirmRecoveryRestore}
  <Dialog title={t('translationReview.reapplyInterrupted.confirmTitle')} onClose={() => (confirmRecoveryRestore = false)}>
    <p>{t('translationReview.reapplyInterrupted.confirmBody')}</p>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" data-autofocus onclick={() => (confirmRecoveryRestore = false)}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-danger" disabled={!!app.busy || !recoverySetId} onclick={restoreRecoverySnapshot}>{t('translationReview.reapplyInterrupted.confirm')}</button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .review { animation: pomi-enter var(--dur-base) var(--ease-out) backwards; display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; gap: var(--space-3); height: 100%; min-height: 460px; }
  .top { display: grid; gap: var(--space-3); min-width: 0; }
  .head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
  h1 { font-size: var(--text-2xl); }
  .lead { color: var(--text-secondary); margin-top: var(--space-1); max-width: 72ch; }
  .counts { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .toolbar { display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; }
  .search { position: relative; flex: 1 1 260px; min-width: 200px; }
  .search :global(.icon) { position: absolute; inset-inline-start: 9px; top: 50%; translate: 0 -50%; color: var(--text-secondary); pointer-events: none; }
  .search .input { padding-inline-start: 32px; }
  .chips { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .chip { display: inline-flex; align-items: center; gap: 6px; min-height: 26px; padding: 0 10px; border-radius: var(--radius-full); border: 1px solid var(--border-control); background: var(--bg-surface); color: var(--text); font-size: var(--text-sm); font-weight: 600; transition: background-color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease); }
  .chip .n { color: var(--text-secondary); font-weight: 500; }
  .chip[aria-pressed='true'] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-soft-text); }
  .chip[aria-pressed='true'] .n { color: inherit; }
  .refresh-estimate { margin: var(--space-1) 0 0; color: var(--text-secondary); font-size: var(--text-sm); }
  @media (hover: hover) { .chip[aria-pressed='false']:hover { background: var(--bg-hover); } }
  .workarea { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-3); min-height: 0; }
  .workarea.wide { grid-template-columns: minmax(0, 1fr) 340px; }
  .workarea.wide.compact { grid-template-columns: minmax(0, 1fr) 280px; }
  .tablewrap, .detailwrap { min-height: 0; height: 100%; }
  .foot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; padding-top: var(--space-3); border-top: 1px solid var(--border); }
  .meta { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .next { display: flex; align-items: center; gap: var(--space-4); margin-inline-start: auto; flex-wrap: wrap; justify-content: flex-end; }
  .retry { display: grid; justify-items: end; gap: 2px; }
  .retry .hint { font-size: var(--text-xs); }
  @media (max-width: 640px), (max-height: 650px) {
    .review { height: auto; min-height: 0; grid-template-rows: auto auto minmax(300px, 1fr) auto; }
    .workarea { min-height: 300px; }
    /* The page scrolls here, so the apply button stays pinned to the bottom of the pane. */
    .foot { position: sticky; inset-block-end: calc(-1 * var(--pane-pad-bottom, var(--space-3))); z-index: 2; padding-block-end: var(--space-3); background: var(--bg-page); }
  }
</style>
