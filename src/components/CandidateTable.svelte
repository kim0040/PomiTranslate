<script lang="ts">
  import { tick } from 'svelte';
  import { app } from '../lib/app.svelte';
  import type { Candidate } from '../lib/api';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import { describeDetail, describeLocation, formatNumber } from '../lib/format';
  import { visibleWindow } from '../lib/virtual';
  import Icon from './Icon.svelte';

  // `open` is true when the user asked to see the row (click, Enter), not when the selection just moved.
  let { selectedId, onSelect }: { selectedId: string; onSelect: (candidate: Candidate, open: boolean) => void } = $props();

  // One line per row: the work is scanning many of them, so the rows are short.
  const ROW = 44;
  const source = app.candidates;
  let viewport: HTMLDivElement | undefined = $state();
  let scrollTop = $state(0);
  let height = $state(420);
  let width = $state(640);
  // Columns are left out of the markup, not hidden with CSS: a hidden cell still reserves its width in a
  // fixed-layout table, and the spacer rows would then stop short of the right edge.
  const showKind = $derived(width >= 360);
  const showState = $derived(width >= 560);
  const showWhere = $derived(width >= 860);
  const cols = $derived(2 + (showKind ? 1 : 0) + (showState ? 1 : 0) + (showWhere ? 1 : 0));
  let active = $state(0);

  const win = $derived(visibleWindow({ scrollTop, viewportHeight: height, rowHeight: ROW, total: source.total }));
  const indexes = $derived(Array.from({ length: Math.max(0, win.end - win.start) }, (_, i) => win.start + i));
  // Exactly one row is in the tab order. The row the user was on, unless it has scrolled out of the
  // rendered window or its page is not loaded; then the first loaded row, so Tab always lands in the grid.
  const tabbable = $derived.by(() => {
    if (indexes.includes(active) && source.rowAt(active)) return active;
    return indexes.find((index) => !!source.rowAt(index)) ?? -1;
  });

  // Ask for the pages under the window. The source ignores pages it already has.
  $effect(() => {
    source.ensure(win.start, win.end);
  });

  // A new query starts at the top.
  $effect(() => {
    void source.query; void source.kind; void source.state; void source.sort;
    if (viewport) viewport.scrollTop = 0;
    scrollTop = 0;
    active = 0;
  });

  function kindLabel(kind: string): string {
    return t(`kind.${kind}` as MessageKey);
  }

  function placeText(candidate: Candidate): string {
    const first = candidate.locations?.[0];
    const where = first ? describeLocation(first, app.locale) : candidate.location ?? '';
    return where;
  }

  function detailText(candidate: Candidate): string {
    return describeDetail(candidate.locations?.[0]?.detail, app.locale);
  }

  function stateOf(candidate: Candidate): 'excluded' | 'manual' | 'included' {
    if (app.excluded.has(candidate.id)) return 'excluded';
    return app.manualTranslation(candidate).trim() ? 'manual' : 'included';
  }

  async function move(to: number, select = true): Promise<void> {
    if (source.total === 0) return;
    const next = Math.max(0, Math.min(source.total - 1, to));
    active = next;
    if (viewport) {
      const top = next * ROW;
      const header = 32;
      if (top < viewport.scrollTop) viewport.scrollTop = top;
      else if (top + ROW > viewport.scrollTop + viewport.clientHeight - header) viewport.scrollTop = top + ROW - viewport.clientHeight + header;
    }
    const candidate = await source.row(next);
    // Synchronize the virtual window before focusing an offscreen row.
    scrollTop = viewport?.scrollTop ?? scrollTop;
    await tick();
    viewport?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus();
    if (select && candidate) onSelect(candidate, false);
  }

  async function openEditor(candidate: Candidate): Promise<void> {
    onSelect(candidate, true);
    await tick();
    document.getElementById('manual-translation')?.focus();
  }

  function handleKey(event: KeyboardEvent, index: number, candidate: Candidate | undefined): void {
    const page = Math.max(1, Math.floor(height / ROW) - 1);
    const map: Record<string, () => void> = {
      ArrowDown: () => void move(index + 1),
      ArrowUp: () => void move(index - 1),
      PageDown: () => void move(index + page),
      PageUp: () => void move(index - page),
      Home: () => void move(0),
      End: () => void move(source.total - 1)
    };
    if (map[event.key]) {
      event.preventDefault();
      map[event.key]();
    } else if (event.key === ' ' && candidate) {
      event.preventDefault();
      app.setIncluded(candidate.id, app.excluded.has(candidate.id));
      onSelect(candidate, false);
    } else if (event.key === 'Enter' && candidate) {
      event.preventDefault();
      void openEditor(candidate);
    }
  }
