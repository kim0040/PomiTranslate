<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { app } from './lib/app.svelte';
  import { t, type MessageKey } from './lib/i18n/index.svelte';
  import { applyTheme, storedTheme, watchSystemTheme } from './lib/theme';
  import { inShell, isMac, onDropPath, onMenu, openExternal, requestAttention, setMenuLabels, setTaskProgress, setWindowTitle } from './lib/native';
  import { baseName } from './lib/format';
  import Sidebar from './components/Sidebar.svelte';
  import Stepper from './components/Stepper.svelte';
  import SetupWizard from './components/SetupWizard.svelte';
  import Callout from './components/Callout.svelte';
  import Toasts from './components/Toasts.svelte';
  import Icon from './components/Icon.svelte';
  import WorldScreen from './screens/WorldScreen.svelte';
  import ScanScreen from './screens/ScanScreen.svelte';
  import ReviewScreen from './screens/ReviewScreen.svelte';
  import RunScreen from './screens/RunScreen.svelte';
  import ResultScreen from './screens/ResultScreen.svelte';
  import BackupsScreen from './screens/BackupsScreen.svelte';
  import SettingsScreen from './screens/SettingsScreen.svelte';
  import AboutScreen from './screens/AboutScreen.svelte';
  import HelpScreen from './screens/HelpScreen.svelte';
  import Tour from './components/Tour.svelte';
  import LicensesDialog from './components/LicensesDialog.svelte';

  let pane: HTMLElement | undefined = $state();
  let dropping = $state(false);
  // The page draws the title bar on macOS; the traffic lights sit over the sidebar.
  const macChrome = inShell() && isMac();

  onMount(() => {
    app.theme = storedTheme();
    applyTheme(app.theme);
    const stopTheme = watchSystemTheme(() => app.theme);
    document.documentElement.classList.toggle('mac-chrome', macChrome);
    void app.boot();
    const stops: (() => void)[] = [];
    void onMenu((action) => app.menu(action)).then((stop) => stops.push(stop)).catch(() => {});
    void onDropPath((path) => void app.openDropped(path), (over) => (dropping = over && !app.isBusy))
      .then((stop) => stops.push(stop)).catch(() => {});
    // A right click offers what a native app offers: text actions where there is text, nothing elsewhere.
    const contextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const editable = !!target?.closest('input, textarea, [contenteditable="true"]');
      const selected = !!window.getSelection()?.toString();
      if (!editable && !selected) event.preventDefault();
    };
    // In a browser preview the menu bar does not exist, so its shortcuts are handled here.
    const shortcuts = (event: KeyboardEvent) => {
      if (inShell() || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      const action = event.key === 'o' ? 'open-world' : event.key === ',' ? 'settings' : event.key === 'f' ? 'find' : event.key === '?' ? 'help' : null;
      if (!action) return;
      event.preventDefault();
      app.menu(action);
    };
    // A web link opens in the system browser (or mail app), never inside the app window.
    const links = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.('a[href]');
      const href = anchor?.getAttribute('href') ?? '';
      if (!/^(https:|mailto:)/i.test(href)) return;
      event.preventDefault();
      void openExternal(href).catch((cause) => app.fail(cause));
    };
    if (inShell()) document.addEventListener('contextmenu', contextMenu);
    if (inShell()) document.addEventListener('click', links);
    document.addEventListener('keydown', shortcuts);
    return () => {
      stopTheme();
      stops.forEach((stop) => stop());
      document.removeEventListener('contextmenu', contextMenu);
      document.removeEventListener('click', links);
      document.removeEventListener('keydown', shortcuts);
      app.destroy();
    };
  });

  // A new screen starts at its top, like switching panes in a native window.
  $effect(() => {
    void app.page;
    void app.step;
    untrack(() => pane?.scrollTo({ top: 0 }));
  });

  const worldName = $derived(app.worldDir ? baseName(app.worldDir) : '');
  $effect(() => { void setWindowTitle(worldName ? `${worldName} — PomiTranslate` : 'PomiTranslate'); });

  // Dock / taskbar progress for long jobs, and a nudge when one ends while the window is in the back.
  const taskPercent = $derived.by(() => {
    if (!app.isBusy) return null;
    const p = app.progress;
    if (app.busy === 'translate' && p.phase === 'translate' && p.total > 0) return (p.done / p.total) * 100;
    if (p.fileTotal > 0) return (p.fileIndex / p.fileTotal) * 100;
    return 0;
  });
  let wasBusy = false;
  $effect(() => {
    const percent = taskPercent;
    void setTaskProgress(percent);
    if (percent === null && wasBusy) void requestAttention();
    wasBusy = percent !== null;
  });

  $effect(() => {
    void setMenuLabels({
      openWorld: t('menu.openWorld'), settings: t('menu.settings'), find: t('menu.find'),
      help: t('menu.help'), tour: t('menu.tour'), shortcuts: t('menu.shortcuts'),
      licenses: t('menu.licenses'), report: t('menu.report'), updates: t('menu.updates'),
      appearance: t('menu.appearance'), themeSystem: t('settings.theme.systemShort'),
      themeLight: t('settings.theme.lightShort'), themeDark: t('settings.theme.darkShort')
    });
  });

  const pageTitles: Record<string, MessageKey> = { backups: 'nav.backups', settings: 'nav.settings', about: 'nav.about', help: 'nav.help' };
