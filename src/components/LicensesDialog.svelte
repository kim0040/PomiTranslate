<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../lib/i18n/index.svelte';
  import { filterPackages, parseThirdPartyLicenses, type LicensePackage } from '../lib/licenses';
  import Dialog from './Dialog.svelte';

  let { onClose }: { onClose: () => void } = $props();

  // Both files ship inside the app (public/licenses/, written by scripts/generate-licenses.mjs).
  let own = $state('');
  let packages = $state.raw<LicensePackage[]>([]);
  let overview = $state('');
  let failed = $state(false);
  let tab = $state<'third' | 'own'>('third');
  let query = $state('');
  // '' is the overview entry that opens the list; otherwise the package id.
  let selected = $state<number | ''>('');
  let list: HTMLUListElement | undefined = $state();

  onMount(() => {
    void Promise.all([
      fetch('/licenses/LICENSE.txt').then((response) => (response.ok ? response.text() : Promise.reject())),
      fetch('/licenses/THIRD_PARTY_LICENSES.txt').then((response) => (response.ok ? response.text() : Promise.reject()))
    ]).then(([mine, theirs]) => {
      own = mine;
      const parsed = parseThirdPartyLicenses(theirs);
      overview = parsed.overview;
      packages = parsed.packages;
    }).catch(() => { failed = true; });
  });

  const loaded = $derived(packages.length > 0 || overview !== '');
  const shown = $derived(filterPackages(packages, query));
  // The overview entry is part of the list only while nothing is typed.
  const overviewShown = $derived(query.trim() === '' && overview !== '');
  // A selection the filter hides falls back to the first row that is still there.
  const current = $derived.by(() => {
    if (selected === '') return overviewShown ? '' : (shown[0]?.id ?? '');
    return shown.some((pkg) => pkg.id === selected) ? selected : (overviewShown ? '' : (shown[0]?.id ?? ''));
  });
  const pkg = $derived(current === '' ? undefined : packages[current]);
  // The introduction was wrapped for a text file; let it re-flow to the pane.
  const introduction = $derived(overview.replace(/([^\n])\n(?!\n)/g, '$1 '));
  const text = $derived(pkg ? pkg.texts.join('\n\n' + '-'.repeat(40) + '\n\n') : current === '' ? introduction : '');
  const rows = $derived.by((): (number | '')[] => {
    const ids: (number | '')[] = shown.map((p) => p.id);
    return overviewShown ? ['', ...ids] : ids;
  });
  const safeSource = $derived(pkg && /^https?:\/\//.test(pkg.source) ? pkg.source : '');

  function move(event: KeyboardEvent): void {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key) || rows.length === 0) return;
    event.preventDefault();
    const at = rows.indexOf(current);
    const to = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)));
    selected = rows[to];
    // Focus follows once the new row has rendered its tabindex.
    queueMicrotask(() => list?.querySelector<HTMLElement>('[aria-current="true"]')?.focus());
  }
</script>

