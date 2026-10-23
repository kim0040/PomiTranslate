<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { app } from '../lib/app.svelte';
  import type { BackupSummary } from '../lib/api';
  import { t } from '../lib/i18n/index.svelte';
  import { baseName, formatBytes, formatDate, formatNumber, middleEllipsis } from '../lib/format';
  import Callout from '../components/Callout.svelte';
  import Dialog from '../components/Dialog.svelte';
  import Icon from '../components/Icon.svelte';
  import ProgressBar from '../components/ProgressBar.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import StatusScreen from '../components/StatusScreen.svelte';
  import ListRow from '../components/ListRow.svelte';
  import Pill from '../components/Pill.svelte';
  import { lastCopyIds, needsForRecovery, prunePlan } from '../lib/backups';

  let selectedBackup = $state<BackupSummary | null>(null);
  let confirmRestore = $state(false);
  // Rows whose id line is open: it is one click away instead of a third line on every row.
  const expanded = new SvelteSet<string>();
  function toggleDetails(id: string): void {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
  }

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

  function factsText(backup: BackupSummary): string {
    const parts = [t('backups.files', { count: formatNumber(backup.fileCount, app.locale) })];
    if (backup.sizeBytes !== undefined) parts.push(formatBytes(backup.sizeBytes, app.locale));
    parts.push(locationLabel(backup));
    return parts.join(' · ');
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
  <PageHeader title={t('backups.title')} lead={t('backups.lead')} />

  {#if !hasWorld}
    <StatusScreen icon="archive" title={t('backups.noWorld')}>
      <p>{t('backups.noWorldHelp')}</p>
      {#snippet actions()}
        <button type="button" class="btn btn-primary" disabled={actionBusy} onclick={() => app.chooseWorld()}>
          <Icon name="folder" size={16} /> {t('backups.pickWorld')}
        </button>
        <button type="button" class="btn btn-secondary" onclick={() => app.goto('workspace')}>
          {t('nav.workspace')}
        </button>
      {/snippet}
    </StatusScreen>
  {:else}
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

    <section class="card list-card" aria-labelledby="backup-list-title">
      <!-- The world and its backups are one thing: the heading names the world, the rows below are its backups. -->
      <header class="list-head">
        <span class="thumb" aria-hidden="true"><Icon name="folder" size={20} /></span>
        <div class="who">
          <h2 id="backup-list-title" class="name truncate" title={worldName}>{worldName}</h2>
          <p class="path mono truncate" title={app.worldDir}>{middleEllipsis(app.worldDir, 64)}</p>
        </div>
        <Pill tone="accent"><span class="num">{t('world.backupsCount', { count: formatNumber(backups.length, app.locale) })}</span></Pill>
      </header>
      {#if backups.length && (app.backupUsage || (admin && appSets.length > 1))}
        <div class="list-tools">
          {#if app.backupUsage}
            <p class="muted num">{t('backups.usage', {
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
        </div>
      {/if}
      {#if backups.length}
        <ul class="rows backup-list">
          {#each backups as backup (backup.backupSetId)}
            <ListRow>
              {#snippet leading()}<Icon name={backup.kind === 'recovery' ? 'undo' : 'archive'} size={16} />{/snippet}
              <div class="stack">
                <span class="title"><strong class="kind">{kindLabel(backup.kind)}</strong> <span class="date num">{dateLabel(backup.createdAt)}</span></span>
                <span class="row-facts num">{factsText(backup)}<button type="button" class="more" aria-expanded={expanded.has(backup.backupSetId)} aria-controls={`backup-more-${backup.backupSetId}`} onclick={() => toggleDetails(backup.backupSetId)}>{t('backups.details')}</button></span>
                {#if expanded.has(backup.backupSetId)}
                  <span id={`backup-more-${backup.backupSetId}`} class="more-body">
                    <code class="backup-id" title={backup.backupSetId}>{t('backups.id')}: {backup.backupSetId}</code>
                    {#if backup.externalTargets?.length}<span class="muted">{t('backups.externalCount', { count: backup.externalTargets.length })}</span>{/if}
                  </span>
                {/if}
              </div>
              {#snippet trailing()}
                <span class="row-pills">
                  {#if backup.legacy}
                    <span title={t('backups.legacyHelp')}><Pill tone="warning" dot>{t('backups.legacy')}</Pill></span>
                  {:else if backup.verified}
                    <Pill tone="success" dot>{t('backups.verified')}</Pill>
                  {:else}
                    <Pill tone="warning" dot>{t('backups.unverified')}</Pill>
                  {/if}
                  {#if needsForRecovery(backup)}<Pill tone="warning">{t('backups.neededForRecovery')}</Pill>{/if}
                  {#if lastCopies.has(backup.backupSetId)}<Pill tone="accent">{t('backups.onlyCopy')}</Pill>{/if}
                </span>
                <button type="button" class="btn btn-secondary btn-sm" disabled={actionBusy} onclick={() => openRestore(backup)}>
                  <Icon name="undo" size={15} /> {t('backups.restore')}
                </button>
                {#if admin}
                  <button type="button" class="btn btn-quiet btn-sm delete" disabled={actionBusy || needsForRecovery(backup)}
                    aria-label={t('backups.deleteOne', { date: dateLabel(backup.createdAt) })}
                    title={needsForRecovery(backup) ? t('backups.neededForRecoveryHelp') : undefined}
                    onclick={() => askDelete(backup)}>
                    <Icon name="trash" size={15} /> {t('backups.delete')}
                  </button>
                {/if}
              {/snippet}
            </ListRow>
          {/each}
        </ul>
      {/if}
    </section>

    {#if backups.length === 0}
      <StatusScreen icon="archive" title={t('backups.empty')}>
        <p>{t('backups.emptyHelp')}</p>
        {#snippet actions()}
          <button type="button" class="btn btn-secondary" disabled={actionBusy} onclick={() => app.goto('workspace')}>
            {t('nav.workspace')} <Icon name="chevron-right" size={16} />
          </button>
        {/snippet}
      </StatusScreen>
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
  .restoring { display: grid; gap: var(--space-3); padding: var(--space-4) var(--space-5); border-color: var(--accent); }
  .restoring-head { display: flex; align-items: center; gap: var(--space-2); color: var(--accent-text); }
  .restoring-head :global(.icon) { animation: pomi-spin 0.9s linear infinite; }
  .restoring p { font-size: var(--text-sm); }

  .list-card { padding: 0; overflow: hidden; }
  .list-head { display: flex; align-items: center; gap: var(--space-3); min-width: 0; padding: var(--space-3) var(--space-4); }
  .thumb { flex: none; display: grid; place-items: center; width: 36px; height: 36px; border-radius: var(--radius-lg); background: var(--accent-soft); color: var(--accent-text); }
  .who { min-width: 0; flex: 1; }
  .name { font-size: var(--text-lg); font-weight: 600; }
  .path { margin: 0; font-size: var(--text-xs); color: var(--text-secondary); }
  .list-tools { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-2) var(--space-4); padding: var(--space-2) var(--space-4); border-top: 1px solid var(--border); background: var(--bg-sunken); }
  .list-tools > p { margin: 0; font-size: var(--text-sm); }
  .rows { margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--border); }
  .rows > :global(li + li) { border-top: 1px solid var(--border); }
  .stack { display: grid; gap: 1px; min-width: 0; }
  .title { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 var(--space-3); }
  .kind { font-weight: 600; }
  .date { color: var(--text-secondary); font-size: var(--text-sm); }
  .row-facts { color: var(--text-secondary); font-size: var(--text-sm); }
  .row-pills { display: inline-flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
  .delete { color: var(--danger-text); }
  @media (hover: hover) { .delete:hover:not(:disabled) { background: var(--danger-soft); color: var(--danger-text); } }
  .more { margin-inline-start: var(--space-2); padding: 0; border: 0; background: none; color: var(--accent-text); font: inherit; font-size: var(--text-xs); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
  .more-body { display: flex; flex-wrap: wrap; gap: 0 var(--space-3); padding-block: 2px; }
  .prune { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); font-size: var(--text-sm); }
  .prune .input { width: 80px; min-height: 30px; }
  .understand { margin-top: var(--space-2); }

  .backup-id { min-width: 0; overflow-wrap: anywhere; color: var(--text-secondary); font-size: var(--text-xs); }

  .confirm-facts { display: grid; gap: var(--space-2); list-style: none; margin: 0; padding: var(--space-3) 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
  .confirm-facts li { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); overflow-wrap: anywhere; }
  .confirm-facts li > span { color: var(--text-secondary); font-size: var(--text-sm); }
  .confirm-facts li > strong, .confirm-facts li > code { min-width: 0; color: var(--text); text-align: end; overflow-wrap: anywhere; }
</style>