</script>

<a class="skip" href="#main-content">{t('app.skip')}</a>

<div class="shell" class:rail={app.railCollapsed}>
  <Sidebar />

  <div class="workspace">
    <header class="toolbar" data-tauri-drag-region>
      {#if app.page === 'workspace'}
        <Stepper />
      {:else}
        <span class="toolbar-title" data-tauri-drag-region>{t(pageTitles[app.page])}</span>
      {/if}
      <span class="toolbar-fill" data-tauri-drag-region></span>
      {#if worldName && app.page !== 'workspace'}
        <button type="button" class="world-chip" title={app.worldDir} onclick={() => app.goto('workspace')}>
          <Icon name="folder" size={14} /><span class="truncate">{worldName}</span>
        </button>
      {/if}
    </header>

    <main id="main-content" tabindex="-1" bind:this={pane} class:review-page={app.page === 'workspace' && app.step === 'review'}>
      {#if !app.ready}
        <div class="boot" role="status" aria-live="polite">
          <span class="spin" aria-hidden="true"><Icon name="refresh" size={24} /></span>
          <span>{t('common.loading')}</span>
        </div>
      {:else if app.startupFailed}
        <!-- Help and About need nothing from the core: they stay reachable, under the same retry. -->
        <div class:banner={app.page === 'help' || app.page === 'about'}>
          <Callout tone="danger" title={t('startup.failed')} role="alert">
            <p>{app.banner?.message}</p>
            <p>{t('startup.help')}</p>
            {#snippet actions()}
              <button type="button" class="btn btn-primary" onclick={() => app.boot()}>{t('common.retry')}</button>
              {#if app.page !== 'help'}
                <button type="button" class="btn btn-secondary" onclick={() => app.goto('help')}>{t('startup.openHelp')}</button>
              {/if}
            {/snippet}
          </Callout>
        </div>
        {#if app.page === 'help'}<HelpScreen />{:else if app.page === 'about'}<AboutScreen />{/if}
      {:else}
        {#if app.banner}
          <div class="banner">
            <Callout tone={app.banner.tone === 'error' ? 'danger' : 'warning'} title={t('error.title')} role="alert">
              {app.banner.message}
              {#snippet actions()}
                <button type="button" class="btn btn-quiet btn-sm" onclick={() => (app.banner = null)}>{t('error.dismiss')}</button>
              {/snippet}
            </Callout>
          </div>
        {/if}

        {#if app.page === 'workspace'}
          {#if app.step === 'world'}<WorldScreen />
          {:else if app.step === 'scan'}<ScanScreen />
          {:else if app.step === 'review'}<ReviewScreen />
          {:else if app.step === 'run'}<RunScreen />
          {:else}<ResultScreen />{/if}
        {:else if app.page === 'backups'}
          <BackupsScreen />
        {:else if app.page === 'settings'}
          <SettingsScreen />
        {:else if app.page === 'help'}
          <HelpScreen />
        {:else}
          <AboutScreen />
        {/if}
      {/if}
    </main>
  </div>
</div>

{#if app.showWizard && app.ready && !app.startupFailed}
  <SetupWizard />
{/if}

{#if app.showTour && !app.showWizard && !app.showNotice && app.ready}
  <Tour />
{/if}

{#if app.showLicenses}
  <LicensesDialog onClose={() => (app.showLicenses = false)} />
{/if}

{#if dropping}
  <div class="drop" aria-hidden="true">
    <div class="drop-card"><Icon name="folder" size={28} /><span>{t('world.dropHint')}</span></div>
  </div>
{/if}

<Toasts />

<style>
  .skip {
    position: fixed; z-index: 100; inset-block-start: var(--space-2); inset-inline-start: var(--space-2);
    translate: 0 -160%; padding: var(--space-2) var(--space-3); border-radius: var(--radius-md);
    background: var(--accent); color: var(--text-on-accent); font-weight: 700;
  }
  .skip:focus { translate: 0; }
  /* One window-sized grid: the sidebar and toolbar stay put, only the content pane scrolls. */
  .shell { height: 100vh; height: 100dvh; display: grid; grid-template-columns: var(--sidebar-width) minmax(0, 1fr); overflow: hidden; }
  .shell.rail { grid-template-columns: var(--sidebar-rail) minmax(0, 1fr); }
  .workspace { min-width: 0; min-height: 0; display: grid; grid-template-rows: var(--toolbar-height) minmax(0, 1fr); background: var(--bg-page); }
  .toolbar {
    z-index: 20; min-width: 0; display: flex; align-items: center; gap: var(--space-3); overflow-x: auto; overflow-y: hidden;
    padding: 0 clamp(var(--space-3), 2.4vw, var(--space-6));
    background: var(--bg-toolbar); border-block-end: 1px solid var(--border);
    backdrop-filter: saturate(1.6) blur(16px); -webkit-backdrop-filter: saturate(1.6) blur(16px);
  }
  :global(.mac-chrome) .shell.rail .toolbar { padding-inline-start: calc(var(--space-6) + 24px); }
  .toolbar-title { font-size: var(--text-md); font-weight: 600; white-space: nowrap; }
  .toolbar-fill { flex: 1; align-self: stretch; }
  .world-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 260px; min-height: 26px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius-full); background: var(--bg-surface); color: var(--text-secondary); font-size: var(--text-sm); }
  @media (hover: hover) { .world-chip:hover { color: var(--text); border-color: var(--border-strong); } }
  main {
    --pane-pad-x: clamp(var(--space-4), 2.6vw, var(--space-6)); --pane-pad-bottom: var(--space-6);
    min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain;
    padding: var(--space-5) var(--pane-pad-x) var(--pane-pad-bottom);
  }
  main:focus { outline: none; }
  main.review-page { --pane-pad-bottom: var(--space-3); padding-block-end: var(--space-3); }
  .boot { min-height: 50vh; display: flex; align-items: center; justify-content: center; gap: var(--space-3); color: var(--text-secondary); }
  .banner { margin-block-end: var(--space-4); }
  .drop { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; background: color-mix(in srgb, var(--accent) 12%, transparent); outline: 3px dashed var(--accent); outline-offset: -12px; pointer-events: none; animation: pomi-fade var(--dur-fast) var(--ease-out); }
  .drop-card { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-4) var(--space-5); border-radius: var(--radius-xl); background: var(--bg-surface); color: var(--accent-text); font-weight: 600; box-shadow: var(--shadow-pop); }

  @media (max-width: 1000px) {
    .shell, .shell.rail { grid-template-columns: var(--sidebar-rail) minmax(0, 1fr); }
  }
  @media (max-width: 640px) {
    .shell, .shell.rail { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
    .workspace { grid-row: 2; }
    main { --pane-pad-x: var(--space-3); padding: var(--space-4) var(--space-3) var(--space-6); }
    .toolbar { padding-inline: var(--space-2); }
    .world-chip { display: none; }
  }
</style>
