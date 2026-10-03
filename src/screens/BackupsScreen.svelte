<script lang="ts">
  import { app } from '../lib/app.svelte';
  import type { BackupSummary } from '../lib/api';
  import { t } from '../lib/i18n/index.svelte';
  import { baseName, formatBytes, formatDate, formatNumber, middleEllipsis } from '../lib/format';
  import Callout from '../components/Callout.svelte';
  import Dialog from '../components/Dialog.svelte';
  import Icon from '../components/Icon.svelte';
  import ProgressBar from '../components/ProgressBar.svelte';

  let selectedBackup = $state<BackupSummary | null>(null);
  let confirmRestore = $state(false);

  const hasWorld = $derived(!!app.worldDir);
  const restoring = $derived(app.busy === 'restore');
  const actionBusy = $derived(app.isBusy || app.busy === 'loading');
  const worldName = $derived(app.worldDir ? baseName(app.worldDir) : '');
  const backups = $derived([...app.backups].sort((a, b) => backupTime(b.createdAt) - backupTime(a.createdAt)));

  function backupTime(value: string): number {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : 0;
  }

  function dateLabel(value: string): string {
    return formatDate(value, app.locale) || t('common.unknown');
  }

  function kindLabel(kind: BackupSummary['kind']): string {
    if (kind === 'translation') return t('backups.kind.translation');
    if (kind === 'recovery') return t('backups.kind.recovery');
    return t('common.unknown');
  }

  function locationLabel(backup: BackupSummary): string {
    return backup.inWorldFolder ? t('backups.location.world') : t('backups.location.app');
  }

  function openRestore(backup: BackupSummary): void {
    if (actionBusy) return;
    selectedBackup = backup;
    confirmRestore = true;
  }

  function closeRestore(): void {
    confirmRestore = false;
    selectedBackup = null;
  }

  async function restoreSelected(): Promise<void> {
    const backupSetId = selectedBackup?.backupSetId;
    closeRestore();
    if (backupSetId) await app.restore(backupSetId);
  }

  async function copyBackupId(backupSetId: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(backupSetId);
      app.notify(t('backups.copiedId'), 'success');
    } catch {
      app.notify(t('backups.copyFailed'), 'error');
    }
  }
</script>

