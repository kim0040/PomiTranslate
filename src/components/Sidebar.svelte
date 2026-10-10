<script lang="ts">
  import { app, type Page } from '../lib/app.svelte';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import { formatDuration } from '../lib/format';
  import Icon, { type IconName } from './Icon.svelte';

  const items: { page: Page; icon: IconName; label: 'nav.workspace' | 'nav.backups' | 'nav.settings' | 'nav.help' | 'nav.about' }[] = [
    { page: 'workspace', icon: 'language', label: 'nav.workspace' },
    { page: 'backups', icon: 'archive', label: 'nav.backups' },
    { page: 'settings', icon: 'sliders', label: 'nav.settings' },
    { page: 'help', icon: 'help', label: 'nav.help' },
    { page: 'about', icon: 'info', label: 'nav.about' }
  ];
  // These pages need nothing from the core, so a failed start still leaves a way to help and diagnostics.
  const startupSafe: Page[] = ['help', 'about'];
  function showUpdate(): void {
    app.helpSection = 'updates';
    app.goto('settings');
  }

  const status = $derived(
    app.cancelling ? t('status.cancelling')
      : app.busy === 'scan' ? t('status.scanning')
      : app.busy === 'translate' ? t('status.translating')
      : app.busy === 'restore' ? t('status.restoring')
      : app.busy ? t('status.working')
      : app.startupFailed ? t('startup.failed')
      : t('status.ready')
  );
  // What a screen reader hears: the state and the phase only. The percent and the clock change many
  // times a second and stay visual, so the live region speaks when the work moves on, not on every tick.
  const phaseText = $derived(
    app.isBusy && !app.cancelling && app.progress.phase !== 'idle' ? t(`run.phase.${app.progress.phase}` as MessageKey) : ''
  );
  const announcement = $derived(phaseText ? `${status} · ${phaseText}` : status);
  const taskPage = $derived<Page>(app.busy === 'restore' ? 'backups' : 'workspace');
  const percent = $derived(
    app.busy === 'translate' && app.progress.phase === 'translate' && app.progress.total > 0
      ? Math.round((app.progress.done / app.progress.total) * 100)
      : null
  );
</script>

