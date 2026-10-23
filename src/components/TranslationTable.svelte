<script lang="ts">
  import { tick } from 'svelte';
  import { app } from '../lib/app.svelte';
  import type { TranslationRow } from '../lib/api';
  import type { TranslationReview } from '../lib/translation-review.svelte';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import { visibleWindow } from '../lib/virtual';
  import Icon from './Icon.svelte';

  // `open` is true when the user asked to see the row (click, Enter), not when the selection just moved.
  let { review, selectedId, onSelect }: { review: TranslationReview; selectedId: string; onSelect: (row: TranslationRow, open: boolean) => void } = $props();

  // The row grows with the user's text size, so larger text is never clipped.
  const ROW = $derived(Math.round(64 * app.fontScale / 100));
  let viewport: HTMLDivElement | undefined = $state();
  let scrollTop = $state(0);
  let height = $state(420);
  let active = $state(0);

  const win = $derived(visibleWindow({ scrollTop, viewportHeight: height, rowHeight: ROW, total: review.total }));
  const indexes = $derived(Array.from({ length: Math.max(0, win.end - win.start) }, (_, i) => win.start + i));

  // Ask for the pages under the window. The source ignores pages it already has.
  $effect(() => {
    review.ensure(win.start, win.end);
  });

  // A new query or filter starts at the top.
  $effect(() => {
    void review.query; void review.state; void review.generation;
    if (viewport) viewport.scrollTop = 0;
    scrollTop = 0;
    active = 0;
  });

  const statusKey: Record<TranslationRow['status'], MessageKey> = {
    translated: 'translationReview.state.translated.label',
    failed: 'translationReview.state.failed.label',
    kept: 'translationReview.state.kept.label',
    edited: 'translationReview.state.edited.label',
    glossary_mismatch: 'translationReview.state.glossaryMismatch'
  };
  const statusPill: Record<TranslationRow['status'], string> = {
    translated: 'pill-success', failed: 'pill-danger', kept: '', edited: 'pill-accent', glossary_mismatch: 'pill-warning'
  };

  /** Scroll to a row index and move the keyboard focus to it. */
  export async function reveal(index: number): Promise<void> {
    if (review.total === 0) return;
    const next = Math.max(0, Math.min(review.total - 1, index));
    active = next;
    if (viewport) viewport.scrollTop = Math.max(0, next * ROW - ROW);
    scrollTop = viewport?.scrollTop ?? scrollTop;
    await review.row(next);
    await tick();
    viewport?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus();
  }

  async function move(to: number, select = true): Promise<void> {
    if (review.total === 0) return;
    const next = Math.max(0, Math.min(review.total - 1, to));
    active = next;
    if (viewport) {
      const top = next * ROW;
      const header = 40;
      if (top < viewport.scrollTop) viewport.scrollTop = top;
      else if (top + ROW > viewport.scrollTop + viewport.clientHeight - header) viewport.scrollTop = top + ROW - viewport.clientHeight + header;
    }
    const row = await review.row(next);
    scrollTop = viewport?.scrollTop ?? scrollTop;
    await tick();
    viewport?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus();
    if (select && row) onSelect(row, false);
  }

  async function openEditor(row: TranslationRow): Promise<void> {
    onSelect(row, true);
    await tick();
    document.getElementById('translation-edit')?.focus();
  }

  function handleKey(event: KeyboardEvent, index: number, row: TranslationRow | undefined): void {
    const page = Math.max(1, Math.floor(height / ROW) - 1);
    const map: Record<string, () => void> = {
      ArrowDown: () => void move(index + 1),
      ArrowUp: () => void move(index - 1),
      PageDown: () => void move(index + page),
      PageUp: () => void move(index - page),
      Home: () => void move(0),
      End: () => void move(review.total - 1)
    };
    if (map[event.key]) {
      event.preventDefault();
      map[event.key]();
    } else if (event.key === 'Enter' && row) {
      event.preventDefault();
      void openEditor(row);
    }
  }
  // Columns come from the measured width, never from CSS-hidden cells: WebKit (the macOS app's
  // engine) shrinks a fixed-layout table when its cells are hidden by a container query.
  let tableWidth = $state(0);
  const compact = $derived(tableWidth > 0 && tableWidth <= 480);
  const showState = $derived(tableWidth === 0 || tableWidth > 400);
</script>

<div
  class="viewport"
  bind:this={viewport}
  bind:clientHeight={height}
  bind:clientWidth={tableWidth}
  onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