<Dialog title={t('licenses.title')} size="wide" {onClose}>
  <div class="licenses">
    <p class="lead">{t('licenses.lead')}</p>
    <div class="bar">
      <div class="segmented" role="group" aria-label={t('licenses.title')}>
        <button type="button" aria-pressed={tab === 'third'} onclick={() => (tab = 'third')}>{t('licenses.thirdParty')}</button>
        <button type="button" aria-pressed={tab === 'own'} onclick={() => (tab = 'own')}>{t('licenses.app')}</button>
      </div>
      {#if tab === 'third' && loaded && !failed}
        <input class="input filter" type="search" aria-label={t('licenses.filter')} placeholder={t('licenses.filterPlaceholder')} autocomplete="off" spellcheck="false" bind:value={query} />
        <span class="count" role="status">{t('licenses.count', { shown: shown.length, total: packages.length })}</span>
      {/if}
    </div>

    {#if failed}
      <p role="alert">{t('licenses.failed')}</p>
    {:else if !loaded}
      <p role="status">{t('licenses.loading')}</p>
    {:else if tab === 'own'}
      <div class="split single">
        <!-- A scrolling text must take keyboard focus to scroll without a mouse (WCAG 2.1.1). -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <pre class="text selectable" tabindex="0" aria-label={t('licenses.app')}>{own}</pre>
      </div>
    {:else}
      <div class="split">
        <!-- A list of buttons: Tab reaches the selected row, the arrow keys move within the list. -->
        <ul class="pkgs" aria-label={t('licenses.list')} bind:this={list}>
          {#if overviewShown}
            <li>
              <button type="button" class="row" tabindex={current === '' ? 0 : -1} aria-current={current === '' ? 'true' : undefined} onclick={() => (selected = '')} onkeydown={move}>
                <span class="name">{t('licenses.overview')}</span>
              </button>
            </li>
          {/if}
          {#each shown as item (item.id)}
            <li>
              <button type="button" class="row" tabindex={current === item.id ? 0 : -1} aria-current={current === item.id ? 'true' : undefined} onclick={() => (selected = item.id)} onkeydown={move}>
                <span class="name">{item.name}</span>
                <span class="meta"><span class="version">{item.version}</span><span class="license">{item.license}</span></span>
              </button>
            </li>
          {/each}
          {#if rows.length === 0}<li class="none">{t('licenses.empty')}</li>{/if}
        </ul>

        <section class="detail" aria-label={pkg ? `${pkg.name} ${pkg.version}` : t('licenses.overview')}>
          {#if pkg}
            <header>
              <h3>{pkg.name} <span class="version">{pkg.version}</span></h3>
              <p class="facts">
                <span class="pill">{pkg.license}</span>
                {#if pkg.note}<span class="note">{pkg.note}</span>{/if}
                {#if safeSource}<a href={safeSource} target="_blank" rel="noreferrer">{t('licenses.source')}</a>{/if}
              </p>
            </header>
          {/if}
          {#if text}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <pre class="text selectable" tabindex="0" aria-label={pkg ? t('licenses.textLabel', { name: pkg.name }) : t('licenses.overview')}>{text}</pre>
          {:else if pkg}
            <p class="no-text">{t('licenses.noText')}</p>
          {/if}
        </section>
      </div>
    {/if}
  </div>
  {#snippet actions()}
    <button type="button" class="btn btn-primary" data-autofocus onclick={onClose}>{t('common.close')}</button>
  {/snippet}
</Dialog>

<style>
  /* Fills the dialog body; below a small height the body scrolls instead of squeezing the panes. */
  .licenses { height: 100%; min-height: 340px; display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: var(--space-3); container-type: inline-size; }
  .bar { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2) var(--space-3); min-width: 0; }
  .filter { flex: 1 1 180px; min-width: 0; max-width: 320px; }
  .count { color: var(--text-secondary); font-size: var(--text-sm); white-space: nowrap; }

  .split { display: grid; grid-template-columns: minmax(180px, 250px) minmax(0, 1fr); gap: var(--space-3); min-height: 0; }
  .split.single { grid-template-columns: minmax(0, 1fr); }
  .pkgs { margin: 0; padding: 0; list-style: none; min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-surface); }
  .pkgs > li + li { border-top: 1px solid var(--border); }
  .pkgs > li { content-visibility: auto; contain-intrinsic-size: auto 44px; }
  .row { display: grid; gap: 1px; width: 100%; min-height: 44px; padding: 6px var(--space-3); border: 0; border-radius: 0; background: transparent; color: var(--text); font: inherit; text-align: start; }
  .row:focus-visible { outline-offset: -2px; }
  @media (hover: hover) { .row:hover { background: var(--bg-hover); } }
  .row[aria-current='true'] { background: var(--bg-selected); box-shadow: inset 3px 0 0 var(--accent); }
  .name { font-size: var(--text-sm); font-weight: 600; overflow-wrap: anywhere; }
  .meta { display: flex; flex-wrap: wrap; gap: 0 var(--space-2); color: var(--text-secondary); font-size: var(--text-xs); }
  .version { font-family: var(--font-mono); }
  .license { overflow-wrap: anywhere; }
  .none { padding: var(--space-3); color: var(--text-secondary); font-size: var(--text-sm); }

  .detail { display: grid; grid-template-rows: auto minmax(0, 1fr); align-content: start; gap: var(--space-2); min-width: 0; min-height: 0; }
  .detail:not(:has(header)) { grid-template-rows: minmax(0, 1fr); }
  .detail header { min-width: 0; }
  .detail h3 { font-size: var(--text-lg); color: var(--text); overflow-wrap: anywhere; }
  .detail h3 .version { color: var(--text-secondary); font-size: var(--text-sm); font-weight: 500; }
  .facts { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-3); margin-top: var(--space-1); font-size: var(--text-sm); }
  .facts .pill { white-space: normal; text-align: start; height: auto; padding-block: 2px; }
  .facts a { color: var(--accent-text); }
  .note { color: var(--text-secondary); font-size: var(--text-xs); }
  .no-text { padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-sunken); }

  .text { margin: 0; padding: var(--space-3); min-height: 0; max-height: 100%; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-mono); font-size: var(--text-xs); line-height: 1.5;
    color: var(--text); background: var(--bg-sunken); border: 1px solid var(--border); border-radius: var(--radius-md); }
  .text:focus-visible { outline-offset: -2px; }

  /* Narrow dialog: the list becomes a short strip above the text. */
  @container (max-width: 560px) {
    .split:not(.single) { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(96px, 30%) minmax(0, 1fr); }
  }
</style>
