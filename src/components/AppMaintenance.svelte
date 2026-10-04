<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { app } from '../lib/app.svelte';
  import { hasMessage, t, type MessageKey } from '../lib/i18n/index.svelte';
  import { appVersion, dataLocations, openExternal, revealDataFolder, type DataLocations } from '../lib/native';
  import { formatBytes } from '../lib/format';
  import Disclosure from './Disclosure.svelte';
  import Icon from './Icon.svelte';
  import ResetDialog from './ResetDialog.svelte';
  import { APP_VERSION } from '../lib/version';

  // Updates, where the data lives, and a reset. These act at once; they are not part of the
  // settings draft that the save bar commits.
  let version = $state(APP_VERSION);
  let locations = $state<DataLocations | null>(null);
  let resetting = $state(false);
  let updatesOpen = $state(true);

  onMount(() => {
    void appVersion(APP_VERSION).then((value) => (version = value));
    void dataLocations().then((value) => (locations = value));
  });

  // The Help menu's "Check for Updates…" lands here.
  $effect(() => {
    if (app.helpSection !== 'updates') return;
    void tick().then(() => {
      updatesOpen = true;
      document.getElementById('updates')?.scrollIntoView({ block: 'start' });
      app.helpSection = '';
    });
  });

  const errorText = $derived.by(() => {
    if (!app.updateError) return '';
    const key = `update.error.${app.updateError}`;
    return hasMessage(key) ? t(key as MessageKey) : t('update.error.unknown');
  });
  const percent = $derived(app.updateProgress?.total ? `${Math.round((app.updateProgress.downloaded / app.updateProgress.total) * 100)}%`
    : app.updateProgress ? formatBytes(app.updateProgress.downloaded, app.locale) : '');

  async function reveal(): Promise<void> {
    try { await revealDataFolder(); } catch (cause) { app.fail(cause); }
  }
  function openRelease(): void {
    void openExternal(app.update?.releaseUrl ?? 'https://github.com/kim0040/PomiTranslate/releases/latest').catch((cause) => app.fail(cause));
  }
</script>

<Disclosure id="updates" icon="download" title={t('settings.update.title')} subtitle={t('settings.update.lead')} bind:open={updatesOpen}>
  <div class="row">
    <span class="pill num">{t('settings.update.version', { version })}</span>
    <button type="button" class="btn btn-secondary" disabled={app.updateState === 'checking' || app.updateState === 'installing'} onclick={() => app.checkUpdates(true)}>
      <Icon name="refresh" size={14} /> {app.updateState === 'checking' ? t('settings.update.checking') : t('settings.update.check')}
    </button>
    <span class="status" role="status" aria-live="polite">
      {#if app.updateState === 'installing'}{t('settings.update.installing', { percent })}
      {:else if app.updateState === 'error'}<span class="bad">{errorText}</span>
      {:else if app.update?.status === 'current'}<Icon name="check" size={14} /> {t('settings.update.current')}
      {:else if app.update?.status === 'available'}<strong>{t('settings.update.available', { version: app.update.version ?? '' })}</strong>{/if}
    </span>
  </div>
  {#if app.update?.status === 'available'}
    <div class="available">
      {#if app.update.notes}<pre class="notes selectable">{app.update.notes}</pre>{/if}
      <div class="row">
        {#if app.update.canInstall}
          <button type="button" class="btn btn-primary" disabled={app.isBusy || app.updateState === 'installing'} onclick={() => app.installUpdate()}>
            <Icon name="download" size={14} /> {t('settings.update.install')}
          </button>
        {/if}
        <button type="button" class="btn btn-secondary" onclick={openRelease}>{t('settings.update.download')}</button>
        {#if app.update.version !== app.prefs.update_skipped_version}
          <button type="button" class="btn btn-quiet" onclick={() => app.skipUpdate()}>{t('settings.update.skip')}</button>
        {/if}
      </div>
      {#if !app.update.canInstall}<p class="hint">{t('settings.update.manualNote')}</p>
      {:else if app.isBusy}<p class="hint">{t('settings.update.busyNote')}</p>{/if}
    </div>
  {/if}
  <label class="check"><input type="checkbox" checked={app.prefs.update_auto_check} onchange={(event) => app.setPrefs({ update_auto_check: event.currentTarget.checked })} />
    <span><strong>{t('settings.update.auto')}</strong><small>{t('settings.update.autoHint')}</small></span></label>
</Disclosure>

<Disclosure id="data-location" icon="folder" title={t('settings.data.title')} subtitle={t('settings.data.lead')}>
  {#if locations}
    <dl class="paths">
      <div><dt>{t('settings.data.main')}</dt><dd class="mono selectable">{locations.data}</dd></div>
      <div><dt>{t('settings.data.vault')}</dt><dd class="mono selectable">{locations.app}</dd></div>
    </dl>
    <div><button type="button" class="btn btn-secondary" onclick={reveal}><Icon name="folder" size={14} /> {t('settings.data.open')}</button></div>
  {:else}
    <p class="hint">{t('settings.data.preview')}</p>
  {/if}
</Disclosure>

<!-- The danger zone is last on the app tab, and a different colour from every other card. -->
<Disclosure id="reset-app" icon="alert-triangle" tone="danger" title={t('settings.reset.title')} subtitle={t('settings.reset.lead')}>
  <div><button type="button" class="btn btn-danger" disabled={app.isBusy} onclick={() => (resetting = true)}>{t('settings.reset.button')}</button></div>
</Disclosure>

{#if resetting}<ResetDialog onClose={() => (resetting = false)} />{/if}

<style>
  .row { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2) var(--space-3); }
  .status { display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-sm); color: var(--text-secondary); min-height: 20px; }
  .status :global(.icon) { color: var(--success-solid); }
  .bad { color: var(--danger-text); }
  .available { display: grid; gap: var(--space-3); padding: var(--space-3); border-radius: var(--radius-lg); background: var(--accent-soft); }
  .notes { margin: 0; max-height: 160px; overflow: auto; white-space: pre-wrap; font-family: inherit; font-size: var(--text-sm); color: var(--text); }
  .hint { color: var(--text-secondary); font-size: var(--text-xs); margin: 0; }
  .check { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-2); align-items: start; padding: 10px var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-lg); }
  .check > span { display: grid; gap: 2px; }
  .check strong { font-size: var(--text-sm); }
  .check small { color: var(--text-secondary); font-size: var(--text-xs); }
  .paths { margin: 0; display: grid; gap: var(--space-2); }
  .paths > div { display: grid; grid-template-columns: minmax(140px, 0.6fr) minmax(0, 2fr); gap: var(--space-3); align-items: baseline; }
  .paths dt { color: var(--text-secondary); font-size: var(--text-sm); }
  .paths dd { margin: 0; font-size: var(--text-xs); overflow-wrap: anywhere; }
  :global(#updates) { scroll-margin-top: var(--space-4); }
  @media (max-width: 640px) {
    .paths > div { grid-template-columns: 1fr; gap: 2px; }
  }
</style>