>
  <table role="grid" aria-label={t('translationReview.table')} aria-rowcount={review.total + 1} aria-colcount={showState ? 3 : 2}>
    <thead>
      <tr aria-rowindex="1">
        <th class="c-source" class:compact class:wide={!showState} scope="col">{t('result.before')}</th>
        <th class="c-target" scope="col">{t('result.after')}</th>
        {#if showState}<th class="c-state" class:compact scope="col">{t('review.col.state')}</th>{/if}
      </tr>
    </thead>
    <tbody>
      {#if win.padTop > 0}<tr aria-hidden="true" class="pad" style:height="{win.padTop}px"><td colspan={showState ? 3 : 2}></td></tr>{/if}
      {#each indexes as index (index)}
        {@const row = review.rowAt(index)}
        {#if row}
          {@const shown = review.display(row)}
          {@const problem = review.reasonFor(row.id)}
          <tr
            class:selected={row.id === selectedId}
            class:problem={!!problem}
            data-index={index}
            aria-rowindex={index + 2}
            aria-selected={row.id === selectedId}
            aria-label={t('translationReview.rowLabel', { source: row.source, status: t(statusKey[shown.status]) })}
            tabindex={index === active ? 0 : -1}
            style:height="{ROW}px"
            onclick={() => { active = index; onSelect(row, true); }}
            onkeydown={(event) => handleKey(event, index, row)}
          >
            <td class="c-source"><span class="txt" translate="no">{row.source}</span></td>
            <td class="c-target">
              {#if shown.text}<span class="txt">{shown.text}</span>
              {:else}<span class="txt none">{shown.status === 'failed' ? t('translationReview.noTranslation') : ''}</span>{/if}
            </td>
            {#if showState}<td class="c-state" class:compact>
              {#if row.edited || shown.status === 'edited'}<span class="pill pill-accent"><Icon name="pencil" size={12} /> {t(statusKey.edited)}</span>{/if}
              {#if row.glossaryMismatch}<span class="pill pill-warning"><Icon name="alert-triangle" size={12} /> {t(statusKey.glossary_mismatch)}</span>{/if}
              {#if !row.edited && !row.glossaryMismatch && shown.status !== 'edited'}
                <span class="pill {statusPill[shown.status]}">
                  {#if shown.status === 'translated'}<Icon name="check" size={12} />
                  {:else if shown.status === 'failed'}<Icon name="alert-circle" size={12} />
                  {:else}<Icon name="minus" size={12} />{/if}
                  {row.glossaryStale ? t('glossary.needsCheck') : t(statusKey[shown.status])}
                </span>
              {/if}
              {#if problem}<span class="warn"><Icon name="alert-triangle" size={12} /> {t('translationReview.fixThis')}</span>{/if}
            </td>{/if}
          </tr>
        {:else}
          <tr class="skeleton" aria-rowindex={index + 2} aria-busy="true" style:height="{ROW}px">
            <td class="c-source"><span class="bone" style:width="{50 + ((index * 37) % 40)}%"></span></td>
            <td class="c-target"><span class="bone" style:width="{40 + ((index * 53) % 40)}%"></span></td>
            {#if showState}<td class="c-state" class:compact></td>{/if}
          </tr>
        {/if}
      {/each}
      {#if win.padBottom > 0}<tr aria-hidden="true" class="pad" style:height="{win.padBottom}px"><td colspan={showState ? 3 : 2}></td></tr>{/if}
    </tbody>
  </table>
  {#if review.total === 0 && !review.loading && !review.error && review.loaded}
    <div class="empty" role="status">
      <p class="strong">{t('translationReview.empty')}</p>
      <p class="muted">{t('review.emptyHelp')}</p>
    </div>
  {/if}
  {#if review.error}
    <div class="empty" role="alert">
      <p class="strong">{t('translationReview.loadError')}</p>
      <p class="muted">{review.error}</p>
      <button type="button" class="btn btn-secondary" onclick={() => review.reset()}>{t('common.retry')}</button>
    </div>
  {/if}
</div>

<style>
  .viewport { position: relative; overflow: auto; height: 100%; min-height: 240px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-surface); overscroll-behavior: contain; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; table-layout: fixed; font-size: var(--text-sm); }
  th { position: sticky; top: 0; z-index: 2; height: 30px; padding: 0 var(--space-3); text-align: start; font-size: var(--text-xs); font-weight: 600; color: var(--text-secondary); background: var(--bg-sunken); border-bottom: 1px solid var(--border); }
  td { padding: 0 var(--space-3); border-bottom: 1px solid var(--border); vertical-align: middle; overflow: hidden; }
  tbody tr:not(.pad):not(.skeleton) { cursor: default; }
  tr.selected td { background: var(--bg-selected); }
  tr:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
  tr.problem td.c-state { box-shadow: inset 3px 0 0 var(--danger-solid); }
  .c-source { width: 42%; }
  .c-target { width: auto; }
  .c-state { width: 124px; }
  .txt { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.4; overflow-wrap: anywhere; white-space: pre-line; }
  .c-source .txt { color: var(--text-secondary); }
  .none { color: var(--text-secondary); font-style: italic; }
  .warn { display: flex; align-items: center; gap: 4px; margin-top: 2px; font-size: var(--text-xs); font-weight: 600; color: var(--danger-text); }
  @media (hover: hover) { tbody tr:not(.pad):not(.skeleton):not(.selected):hover td { background: var(--bg-hover); } }
  .bone { display: block; height: 12px; border-radius: 6px; background: linear-gradient(90deg, var(--bg-sunken), var(--bg-hover), var(--bg-sunken)); background-size: 200% 100%; animation: shimmer 1.4s linear infinite; }
  @keyframes shimmer { to { background-position: -200% 0; } }
  .empty { position: absolute; inset: 40px 0 0; display: grid; place-content: center; text-align: center; gap: var(--space-1); padding: var(--space-5); }
  .strong { font-weight: 700; }
  .c-state.compact { width: 96px; }
  .c-source.compact { width: 38%; }
  .c-source.wide { width: 50%; }
</style>