<div class="page">
  <header class="page-head">
    <h1>{t('backups.title')}</h1>
    <p class="lead">{t('backups.lead')}</p>
  </header>

  {#if !hasWorld}
    <section class="card empty-state" aria-labelledby="backups-no-world-title">
      <div class="empty-icon" aria-hidden="true"><Icon name="archive" size={28} /></div>
      <div class="empty-copy">
        <h2 id="backups-no-world-title">{t('backups.noWorld')}</h2>
        <p class="muted">{t('backups.noWorldHelp')}</p>
      </div>
      <div class="empty-actions">
        <button type="button" class="btn btn-primary" disabled={actionBusy} onclick={() => app.chooseWorld()}>
          <Icon name="folder" size={18} /> {t('backups.pickWorld')}
        </button>
        <button type="button" class="btn btn-secondary" onclick={() => app.goto('workspace')}>
          {t('nav.workspace')}
        </button>
      </div>
    </section>
  {:else}
    <section class="card list-heading" aria-labelledby="backup-world-title">
      <div class="context-icon" aria-hidden="true"><Icon name="folder" size={22} /></div>
      <div class="context-copy">
        <p class="eyebrow">{t('world.selected')}</p>
        <h2 id="backup-world-title">{worldName}</h2>
        <p class="path mono" title={app.worldDir}>{middleEllipsis(app.worldDir, 96)}</p>
      </div>
      <span class="pill pill-accent num">{t('world.backupsCount', { count: formatNumber(backups.length, app.locale) })}</span>
    </section>

    {#if restoring}
      <section class="card restoring" role="status" aria-live="polite" aria-label={t('status.restoring')}>
        <div class="restoring-head">
          <Icon name="refresh" size={20} />
          <strong>{t('status.restoring')}</strong>
        </div>
        <ProgressBar label={t('status.restoring')} value={null} />
        <p class="muted">{t('common.loading')}</p>
      </section>
    {:else if actionBusy && backups.length}
      <!-- Restore buttons are disabled while a job runs; say why instead of leaving them grey. -->
      <p class="muted busy-note" role="status">{t('backups.busyNote')}</p>
    {:else if app.lastRestoreId}
      <!-- The restore cleared the reviewed scan; say so here, where the user still is. -->
      <Callout tone="success" title={t('restore.rescanTitle')} role="status">
        {t('restore.rescanBody')}
        {#snippet actions()}
          <button type="button" class="btn btn-primary btn-sm" onclick={() => app.goStep('scan')}>{t('restore.toScan')} <Icon name="chevron-right" size={14} /></button>
        {/snippet}
      </Callout>
    {/if}

    {#if backups.length === 0}
      <section class="card empty-state" aria-labelledby="backups-empty-title">
        <div class="empty-icon" aria-hidden="true"><Icon name="archive" size={28} /></div>
        <div class="empty-copy">
          <h2 id="backups-empty-title">{t('backups.empty')}</h2>
          <p class="muted">{t('backups.emptyHelp')}</p>
        </div>
        <button type="button" class="btn btn-secondary" disabled={actionBusy} onclick={() => app.goto('workspace')}>
          {t('nav.workspace')} <Icon name="chevron-right" size={18} />
        </button>
      </section>
    {:else}
      <section aria-labelledby="backup-list-title">
        <h2 id="backup-list-title" class="sr-only">{t('backups.world', { name: worldName })}</h2>
        <ul class="backup-list">
          {#each backups as backup (backup.backupSetId)}
            <li>
              <article class="card backup-row">
                <div class="backup-title">
                  <span class="backup-icon" aria-hidden="true"><Icon name={backup.kind === 'recovery' ? 'undo' : 'archive'} size={18} /></span>
                  <div class="backup-copy">
                    <h3>{kindLabel(backup.kind)}</h3>
                    <div class="backup-meta num">
                      <time>{dateLabel(backup.createdAt)}</time>
                      <span>{t('backups.files', { count: formatNumber(backup.fileCount, app.locale) })}</span>
                      {#if backup.sizeBytes !== undefined}<span>{t('backups.size', { size: formatBytes(backup.sizeBytes, app.locale) })}</span>{/if}
                      <span>{locationLabel(backup)}</span>
                    </div>
                    <button type="button" class="backup-id" title={backup.backupSetId} aria-label={t('backups.copyId')} onclick={() => copyBackupId(backup.backupSetId)}>
                      <Icon name="copy" size={13} /> {t('backups.id')}
                    </button>
                  </div>
                </div>
                <div class="backup-actions">
                  <span class:verified={backup.verified} class:unverified={!backup.verified} class="pill">
                    <Icon name={backup.verified ? 'check-circle' : 'alert-triangle'} size={14} />
                    {backup.verified ? t('backups.verified') : t('backups.unverified')}
                  </span>
                  <button type="button" class="btn btn-secondary" disabled={actionBusy} onclick={() => openRestore(backup)}>
                    <Icon name="undo" size={17} /> {t('backups.restore')}
                  </button>
                </div>
              </article>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</div>

{#if confirmRestore && selectedBackup}
  <Dialog title={t('backups.restoreTitle')} hideClose onClose={closeRestore}>
    <Callout tone="warning" title={t('backups.restoreWarnTitle')}>
      <p>{t('backups.restoreBody')}</p>
    </Callout>
    <ul class="confirm-facts">
      <li><span>{t('world.selected')}</span><strong>{worldName}</strong></li>
      <li><span>{t('backups.kindLabel')}</span><strong>{kindLabel(selectedBackup.kind)}</strong></li>
      <li><span>{t('backups.createdLabel')}</span><strong class="num">{dateLabel(selectedBackup.createdAt)}</strong></li>
      <li><span>{t('backups.filesLabel')}</span><strong class="num">{formatNumber(selectedBackup.fileCount, app.locale)}</strong></li>
      <li><span>{t('backups.integrityLabel')}</span><strong>{selectedBackup.verified ? t('backups.verified') : t('backups.unverified')}</strong></li>
      <li><span>{t('backups.id')}</span><code>{selectedBackup.backupSetId}</code></li>
    </ul>
    {#if selectedBackup.externalTargets?.length}
      <p class="muted">{t('backups.externalHelp')}</p>
      <ul class="external-targets">{#each selectedBackup.externalTargets as path}<li class="mono">{path}</li>{/each}</ul>
    {/if}
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" data-autofocus onclick={closeRestore}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-danger-solid" onclick={restoreSelected}>
        <Icon name="undo" size={17} /> {t('backups.restore')}
      </button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .external-targets { overflow-wrap: anywhere; padding-inline-start: 1em; }
  .empty-state {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-5);
    padding: var(--space-6) var(--space-5);
    border-style: dashed;
    border-color: var(--border-strong);
    box-shadow: none;
  }
  .empty-icon, .context-icon, .backup-icon {
    display: grid;
    place-items: center;
    flex: none;
    color: var(--accent-soft-text);
    background: var(--accent-soft);
    border-radius: var(--radius-lg);
  }
  .empty-icon { width: 56px; height: 56px; }
  .empty-copy { min-width: 0; }
  .empty-copy h2 { font-size: var(--text-xl); }
  .empty-copy p { margin-top: var(--space-1); }
  .empty-actions { display: flex; flex-wrap: wrap; gap: var(--space-3); justify-content: flex-end; }

  .context-icon { width: 48px; height: 48px; }
  .context-copy { min-width: 0; }
  .context-copy h2 { font-size: var(--text-lg); margin-top: 2px; overflow-wrap: anywhere; }
  .path { margin-top: 2px; color: var(--text-secondary); font-size: var(--text-sm); }

  .restoring {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    border-color: var(--accent);
  }
  .restoring-head { display: flex; align-items: center; gap: var(--space-2); color: var(--accent-text); }
  .restoring-head :global(.icon) { animation: pomi-spin 0.9s linear infinite; }
  .restoring p { font-size: var(--text-sm); }

  .list-heading { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-4); margin-block-end: var(--space-4); padding: var(--space-3) var(--space-4); }
  .list-heading .context-icon { width: 40px; height: 40px; }
  .backup-list { display: grid; gap: var(--space-2); list-style: none; margin: 0; padding: 0; }
  .backup-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--space-4); padding: var(--space-3) var(--space-4); }
  .backup-title { display: flex; align-items: flex-start; gap: var(--space-3); min-width: 0; }
  .backup-icon { width: 32px; height: 32px; border-radius: var(--radius-md); }
  .backup-copy { min-width: 0; display: grid; gap: 3px; }
  .backup-copy h3 { font-size: var(--text-md); overflow-wrap: anywhere; }
  .backup-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px var(--space-3); color: var(--text-secondary); font-size: var(--text-xs); }
  .backup-id { display: inline-flex; align-items: center; gap: 4px; width: max-content; max-width: 100%; padding: 0; border: 0; background: transparent; color: var(--text-secondary); font: inherit; font-size: var(--text-xs); text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 2px; }
  .backup-id:hover { color: var(--accent-text); }
  .backup-actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-3); }
  .pill.verified { background: var(--success-soft); color: var(--success-text); }
  .pill.unverified { background: var(--warning-soft); color: var(--warning-text); }

  .confirm-facts { display: grid; gap: var(--space-2); list-style: none; margin: 0; padding: var(--space-3) 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
  .confirm-facts li { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); overflow-wrap: anywhere; }
  .confirm-facts li > span { color: var(--text-secondary); font-size: var(--text-sm); }
  .confirm-facts li > strong, .confirm-facts li > code { min-width: 0; color: var(--text); text-align: end; overflow-wrap: anywhere; }

  @media (max-width: 760px) {
    .backup-row { grid-template-columns: minmax(0, 1fr); }
    .backup-actions { justify-content: flex-start; padding-inline-start: 44px; }
  }

  @media (max-width: 640px) {
    .empty-state, .list-heading { grid-template-columns: 1fr; align-items: start; }
    .empty-actions { justify-content: flex-start; }
    .context-icon, .empty-icon { width: 44px; height: 44px; }
    .list-heading > .pill { justify-self: start; }
    .backup-actions { padding-inline-start: 0; }
    .backup-actions .btn { flex: 1; }
  }

  @media (max-width: 380px) {
    .empty-actions, .empty-actions .btn { width: 100%; }
    .empty-actions .btn { justify-content: center; }
    .backup-row, .list-heading, .empty-state { padding-inline: var(--space-4); }
  }
</style>
