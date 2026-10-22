<script lang="ts">
  import { app } from '../lib/app.svelte';
  import type { InterruptedJob, RecoveryResult } from '../lib/api';
  import { hasMessage, t, type MessageKey } from '../lib/i18n/index.svelte';
  import { baseName, formatDate, formatNumber } from '../lib/format';
  import Callout from './Callout.svelte';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';
  import ProgressBar from './ProgressBar.svelte';

  // Work an earlier run left half done. It stays on the world screen until the person decides:
  // undo the changes (restore from the run's own backup) or keep the files as they are.
  let confirming = $state<InterruptedJob | null>(null);
  let acceptingFor = $state<InterruptedJob | null>(null);

  const jobs = $derived(app.interruptedJobs);
  const outcome = $derived(app.recoveryResult);
  const working = $derived(app.busy === 'recovery');
  const progress = $derived(app.progress);

  const kindKey = (job: InterruptedJob): MessageKey => `interrupted.kind.${job.kind}` as MessageKey;
  const stateKey = (result: RecoveryResult): MessageKey => (
    hasMessage(`interrupted.state.${result.state}`) ? `interrupted.state.${result.state}` : 'interrupted.state.partial'
  ) as MessageKey;
  // Undoing an unfinished resume is not something the person asked for in these words, so it is told in its own.
  const undoneResume = (result: RecoveryResult): boolean => result.state === 'rolled_back' && result.settledBy === 'unpublished_continuation';
  const titleKey = (result: RecoveryResult): MessageKey => (undoneResume(result) ? 'interrupted.unpublishedTitle' : stateKey(result));
  // Moving conflicting files into the quarantine folder can fail (full disk, no permission); say which, and that nothing was overwritten.
  const failureText = (code: string): string => (hasMessage(`error.${code}`) ? t(`error.${code}` as MessageKey) : '');
  const conflictKey = (code: string): MessageKey => (
    hasMessage(`interrupted.conflict.${code}`) ? `interrupted.conflict.${code}` : 'interrupted.conflict.UNREADABLE'
  ) as MessageKey;

  const stateText = (job: InterruptedJob): string => (
    job.state && hasMessage(`interrupted.jobState.${job.state}`) ? t(`interrupted.jobState.${job.state}` as MessageKey) : ''
  );

  // After RECOVERY_REQUIRED the blocking job is pointed at: scrolled into view and focused.
  $effect(() => {
    const id = app.highlightedJobId;
    if (!id) return;
    const heading = document.getElementById(`job-${id}`);
    heading?.scrollIntoView({ block: 'center' });
    heading?.focus();
  });

  async function accept(): Promise<void> {
    const job = acceptingFor;
    acceptingFor = null;
    if (job) await app.recover(job, 'keep', { acceptConflicts: true });
  }

  async function undo(): Promise<void> {
    const job = confirming;
    confirming = null;
    if (job) await app.recover(job, 'rollback');
  }
</script>

