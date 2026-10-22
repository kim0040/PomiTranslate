<script lang="ts">
  import { app } from '../lib/app.svelte';
  import type { BackupSummary } from '../lib/api';
  import { t } from '../lib/i18n/index.svelte';
  import { baseName, formatBytes, formatDate, formatNumber, middleEllipsis } from '../lib/format';
  import Callout from '../components/Callout.svelte';
  import Dialog from '../components/Dialog.svelte';
  import Icon from '../components/Icon.svelte';
  import ProgressBar from '../components/ProgressBar.svelte';
  import { lastCopyIds, needsForRecovery, prunePlan } from '../lib/backups';

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

  // Sets that are the only way back to the untranslated world: deleting one needs a deliberate yes.
  const lastCopies = $derived(new Set(app.backupUsage?.lastCopyIds ?? [...lastCopyIds(app.backups)]));
  const admin = $derived(app.backupAdminSupported);

  let toDelete = $state<BackupSummary | null>(null);
  let understood = $state(false);
  function askDelete(backup: BackupSummary): void {
    if (actionBusy) return;
    toDelete = backup;
    understood = false;
  }
  async function deleteSelected(): Promise<void> {
    const backup = toDelete;
    if (!backup) return;
    const last = lastCopies.has(backup.backupSetId);
    toDelete = null;
    await app.deleteBackup(backup.backupSetId, backup.inWorldFolder ? 'world' : 'app', last);
  }

  let keepLatest = $state(3);
  let confirmPrune = $state(false);
  // Pruning only touches the app's own store; sets kept inside the world folder are left alone.
  const appSets = $derived(app.backups.filter((backup) => !backup.inWorldFolder));
  const keep = $derived(Math.max(1, Math.min(1000, Math.floor(Number(keepLatest)) || 1)));
  const plan = $derived(prunePlan(appSets, keep, lastCopies));
  const freed = $derived(plan.doomed.reduce((sum, backup) => sum + (backup.sizeBytes ?? 0), 0));
  async function pruneNow(): Promise<void> {
    confirmPrune = false;
    await app.pruneBackups(keep, 'app');
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
    <section class="card world-context" aria-labelledby="backup-world-title">
      <div class="context-icon" aria-hidden="true"><Icon name="folder" size={24} /></div>
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
        <div class="list-heading">
          <h2 id="backup-list-title" class="section-title">{t('backups.world', { name: worldName })}</h2>
          <p class="muted num">{t('world.backupsCount', { count: formatNumber(backups.length, app.locale) })}</p>
        </div>
        {#if app.backupUsage}
          <p class="muted usage num">{t('backups.usage', {
            world: formatBytes(app.backupUsage.worldBytes, app.locale),
            all: formatBytes(app.backupUsage.appBytes, app.locale)
          })}{app.backupUsage.appBytesApproximate ? ` ${t('backups.usageApprox')}` : ''}</p>
        {/if}
        {#if admin && appSets.length > 1}
          <div class="prune">
            <label for="keep-latest">{t('backups.keepLatest')}</label>
            <input id="keep-latest" class="input num" type="number" min="1" max="1000" step="1" bind:value={keepLatest} />
            <button type="button" class="btn btn-secondary btn-sm" disabled={actionBusy || !plan.doomed.length} onclick={() => (confirmPrune = true)}>
              {plan.doomed.length ? t('backups.pruneButton', { count: formatNumber(plan.doomed.length, app.locale) }) : t('backups.pruneNothing')}
            </button>
          </div>
        {/if}
        <ul class="backup-list">
          {#each backups as backup (backup.backupSetId)}
            <li>
              <article class="card backup-row" aria-label={`${kindLabel(backup.kind)} · ${dateLabel(backup.createdAt)}`}>
                <div class="row-main">
                  <span class="backup-icon" aria-hidden="true"><Icon name={backup.kind === 'recovery' ? 'undo' : 'archive'} size={18} /></span>
                  <div class="row-title">
                    <strong>{kindLabel(backup.kind)}</strong>
                    <span class="date num">{dateLabel(backup.createdAt)}</span>
                  </div>
                  <span class="row-facts num">
                    {t('backups.files', { count: formatNumber(backup.fileCount, app.locale) })}{#if backup.sizeBytes !== undefined} · {formatBytes(backup.sizeBytes, app.locale)}{/if} · {locationLabel(backup)}
                  </span>
                  <span class="row-pills">
                    {#if backup.legacy}
                      <span class="pill unverified" title={t('backups.legacyHelp')}><Icon name="alert-triangle" size={13} /> {t('backups.legacy')}</span>
                    {:else}
                      <span class:verified={backup.verified} class:unverified={!backup.verified} class="pill">
                        <Icon name={backup.verified ? 'check-circle' : 'alert-triangle'} size={13} />
                        {backup.verified ? t('backups.verified') : t('backups.unverified')}
                      </span>
                    {/if}
                    {#if needsForRecovery(backup)}<span class="pill unverified">{t('backups.neededForRecovery')}</span>{/if}
                    {#if lastCopies.has(backup.backupSetId)}<span class="pill pill-accent">{t('backups.onlyCopy')}</span>{/if}
                  </span>
                  <span class="row-actions">
                    <button type="button" class="btn btn-secondary btn-sm" disabled={actionBusy} onclick={() => openRestore(backup)}>
                      <Icon name="undo" size={15} /> {t('backups.restore')}
                    </button>
                    {#if admin}
                      <button type="button" class="btn btn-danger btn-sm" disabled={actionBusy || needsForRecovery(backup)}
                        aria-label={t('backups.deleteOne', { date: dateLabel(backup.createdAt) })}
                        title={needsForRecovery(backup) ? t('backups.neededForRecoveryHelp') : undefined}
                        onclick={() => askDelete(backup)}>
                        <Icon name="trash" size={15} /> {t('backups.delete')}
                      </button>
                    {/if}
                  </span>
                </div>
                <details class="row-details">
                  <summary>{t('backups.details')}</summary>
                  <code class="backup-id" title={backup.backupSetId}>{t('backups.id')}: {backup.backupSetId}</code>
                  {#if backup.externalTargets?.length}<p class="muted">{t('backups.externalCount', { count: backup.externalTargets.length })}</p>{/if}
                </details>
              </article>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</div>

{#if toDelete}
  {@const last = lastCopies.has(toDelete.backupSetId)}
  <Dialog showClose={false} tone="danger" title={t('backups.deleteTitle')} onClose={() => (toDelete = null)}>
    {#if last}
      <Callout tone="danger" title={t('backups.deleteLastTitle')} role="alert">
        <p>{t('backups.deleteLastBody')}</p>
      </Callout>
    {:else}
      <p>{t('backups.deleteBody')}</p>
    {/if}
    {#if toDelete.inWorldFolder}<p class="muted">{t('backups.deleteInWorld')}</p>{/if}
    <ul class="confirm-facts">
      <li><span>{t('backups.kindLabel')}</span><strong>{kindLabel(toDelete.kind)}</strong></li>
      <li><span>{t('backups.createdLabel')}</span><strong class="num">{dateLabel(toDelete.createdAt)}</strong></li>
      {#if toDelete.sizeBytes !== undefined}<li><span>{t('backups.sizeLabel')}</span><strong class="num">{formatBytes(toDelete.sizeBytes, app.locale)}</strong></li>{/if}
    </ul>
    {#if last}
      <label class="check understand"><input type="checkbox" bind:checked={understood} /><span class="label">{t('backups.deleteLastUnderstand')}</span></label>
    {/if}
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" data-autofocus onclick={() => (toDelete = null)}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-danger-solid" disabled={last && !understood} onclick={deleteSelected}>
        <Icon name="trash" size={17} /> {t('backups.delete')}
      </button>
    {/snippet}
  </Dialog>
{/if}

{#if confirmPrune}
  <Dialog showClose={false} tone="danger" title={t('backups.pruneTitle')} onClose={() => (confirmPrune = false)}>
    <p>{t('backups.pruneBody', { keep: formatNumber(keep, app.locale), count: formatNumber(plan.doomed.length, app.locale), size: formatBytes(freed, app.locale) })}</p>
    {#if plan.skipped.length}<p class="muted">{t('backups.pruneSkipped', { count: formatNumber(plan.skipped.length, app.locale) })}</p>{/if}
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" data-autofocus onclick={() => (confirmPrune = false)}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-danger-solid" onclick={pruneNow}>
        <Icon name="trash" size={17} /> {t('backups.pruneConfirm', { count: formatNumber(plan.doomed.length, app.locale) })}
      </button>
    {/snippet}
  </Dialog>
{/if}

{#if confirmRestore && selectedBackup}
  <Dialog showClose={false} title={t('backups.restoreTitle')} onClose={closeRestore}>
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
    {#if app.scan && app.draftCount > 0}<p class="muted">{t('backups.restoreClearsReview')}</p>{:else if app.scan}<p class="muted">{t('backups.restoreClearsScan')}</p>{/if}
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

  .world-context {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-5);
  }
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

  .list-heading { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-4); margin: var(--space-2) 0 var(--space-3); }
  .list-heading > .section-title { margin: 0; }
  .backup-list { display: grid; gap: var(--space-3); list-style: none; margin: 0; padding: 0; }
  .backup-list { gap: var(--space-2); }
  .backup-row { display: grid; gap: var(--space-1); padding: var(--space-2) var(--space-4); }
  .row-main { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2) var(--space-4); min-width: 0; }
  .backup-icon { width: 32px; height: 32px; }
  .row-title { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; flex: 1 1 220px; }
  .row-title strong { font-size: var(--text-md); }
  .date { color: var(--text-secondary); font-size: var(--text-sm); }
  .row-facts { color: var(--text-secondary); font-size: var(--text-sm); }
  .row-pills { display: inline-flex; flex-wrap: wrap; gap: var(--space-1); }
  .row-actions { display: inline-flex; gap: var(--space-2); margin-inline-start: auto; }
  .row-details summary { cursor: pointer; font-size: var(--text-xs); color: var(--text-secondary); }
  .row-details[open] { padding-block-end: var(--space-1); }
  .usage { margin: 0 0 var(--space-2); font-size: var(--text-sm); }
  .prune { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); margin-block-end: var(--space-3); font-size: var(--text-sm); }
  .prune .input { width: 80px; min-height: 30px; }
  .understand { margin-top: var(--space-2); }
  .pill.verified { background: var(--success-soft); color: var(--success-text); }
  .pill.unverified { background: var(--warning-soft); color: var(--warning-text); }

  .backup-id { min-width: 0; overflow-wrap: anywhere; color: var(--text-secondary); font-size: var(--text-xs); }

  .confirm-facts { display: grid; gap: var(--space-2); list-style: none; margin: 0; padding: var(--space-3) 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
  .confirm-facts li { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); overflow-wrap: anywhere; }
  .confirm-facts li > span { color: var(--text-secondary); font-size: var(--text-sm); }
  .confirm-facts li > strong, .confirm-facts li > code { min-width: 0; color: var(--text); text-align: end; overflow-wrap: anywhere; }

  @media (max-width: 640px) {
    .empty-state, .world-context { grid-template-columns: 1fr; align-items: start; }
    .empty-actions { justify-content: flex-start; }
    .context-icon, .empty-icon { width: 44px; height: 44px; }
    .world-context > .pill { justify-self: start; }
    .row-actions { margin-inline-start: 0; width: 100%; }
  }

  @media (max-width: 380px) {
    .empty-actions, .empty-actions .btn { width: 100%; }
    .empty-actions .btn { justify-content: center; }
    .world-context, .empty-state { padding-inline: var(--space-4); }
  }
</style>