</script>

<div
  class="viewport"
  bind:this={viewport}
  bind:clientHeight={height}
  bind:clientWidth={width}
  onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
>
  <table role="grid" aria-label={t('review.title')} aria-rowcount={source.total + 1} aria-colcount={cols}>
    <colgroup>
      <col class="k-include" />
      <col class="k-source" />
      {#if showKind}<col class="k-kind" />{/if}
      {#if showWhere}<col class="k-where" />{/if}
      {#if showState}<col class="k-state" />{/if}
    </colgroup>
    <thead>
      <tr aria-rowindex="1">
        <th class="c-include" scope="col"><span class="sr-only">{t('review.col.include')}</span></th>
        <th class="c-source" scope="col">{t('review.col.source')}</th>
        {#if showKind}<th class="c-kind" scope="col">{t('review.col.kind')}</th>{/if}
        {#if showWhere}<th class="c-where" scope="col">{t('review.col.where')}</th>{/if}
        {#if showState}<th class="c-state" scope="col">{t('review.col.state')}</th>{/if}
      </tr>
    </thead>
    <tbody>
      {#if win.padTop > 0}<tr aria-hidden="true" class="pad" style:height="{win.padTop}px"><td colspan={cols}></td></tr>{/if}
      {#each indexes as index (index)}
        {@const candidate = source.rowAt(index)}
        {#if candidate}
          {@const state = stateOf(candidate)}
          <tr
            class:selected={candidate.id === selectedId}
            class:excluded={state === 'excluded'}
            data-index={index}
            aria-rowindex={index + 2}
            aria-selected={candidate.id === selectedId}
            aria-label={t('review.rowLabel', {
              source: candidate.source, kind: kindLabel(candidate.kind), places: t('common.places', { count: candidate.occurrences }),
              state: t(`review.state.${state}.label` as MessageKey), where: placeText(candidate)
            })}
            tabindex={index === tabbable ? 0 : -1}
            style:height="{ROW}px"
            onclick={() => { active = index; onSelect(candidate, true); }}
            onkeydown={(event) => handleKey(event, index, candidate)}
          >
            <td class="c-include">
              <input
                type="checkbox"
                tabindex="-1"
                aria-label={t('review.detail.include')}
                checked={state !== 'excluded'}
                onclick={(event) => event.stopPropagation()}
                onchange={(event) => app.setIncluded(candidate.id, event.currentTarget.checked)}
              />
            </td>
            <td class="c-source">
              <span class="line" title={candidate.source}>
                {#if state === 'manual'}<span class="mark" title={t('review.state.manual.label')}><Icon name="pencil" size={13} /></span>{/if}
                <span class="src">{candidate.source}</span>
              </span>
            </td>
            {#if showKind}
              <td class="c-kind"><span class="kind" title={detailText(candidate) ? `${kindLabel(candidate.kind)} · ${detailText(candidate)}` : kindLabel(candidate.kind)}>{kindLabel(candidate.kind)}</span></td>
            {/if}
            {#if showWhere}
              <td class="c-where"><span class="where" title={placeText(candidate)}>{placeText(candidate)}</span></td>
            {/if}
            {#if showState}
              <!-- Only a state worth noticing gets a word. "Included" is what almost every row is. -->
              <td class="c-state">
                {#if state === 'manual'}<span class="pill pill-accent pill-dot">{t('review.state.manual.label')}</span>
                {:else if state === 'excluded'}<span class="pill pill-dot">{t('review.state.excluded.label')}</span>{/if}
              </td>
            {/if}
          </tr>
        {:else}
          <tr class="skeleton" aria-rowindex={index + 2} aria-busy="true" style:height="{ROW}px">
            <td class="c-include"></td>
            <td class="c-source"><span class="bone" style:width="{50 + ((index * 37) % 40)}%"></span></td>
            {#if showKind}<td class="c-kind"><span class="bone short"></span></td>{/if}
            {#if showWhere}<td class="c-where"><span class="bone short"></span></td>{/if}
            {#if showState}<td class="c-state"></td>{/if}
          </tr>
        {/if}
      {/each}
      {#if win.padBottom > 0}<tr aria-hidden="true" class="pad" style:height="{win.padBottom}px"><td colspan={cols}></td></tr>{/if}
    </tbody>
  </table>
  {#if source.total === 0 && !source.loading && !source.error}
    <div class="empty" role="status">
      <p class="strong">{t('review.empty')}</p>
      <p class="muted">{t('review.emptyHelp')}</p>
    </div>
  {/if}
  {#if source.error}
    <div class="empty" role="alert">
      <p class="strong">{t('review.loadError')}</p>
      <p class="muted">{source.error}</p>
      <button type="button" class="btn btn-secondary" onclick={() => source.reset()}>{t('common.retry')}</button>
    </div>
  {/if}
</div>

<style>
  .viewport { position: relative; overflow: auto; height: 100%; min-height: 240px; border: 1px solid var(--border); border-radius: var(--radius-xl); background: var(--bg-surface); box-shadow: var(--shadow-card); overscroll-behavior: contain; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; table-layout: fixed; font-size: var(--text-md); }
  .k-include { width: 44px; }
  .k-kind { width: 132px; }
  .k-where { width: 200px; }
  .k-state { width: 108px; }
  th { position: sticky; top: 0; z-index: 2; height: 32px; padding: 0 var(--space-3); text-align: start; font-size: var(--text-xs); font-weight: 600; color: var(--text-secondary); background: var(--bg-sunken); border-bottom: 1px solid var(--border); }
  td { padding: 0 var(--space-3); border-bottom: 1px solid var(--border); vertical-align: middle; overflow: hidden; }
  tbody tr:not(.pad):not(.skeleton) { cursor: default; }
  tr.selected td { background: var(--bg-selected); }
  tr.selected td.c-include { box-shadow: inset 2px 0 0 var(--accent); }
  tr.excluded .src { color: var(--text-secondary); text-decoration: line-through; text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); }
  tr:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
  .c-include { text-align: center; padding: 0; }
  .c-include input { width: 16px; height: 16px; accent-color: var(--accent); margin: 0; vertical-align: middle; }
  .line { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .mark { flex: none; display: inline-flex; color: var(--accent-text); }
  .src { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kind, .where { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); font-size: var(--text-sm); }
  .where { font-family: var(--font-mono); font-size: var(--text-xs); }
  @media (hover: hover) { tbody tr:not(.pad):not(.skeleton):not(.selected):hover td { background: var(--bg-hover); } }
  .bone { display: block; height: 12px; border-radius: 6px; background: linear-gradient(90deg, var(--bg-sunken), var(--bg-hover), var(--bg-sunken)); background-size: 200% 100%; animation: shimmer 1.4s linear infinite; }
  .bone.short { width: 60%; }
  @keyframes shimmer { to { background-position: -200% 0; } }
  .empty { position: absolute; inset: 32px 0 0; display: grid; place-content: center; text-align: center; gap: var(--space-1); padding: var(--space-5); }
  .strong { font-weight: 600; }
</style>