{#if jobs.length}
  <div class="interrupted">
    <!-- No dismiss button: the banner leaves when every job has been decided. -->
    <Callout tone="warning" title={t('interrupted.title', { count: jobs.length })} role="alert">
      <p>{t('interrupted.lead')}</p>
    </Callout>

    {#each jobs as job (job.jobId)}
      {@const mine = working && app.recoveryJobId === job.jobId}
      {@const partial = job.state === 'partial'}
      <section class="card panel" class:highlight={app.highlightedJobId === job.jobId} aria-labelledby={`job-${job.jobId}`}>
        <header>
          <h2 id={`job-${job.jobId}`} tabindex="-1">{t('interrupted.panelTitle', { kind: t(kindKey(job)) })}</h2>
          {#if job.needsAttention}<span class="pill pill-warning">{t('interrupted.needsAttention')}</span>{/if}
        </header>
        {#if stateText(job) || job.blocking}
          <p class="muted state">{stateText(job)}{#if job.blocking}{stateText(job) ? ' · ' : ''}{t('interrupted.blocking')}{/if}</p>
        {/if}
        <dl class="facts">
          <div><dt>{t('interrupted.world')}</dt><dd>{job.worldName || baseName(job.worldPath)}</dd></div>
          <div><dt>{t('interrupted.when')}</dt><dd class="num">{formatDate(job.createdAt, app.locale) || t('common.unknown')}</dd></div>
          <div><dt>{t('interrupted.verified')}</dt><dd class="num">{t('interrupted.counts', { done: formatNumber(job.unitsVerified, app.locale), total: formatNumber(job.unitsTotal, app.locale) })}</dd></div>
          <div><dt>{t('interrupted.unknown')}</dt><dd class="num" class:warn={job.unitsUnknown > 0}>{formatNumber(job.unitsUnknown, app.locale)}</dd></div>
        </dl>

        {#if mine}
          <div class="running">
            <ProgressBar label={t('interrupted.working')} value={progress.total ? progress.done : null} max={progress.total || 100} />
            <p class="muted num" role="status">{t('interrupted.working')}{progress.total ? ` ${formatNumber(progress.done, app.locale)} / ${formatNumber(progress.total, app.locale)}` : ''}</p>
          </div>
        {:else}
          <div class="choices">
            {#if partial}
              <div class="choice">
                <button type="button" class="btn btn-primary" disabled={app.isBusy} onclick={() => app.continueInterrupted(job)}>
                  <Icon name="refresh" size={16} /> {t('interrupted.continue')}
                </button>
                <p class="muted">{t('interrupted.continueHelp')}</p>
              </div>
            {/if}
            <div class="choice">
              <button type="button" class={partial ? 'btn btn-secondary' : 'btn btn-primary'} disabled={app.isBusy} onclick={() => (confirming = job)}>
                <Icon name="undo" size={16} /> {t(partial ? 'interrupted.rollbackRun' : 'interrupted.rollback')}
              </button>
              <p class="muted">{t('interrupted.rollbackHelp')}</p>
            </div>
            <div class="choice">
              <button type="button" class="btn btn-secondary" disabled={app.isBusy} onclick={() => app.recover(job, 'keep')}>
                <Icon name="check" size={16} /> {t(partial ? 'interrupted.keepWritten' : 'interrupted.keep')}
              </button>
              <p class="muted">{t('interrupted.keepHelp')}</p>
            </div>
          </div>
        {/if}
      </section>
    {/each}
  </div>
{/if}

{#if outcome}
  {@const result = outcome.result}
  <Callout tone={(result.state === 'rolled_back' || result.state === 'kept') && !result.errorCode ? 'success' : 'warning'} title={t(titleKey(result))} role="status">
    {#if undoneResume(result)}<p>{t('interrupted.unpublishedBody')}</p>{/if}
    {#if result.errorCode}<p>{t('interrupted.quarantineFailed')} {failureText(result.errorCode)}</p>{/if}
    <p class="num">{t('interrupted.result', { restored: formatNumber(result.restoredFiles, app.locale), kept: formatNumber(result.keptFiles, app.locale) })}</p>
    {#if result.conflicts.length}
      <p>{t('interrupted.conflicts', { count: formatNumber(result.conflicts.length, app.locale) })}</p>
      <p class="muted">{t('interrupted.conflictsUntouched')}</p>
      <ul class="conflicts">
        {#each result.conflicts as conflict, index (index)}
          <li><code>{conflict.path}</code> <span class="muted">— {t(conflictKey(conflict.code))}</span></li>
        {/each}
      </ul>
    {/if}
    {#snippet actions()}
      {#if result.quarantineDir}
        <button type="button" class="btn btn-secondary btn-sm" onclick={() => app.openFolder(result.quarantineDir ?? '')}>
          <Icon name="folder" size={14} /> {t('interrupted.openQuarantine')}
        </button>
      {/if}
      {#if result.state === 'recovery_conflict'}
        <button type="button" class="btn btn-secondary btn-sm" disabled={app.isBusy} onclick={() => (acceptingFor = outcome.job)}>{t('interrupted.accept')}</button>
      {/if}
      <button type="button" class="btn btn-quiet btn-sm" onclick={() => app.closeRecoveryResult()}>{t('common.close')}</button>
    {/snippet}
  </Callout>
{/if}

{#if confirming}
  <Dialog showClose={false} tone="danger" title={t('interrupted.confirmTitle')} onClose={() => (confirming = null)}>
    <p>{t('interrupted.confirmBody')}</p>
    <ul class="plain">
      <li>{t('interrupted.confirmBackup')}</li>
      <li>{t('interrupted.confirmConflicts')}</li>
    </ul>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" data-autofocus onclick={() => (confirming = null)}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-danger-solid" onclick={undo}><Icon name="undo" size={16} /> {t('interrupted.rollback')}</button>
    {/snippet}
  </Dialog>
{/if}

{#if acceptingFor}
  <Dialog showClose={false} tone="danger" title={t('interrupted.acceptTitle')} onClose={() => (acceptingFor = null)}>
    <p>{t('interrupted.acceptBody')}</p>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" data-autofocus onclick={() => (acceptingFor = null)}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-danger-solid" onclick={accept}>{t('interrupted.acceptConfirm')}</button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .highlight { outline: 2px solid var(--warning-border, var(--accent)); outline-offset: 2px; }
  .state { margin: 0; font-size: var(--text-sm); }
  .interrupted { display: grid; gap: var(--space-3); }
  .panel { display: grid; gap: var(--space-3); padding: var(--space-4); }
  header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
  header h2 { font-size: var(--text-lg); }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--space-3); margin: 0; }
  .facts dt { font-size: var(--text-xs); color: var(--text-secondary); font-weight: 600; }
  .facts dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
  .facts dd.warn { color: var(--warning-text); }
  .choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--space-4); }
  .choice { display: grid; gap: var(--space-2); align-content: start; justify-items: start; }
  .choice p { margin: 0; font-size: var(--text-sm); }
  .running { display: grid; gap: var(--space-2); }
  .conflicts { margin: var(--space-1) 0 0; padding-inline-start: 18px; overflow-wrap: anywhere; }
  .plain { margin: 0; padding-inline-start: 18px; }
</style>