<aside class="sidebar" class:rail={app.railCollapsed}>
  <div class="titlebar" data-tauri-drag-region></div>
  <div class="brand" data-tauri-drag-region>
    <img class="wordmark" src="/images/wordmark.png" alt="PomiTranslate" width="176" />
    <span class="dark-wordmark" role="img" aria-label="PomiTranslate">Pomi<span>Translate</span></span>
  </div>

  <nav aria-label={t('nav.main')}>
    {#each items as item (item.page)}
      <button
        type="button"
        class="nav"
        class:active={app.page === item.page}
        disabled={app.busy === 'settings' || !app.ready || (app.startupFailed && !startupSafe.includes(item.page))}
        aria-label={t(item.label)}
        aria-current={app.page === item.page ? 'page' : undefined}
        title={app.railCollapsed ? t(item.label) : undefined}
        onclick={() => app.goto(item.page)}
      >
        <Icon name={item.icon} size={20} />
        <span class="label">{t(item.label)}</span>
      </button>
    {/each}
  </nav>

  <div class="foot">
    {#if app.updateAvailable && !app.railCollapsed}
      <button type="button" class="update" onclick={showUpdate}><Icon name="download" size={14} /> {t('update.sidebar', { version: app.update?.version ?? '' })}</button>
    {/if}
    <div class="state" class:busy={app.isBusy} class:failed={app.startupFailed && !app.isBusy}>
      <span class="sr-only" role="status" aria-live="polite">{announcement}</span>
      <img class="pomi" src="/images/pomi.png" alt="" width="32" height="32" />
      <div class="text" aria-hidden="true">
        <span class="dot" class:busy={app.isBusy} class:failed={app.startupFailed && !app.isBusy} aria-hidden="true"></span>
        <span class="status-text">{status}{percent !== null ? ` ${percent}%` : ''}</span>
        {#if app.isBusy && app.progress.startedAt}
          <span class="sub num">{formatDuration((app.now - app.progress.startedAt) / 1000, app.locale)}</span>
        {/if}
      </div>
    </div>
    {#if app.isBusy && app.page !== taskPage}
      <!-- A job keeps running while other pages are open; this is the one-click way back to it. -->
      <button type="button" class="task-link btn btn-secondary btn-sm" onclick={() => app.goto(taskPage)}>{t('status.showTask')}</button>
    {/if}
    <button type="button" class="collapse btn btn-quiet btn-sm" aria-label={t('nav.collapse')} aria-pressed={app.railCollapsed} onclick={() => (app.railCollapsed = !app.railCollapsed)}>
      <Icon name="sidebar" size={18} />
    </button>
  </div>
</aside>

<style>
  /* A source list: tinted, quiet, full height. On macOS the traffic lights sit in its top strip. */
  .sidebar {
    min-height: 0; height: 100%; overflow-y: auto; overscroll-behavior-y: contain; display: flex; flex-direction: column; gap: var(--space-4);
    padding: var(--space-3) var(--space-3) var(--space-3); background: var(--bg-sidebar); border-inline-end: 1px solid var(--border);
  }
  .titlebar { flex: none; height: var(--titlebar-inset); margin: calc(-1 * var(--space-3)) calc(-1 * var(--space-3)) 0; }
  .sidebar.rail { padding-inline: var(--space-2); }
  .brand { padding-inline: var(--space-2); min-height: 40px; display: flex; align-items: center; }
  .wordmark { width: 132px; height: auto; margin-top: -4px; pointer-events: none; }
  .dark-wordmark { display: none; font-size: var(--text-lg); font-weight: 800; letter-spacing: -0.03em; color: var(--text); white-space: nowrap; pointer-events: none; }
  .dark-wordmark span { color: var(--accent-text); }
  :global([data-theme='dark']) .wordmark { display: none; }
  :global([data-theme='dark']) .sidebar:not(.rail) .dark-wordmark { display: inline; }
  @media (max-width: 1000px) { :global([data-theme='dark']) .sidebar:not(.rail) .dark-wordmark { display: none; } }
  .rail .brand { justify-content: center; padding: 0; }
  .rail .wordmark { display: none; }
  .rail .brand::before { content: ''; width: 24px; height: 24px; border-radius: 6px; background: var(--accent); mask: url('/images/pomi.png') center / contain no-repeat; }
  nav { display: grid; gap: 2px; }
  .update { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 28px; padding: 0 var(--space-2); border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent); border-radius: var(--radius-md); background: var(--accent-soft); color: var(--accent-soft-text); font-size: var(--text-sm); font-weight: 600; animation: pomi-fade var(--dur-base) var(--ease-out); }
  .nav {
    display: flex; align-items: center; gap: var(--space-2); min-height: 30px; padding: 0 var(--space-2);
    border: 0; border-radius: var(--radius-md); background: transparent; color: var(--text);
    font-size: var(--text-md); font-weight: 500; text-align: start;
    transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }
  .nav :global(.icon) { color: var(--accent-text); flex: none; }
  .nav.active { background: color-mix(in srgb, var(--text) 10%, transparent); font-weight: 600; }
  .rail .nav { justify-content: center; padding: 0; min-height: 36px; }
  .rail .label { display: none; }
  @media (hover: hover) { .nav:not(.active):hover { background: color-mix(in srgb, var(--text) 5%, transparent); } }
  .foot { margin-top: auto; display: grid; gap: var(--space-2); }
  .state { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2); border-radius: var(--radius-lg); }
  .pomi { width: 32px; height: 32px; object-fit: contain; flex: none; pointer-events: none; }
  .text { display: grid; grid-template-columns: auto 1fr; column-gap: 6px; align-items: center; min-width: 0; font-size: var(--text-sm); font-weight: 500; }
  .status-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub { grid-column: 2; font-weight: 400; color: var(--text-secondary); font-size: var(--text-xs); }
  .dot { width: 7px; height: 7px; border-radius: var(--radius-full); background: var(--success-solid); }
  .dot.busy { background: var(--accent); animation: pomi-pulse-dot 1.4s ease-in-out infinite; }
  .dot.failed { background: var(--danger-solid); }
  .rail .state { justify-content: center; padding: var(--space-2); }
  .rail .text, .rail .pomi { display: none; }
  .rail .state::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--success-solid); }
  .task-link { justify-self: stretch; }
  .rail .task-link { display: none; }
  .collapse { justify-self: start; }
  /* The collapsed rail shows only the dot, so it carries the busy colour too. */
  .sidebar .state.busy::before { background: var(--accent); animation: pomi-pulse-dot 1.4s ease-in-out infinite; }
  .sidebar .state.failed::before { background: var(--danger-solid); }
  .rail .collapse { justify-self: center; }
  @media (max-width: 1000px) { .sidebar { padding-inline: var(--space-2); } .sidebar .label, .sidebar .wordmark, .sidebar .text, .sidebar .pomi, .sidebar .collapse, .sidebar .task-link { display: none; } .sidebar .nav { justify-content: center; padding: 0; min-height: 36px; } .sidebar .brand { justify-content: center; padding: 0; } .sidebar .brand::before { content: ''; width: 24px; height: 24px; border-radius: 6px; background: var(--accent); mask: url('/images/pomi.png') center / contain no-repeat; } .sidebar .state { justify-content: center; } .sidebar .state::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--success-solid); } }
  @media (max-width: 640px) {
    .sidebar { height: auto; flex-direction: row; align-items: center; gap: var(--space-2); padding: var(--space-2); border-inline-end: 0; border-block-end: 1px solid var(--border); overflow: visible; }
    .titlebar { display: none; }
    .brand { min-height: 40px; }
    nav { flex: 1; grid-template-columns: repeat(4, minmax(40px, 1fr)); }
    .foot { display: none; }
  }
</style>
