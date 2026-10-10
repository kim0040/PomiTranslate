<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { app } from '../lib/app.svelte';
  import type { Candidate } from '../lib/api';
  import { labelFor, t, type MessageKey } from '../lib/i18n/index.svelte';
  import { describeDetail, describeLocation, formatNumber, rawLocation } from '../lib/format';
  import { visibleWindow } from '../lib/virtual';
  import Icon from './Icon.svelte';

  // `open` is true when the user asked to see the row (click, Enter), not when the selection just moved.
  let { selectedId, onSelect }: { selectedId: string; onSelect: (candidate: Candidate, open: boolean) => void } = $props();

  // The row grows with the user's text size, so larger text is never clipped.
  const ROW = $derived(Math.round(60 * app.fontScale / 100));
  const source = app.candidates;
  let viewport: HTMLDivElement | undefined = $state();
  let scrollTop = $state(0);
  let height = $state(420);
  let active = $state(0);
  let menu = $state<{ candidate: Candidate; index: number; x: number; y: number } | null>(null);
  let menuActive = $state(0);
  let menuElement: HTMLDivElement | undefined = $state();

  const win = $derived(visibleWindow({ scrollTop, viewportHeight: height, rowHeight: ROW, total: source.total }));
  const indexes = $derived(Array.from({ length: Math.max(0, win.end - win.start) }, (_, i) => win.start + i));

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
    return labelFor('kind', kind);
  }

  /** The whole location, for the tooltip of a row whose location column is left out. */
  function fullLocation(candidate: Candidate): string {
    const first = candidate.locations?.[0];
    return first ? rawLocation(first) : candidate.location ?? '';
  }

  function placeText(candidate: Candidate): string {
    const first = candidate.locations?.[0];
    const where = first ? describeLocation(first, app.locale, candidate.kind) : candidate.location ?? '';
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
      const header = 40;
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

  function openRowMenu(event: MouseEvent | KeyboardEvent, index: number, candidate: Candidate): void {
    event.preventDefault();
    const rect = event.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : null;
    const x = event instanceof MouseEvent ? event.clientX : rect?.left ?? 12;
    const y = event instanceof MouseEvent ? event.clientY : rect?.top ?? 12;
    active = index;
    onSelect(candidate, false);
    menuActive = 0;
    menu = { candidate, index, x: Math.max(8, Math.min(x, window.innerWidth - 248)), y: Math.max(8, Math.min(y, window.innerHeight - 176)) };
    void tick().then(() => menuElement?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
  }

  function toggleFromMenu(): void {
    if (!menu) return;
    app.setIncluded(menu.candidate.id, app.excluded.has(menu.candidate.id));
    closeMenu();
  }

  function closeMenu(restoreFocus = true): void {
    const index = menu?.index;
    menu = null;
    if (restoreFocus && index !== undefined) void tick().then(() => viewport?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus());
  }

  function editFromMenu(): void {
    if (!menu) return;
    const candidate = menu.candidate;
    const wasExcluded = app.excluded.has(candidate.id);
    closeMenu();
    if (wasExcluded) app.setIncluded(candidate.id, true);
    void openEditor(candidate);
  }

  async function copySourceFromMenu(): Promise<void> {
    if (!menu) return;
    const sourceText = menu.candidate.source;
    closeMenu();
    try {
      await navigator.clipboard.writeText(sourceText);
      app.notify(t('review.context.copied'), 'success');
    } catch {
      app.notify(t('review.context.copyFailed'), 'error');
    }
  }

  function handleDocumentPointer(event: PointerEvent): void {
    const target = event.target;
    if (menu && (!(target instanceof HTMLElement) || !target.closest('.candidate-menu'))) closeMenu(false);
  }

  function handleDocumentKey(event: KeyboardEvent): void {
    if (!menu || event.key !== 'Escape') return;
    event.preventDefault();
    closeMenu();
  }

  async function focusMenuItem(index: number): Promise<void> {
    const items = menuElement?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (!items?.length) return;
    menuActive = Math.max(0, Math.min(items.length - 1, index));
    await tick();
    menuElement?.querySelectorAll<HTMLElement>('[role="menuitem"]')[menuActive]?.focus();
  }

  function handleMenuKey(event: KeyboardEvent): void {
    if (!menu) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? 2
        : menuActive + (event.key === 'ArrowDown' ? 1 : -1);
      void focusMenuItem(next);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      closeMenu();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      menuElement?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[menuActive]?.click();
    }
  }

  function handleMenuFocusout(event: FocusEvent): void {
    if (!menu) return;
    const next = event.relatedTarget;
    if (next instanceof Node && menuElement?.contains(next)) return;
    const row = menu.index;
    const nextRow = next instanceof HTMLElement && next.matches(`[data-index="${row}"]`);
    closeMenu(!nextRow);
  }

  onMount(() => {
    document.addEventListener('pointerdown', handleDocumentPointer);
    document.addEventListener('keydown', handleDocumentKey);
    return () => {
      document.removeEventListener('pointerdown', handleDocumentPointer);
      document.removeEventListener('keydown', handleDocumentKey);
    };
  });

  function handleKey(event: KeyboardEvent, index: number, candidate: Candidate | undefined): void {
    if (candidate && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
      openRowMenu(event, index, candidate);
      return;
    }
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
  // Which columns fit is decided from the measured width and the cells are left out entirely.
  // Hiding cells of a fixed-layout table with CSS (container queries + display:none) makes WebKit,
  // the engine of the macOS app, shrink the whole table instead of giving the space to the text.
  let tableWidth = $state(0);
  // The source text is what the person reads and decides on, so it keeps at least ~420px; the
  // location column only appears when there is room beyond that, and the full location is always in
  // the cell's tooltip and in the detail panel.
  const showWhere = $derived(tableWidth === 0 || tableWidth > 1000);
  const showKind = $derived(tableWidth === 0 || tableWidth > 480);
  const showState = $derived(tableWidth === 0 || tableWidth > 400);
  const columnCount = $derived(2 + (showKind ? 1 : 0) + (showWhere ? 1 : 0) + (showState ? 1 : 0));
</script>

<div
  class="viewport"
  bind:this={viewport}
  bind:clientHeight={height}
  bind:clientWidth={tableWidth}
  onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
>
  <table role="grid" aria-label={t('review.title')} aria-rowcount={source.total + 1} aria-colcount={columnCount}>
    <thead>
      <tr aria-rowindex="1">
        <th class="c-include" scope="col"><span class="sr-only">{t('review.col.include')}</span></th>
        <th class="c-source" scope="col">{t('review.col.source')}</th>
        {#if showKind}<th class="c-kind" class:narrow={!showWhere} scope="col">{t('review.col.kind')}</th>{/if}
        {#if showWhere}<th class="c-where" scope="col">{t('review.col.where')}</th>{/if}
        {#if showState}<th class="c-state" class:narrow={!showKind} scope="col">{t('review.col.state')}</th>{/if}
      </tr>
    </thead>
    <tbody>
      {#if win.padTop > 0}<tr aria-hidden="true" class="pad" style:height="{win.padTop}px"><td colspan={columnCount}></td></tr>{/if}
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
            aria-label={t('review.rowLabel', { source: candidate.source, kind: kindLabel(candidate.kind), places: t('common.places', { count: candidate.occurrences }) })}
            tabindex={index === active ? 0 : -1}
            style:height="{ROW}px"
            onclick={() => { active = index; onSelect(candidate, true); }}
            oncontextmenu={(event) => openRowMenu(event, index, candidate)}
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
            <td class="c-source" title={showWhere ? undefined : fullLocation(candidate)}><span class="src">{candidate.source}</span></td>
            {#if showKind}<td class="c-kind" class:narrow={!showWhere}>
              <span class="kind">{kindLabel(candidate.kind)}</span>
              {#if detailText(candidate)}<span class="detail">{detailText(candidate)}</span>{/if}
            </td>{/if}
            {#if showWhere}<td class="c-where">
              <span class="where" title={candidate.locations?.[0] ? rawLocation(candidate.locations[0]) : candidate.location}>{placeText(candidate)}</span>
              {#if candidate.occurrences > 1}<span class="detail num">{t('common.places', { count: formatNumber(candidate.occurrences, app.locale) })}</span>{/if}
            </td>{/if}
            {#if showState}<td class="c-state" class:narrow={!showKind}>
              {#if state === 'manual'}<span class="pill pill-accent"><Icon name="pencil" size={12} /> {t('review.state.manual.label')}</span>
              {:else if state === 'excluded'}<span class="pill"><Icon name="minus" size={12} /> {t('review.state.excluded.label')}</span>
              {:else}<span class="pill pill-success"><Icon name="check" size={12} /> {t('review.state.included.label')}</span>{/if}
            </td>{/if}
          </tr>
        {:else}
          <tr class="skeleton" aria-rowindex={index + 2} aria-busy="true" style:height="{ROW}px">
            <td class="c-include"></td>
            <td class="c-source"><span class="bone" style:width="{50 + ((index * 37) % 40)}%"></span></td>
            {#if showKind}<td class="c-kind" class:narrow={!showWhere}><span class="bone short"></span></td>{/if}
            {#if showWhere}<td class="c-where"><span class="bone short"></span></td>{/if}
            {#if showState}<td class="c-state" class:narrow={!showKind}></td>{/if}
          </tr>
        {/if}
      {/each}
      {#if win.padBottom > 0}<tr aria-hidden="true" class="pad" style:height="{win.padBottom}px"><td colspan={columnCount}></td></tr>{/if}
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

{#if menu}
  <div bind:this={menuElement} class="candidate-menu" role="menu" aria-label={t('review.context.label')} tabindex="-1" style:left="{menu.x}px" style:top="{menu.y}px"
    oncontextmenu={(event) => event.preventDefault()} onkeydown={handleMenuKey} onfocusout={handleMenuFocusout}>
    <button type="button" role="menuitem" tabindex={menuActive === 0 ? 0 : -1} onclick={toggleFromMenu}>{app.excluded.has(menu.candidate.id) ? t('review.context.include') : t('review.context.exclude')}</button>
    <button type="button" role="menuitem" tabindex={menuActive === 1 ? 0 : -1} onclick={editFromMenu}>{t('review.context.manual')}</button>
    <button type="button" role="menuitem" tabindex={menuActive === 2 ? 0 : -1} onclick={copySourceFromMenu}>{t('review.context.copy')}</button>
  </div>
{/if}

<style>
  /* Columns follow the table's own width (measured in the script), not the window's. */
  .viewport { position: relative; overflow: auto; height: 100%; min-height: 240px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-surface); overscroll-behavior: contain; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; table-layout: fixed; font-size: var(--text-sm); }
  th { position: sticky; top: 0; z-index: 2; height: 30px; padding: 0 var(--space-3); text-align: start; font-size: var(--text-xs); font-weight: 600; color: var(--text-secondary); background: var(--bg-sunken); border-bottom: 1px solid var(--border); }
  td { padding: 0 var(--space-3); border-bottom: 1px solid var(--border); vertical-align: middle; overflow: hidden; }
  tbody tr:not(.pad):not(.skeleton) { cursor: default; }
  tr.selected td { background: var(--bg-selected); }
  tr.excluded .src { color: var(--text-secondary); text-decoration: line-through; text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); }
  tr:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
  .c-include { width: 44px; text-align: center; padding: 0; }
  .c-include input { width: 16px; height: 16px; accent-color: var(--accent); margin: 0; vertical-align: middle; }
  .c-source { width: auto; }
  .c-kind { width: 130px; }
  .c-where { width: 170px; }
  .c-state { width: 104px; }
  .src { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.4; overflow-wrap: anywhere; white-space: pre-line; }
  .kind, .where { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .where { font-weight: 500; font-family: var(--font-mono); font-size: var(--text-xs); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; white-space: normal; overflow-wrap: anywhere; }
  .detail { display: block; font-size: var(--text-xs); color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (hover: hover) { tbody tr:not(.pad):not(.skeleton):not(.selected):hover td { background: var(--bg-hover); } }
  .bone { display: block; height: 12px; border-radius: 6px; background: linear-gradient(90deg, var(--bg-sunken), var(--bg-hover), var(--bg-sunken)); background-size: 200% 100%; animation: shimmer 1.4s linear infinite; }
  .bone.short { width: 60%; }
  @keyframes shimmer { to { background-position: -200% 0; } }
  .empty { position: absolute; inset: 40px 0 0; display: grid; place-content: center; text-align: center; gap: var(--space-1); padding: var(--space-5); }
  .strong { font-weight: 700; }
  .candidate-menu { position: fixed; z-index: 80; width: 232px; display: grid; padding: 4px; border: 1px solid var(--border-strong); border-radius: var(--radius-lg); background: var(--bg-surface); box-shadow: var(--shadow-pop); }
  .candidate-menu button { min-height: 36px; padding: 0 var(--space-3); border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text); text-align: start; font: inherit; font-size: var(--text-sm); }
  .candidate-menu button:hover, .candidate-menu button:focus-visible { background: var(--bg-hover); outline: none; }
  /* The source column always keeps at least ~280px; lower-value columns give way first. */
  .c-kind.narrow { width: 120px; }
  .c-state.narrow { width: 96px; }
</style>
