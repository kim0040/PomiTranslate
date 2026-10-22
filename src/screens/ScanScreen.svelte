<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import { formatNumber, formatDuration, baseName, middleEllipsis } from '../lib/format';
  import Icon from '../components/Icon.svelte';
  import Callout from '../components/Callout.svelte';
  import ProgressBar from '../components/ProgressBar.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import StatGrid from '../components/StatGrid.svelte';
  import Pill from '../components/Pill.svelte';
  import SetupNotice from '../components/SetupNotice.svelte';
  import { exportDocument } from '../lib/document-export';
  import { clock, holdClock } from '../lib/clock.svelte';
  import { warningText } from '../lib/failures';

  async function exportReport(): Promise<void> {
    try {
      if (await exportDocument('scan_report', app.scan)) app.notify(t('export.saved'), 'success');
    } catch (cause) { app.fail(cause); }
  }

  $effect(() => {
    if (app.busy !== 'scan') return;
    return holdClock();
  });
  const now = $derived(clock.now);

  const scanning = $derived(app.busy === 'scan');
  const scan = $derived(app.scan);
  const done = $derived(!!scan && scan.status === 'completed');
  const blockers = $derived(scan?.writeBlockers ?? []);
  const kinds = $derived(
    Object.entries(scan?.kinds ?? {}).sort((a, b) => b[1] - a[1])
  );
  const fileLabel = (file: string) => baseName(file);
  const coverage = $derived(scan?.coverage ?? []);
  const scanned = $derived(coverage.filter((item) => item.scanned));
  const notScanned = $derived(coverage.filter((item) => !item.scanned));
  const blockerLine = (code: string) => {
    const [kind, file] = code.split(': ');
    return file ? t('scan.blockedFile', { file: fileLabel(file) }) : (knownBlockers.includes(kind) ? t(`world.blocked.${kind}` as MessageKey) : t('world.blocked.unknown'));
  };
  const knownBlockers = ['bedrock', 'mcr', 'linear', 'world_in_use', 'not_writable', 'not_readable', 'missing'];
  const requestEstimate = $derived(app.estimate?.requests ?? scan?.estimate?.requests ?? scan?.requestEstimate);
</script>

<div class="page">
  <PageHeader title={t('scan.title')} lead={t('scan.lead')}>
    {#snippet actions()}
      {#if app.scan && !app.busy}
        <button type="button" class="btn btn-secondary btn-sm" title={t('export.reportHelp')} onclick={exportReport}><Icon name="download" size={14} /> {t('export.scan')}</button>
      {/if}
    {/snippet}
  </PageHeader>

  {#if scanning}
    <!-- Centred in the pane: for a job that can take minutes, the card is the whole screen. -->
    <section class="card working">
      <div class="row">
        <span class="work-icon" aria-hidden="true"><Icon name="search" size={20} /></span>
        <h2>{t('scan.running')}</h2>
        <span class="spacer"></span>
        <span class="muted num" role="timer" aria-live="off">{formatDuration((now - app.progress.startedAt) / 1000, app.locale)}</span>
      </div>
      <ProgressBar
        label={t('scan.running')}
        value={app.progress.fileTotal ? app.progress.fileIndex : null}
        max={app.progress.fileTotal || 100}
      />
      <p class="muted num">{app.progress.fileTotal ? t('scan.reading', { index: app.progress.fileIndex, total: app.progress.fileTotal }) : t('common.loading')}</p>
      <!-- Always one line tall, so the card does not change height when the first file name arrives. -->
      <p class="file mono truncate" title={app.progress.currentFile}>{app.progress.currentFile ? middleEllipsis(app.progress.currentFile, 60) : '\u00a0'}</p>
      <div><button type="button" class="btn btn-secondary" disabled={app.cancelling} onclick={() => app.cancel()}>{t('common.cancel')}</button></div>
    </section>
  {:else if !scan}
    {#if app.lastRestoreId}
      <Callout tone="info" title={t('restore.rescanTitle')} role="status">{t('restore.rescanBody')}</Callout>
    {/if}
    <section class="card start">
      <div class="ico" aria-hidden="true"><Icon name="search" size={22} /></div>
      <div class="copy">
        <h2>{app.worldDir ? baseName(app.worldDir) : t('world.title')}</h2>
        <ul class="promises">
          <li><Icon name="shield" size={18} /> {t('scan.startHint')}</li>
        </ul>
      </div>
      <button type="button" class="btn btn-primary btn-lg" disabled={!app.worldDir || !app.inspection?.validJavaWorld} onclick={() => app.startScan()}>
        {t('scan.run')}
      </button>
    </section>
    <SetupNotice />
  {:else}
    {#if scan.status !== 'completed' || blockers.length}
      <Callout tone="danger" title={t('scan.blocked')} role="alert">
        <ul class="plain">{#each blockers as code (code)}<li>{blockerLine(code)}</li>{/each}</ul>
        {#each scan.errors ?? [] as issue}<p>{issue.message}</p>{/each}
      </Callout>
    {/if}

    {#if done && !blockers.length}
      {#if scan.candidateCount === 0}
        <Callout tone="warning" title={t('scan.none')}>{t('scan.noneHelp')}</Callout>
      {:else}
        <StatGrid
          label={t('scan.found', { count: formatNumber(scan.candidateCount, app.locale) })}
          primary={{ value: formatNumber(scan.candidateCount, app.locale), label: t('scan.summary.texts') }}
          stats={[
            { value: formatNumber(scan.occurrenceCount ?? scan.candidateCount, app.locale), label: t('scan.summary.places') },
            { value: requestEstimate === undefined ? t('common.unknown') : formatNumber(requestEstimate, app.locale), label: t('scan.summary.requests') }
          ]}
        />

        {#if kinds.length}
          <section class="card kinds" aria-labelledby="kinds-title">
            <h2 id="kinds-title" class="section-title">{t('scan.summary.kinds')}</h2>
            <ul>
              {#each kinds as [kind, count] (kind)}
                <li><span class="kn">{t(`kind.${kind}` as MessageKey)}</span><span class="kc num">{formatNumber(count, app.locale)}</span></li>
              {/each}
            </ul>
          </section>
        {/if}
      {/if}
    {/if}

    {#if scan.warnings?.length}
      <Callout tone="warning" title={t('scan.warnings')}>
        <ul class="plain">
          {#each scan.warnings as warning}
            <li>{warningText(warning)}</li>
          {/each}
        </ul>
      </Callout>
    {/if}

    {#if coverage.length}
      <!-- Collapsed: the count says how much was left out, the list is there when it matters. -->
      <details class="card coverage">
        <summary>
          <h2 id="coverage-title" class="section-title">{t('coverage.title')}</h2>
          <span class="badges">
            <Pill tone="success" dot>{t('coverage.scanned')} <span class="num">{scanned.length}</span></Pill>
            {#if notScanned.length}<Pill tone="warning" dot>{t('coverage.notScanned')} <span class="num">{notScanned.length}</span></Pill>{/if}
          </span>
          <Icon name="chevron-down" size={16} />
        </summary>
        <p class="muted">{t('coverage.lead')}</p>
        <div class="cols">
          <div>
            <h3><span class="pill pill-success"><Icon name="check" size={12} /> {t('coverage.scanned')}</span></h3>
            <ul>
              {#each scanned as item (item.id)}<li><Icon name="check" size={14} /> <span>{t(`coverage.${item.id}` as MessageKey)}</span></li>{/each}
            </ul>
          </div>
          <div>
            <h3><span class="pill pill-warning"><Icon name="minus" size={12} /> {t('coverage.notScanned')}</span></h3>
            <ul>
              {#each notScanned as item (item.id)}
                <li>
                  <Icon name="minus" size={14} />
                  <span>
                    {t(`coverage.${item.id}` as MessageKey)}
                    {#if item.scopeOption}<span class="tag">{t('coverage.disabled')}</span>
                    {:else if item.present && item.count !== undefined}<span class="tag num">{t(item.id === 'datapacks' ? 'coverage.packCount' : 'common.files', { count: item.count })}</span>
                    {:else if item.present}<span class="tag">{t('coverage.detected')}</span>
                    {:else}<span class="tag absent">{t(item.id === 'external_resource_pack' ? 'settings.pack.externalEmpty' : 'coverage.absent')}</span>{/if}
                    {#if item.id === 'resource_pack' && item.present}<span class="tag">{t('coverage.enablePack')}</span>{/if}
                  </span>
                </li>
              {/each}
            </ul>
          </div>
        </div>
      </details>
    {/if}

    <div class="action-bar">
      <span class="note">{done && !blockers.length && scan.candidateCount > 0 ? t('scan.summary.repeats') : ''}</span>
      <div class="buttons">
        <button type="button" class="btn btn-secondary btn-lg" disabled={app.isBusy} onclick={() => app.startScan()}>
          <Icon name="refresh" size={15} /> {t('scan.again')}
        </button>
        {#if done && !blockers.length && scan.candidateCount > 0}
          <button type="button" class="btn btn-primary btn-lg" onclick={() => app.goStep('review')}>
            {t('scan.review')} <Icon name="chevron-right" size={16} />
          </button>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .working { padding: var(--space-5); display: grid; gap: var(--space-4); width: min(100%, 560px); margin-inline: auto; margin-block-start: clamp(0px, 6vh, 56px); }
  .working h2 { font-size: var(--text-lg); font-weight: 600; }
  .work-icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius-md); background: var(--accent-soft); color: var(--accent-text); }
  .file { margin: 0; font-size: var(--text-xs); color: var(--text-secondary); min-height: 1.4em; }
  .start { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: var(--space-4); padding: var(--space-4) var(--space-5); }
  .ico { display: grid; place-items: center; width: 44px; height: 44px; border-radius: var(--radius-lg); background: var(--accent-soft); color: var(--accent-text); }
  .copy h2 { font-size: var(--text-xl); font-weight: 600; overflow-wrap: anywhere; }
  .promises { list-style: none; margin: var(--space-2) 0 0; padding: 0; color: var(--text-secondary); font-size: var(--text-sm); }
  .promises li { display: flex; gap: var(--space-2); align-items: flex-start; }
  .promises :global(.icon) { margin-top: 2px; color: var(--success-text); }
  .kinds { padding: var(--space-4) var(--space-5); }
  .kinds ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0 var(--space-6); }
  .kinds li { display: flex; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) 0; border-bottom: 1px solid var(--border); }
  .kc { font-weight: 600; }
  .coverage { padding: 0; }
  .coverage > :not(summary) { margin-inline: var(--space-5); }
  .coverage > summary { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-5); list-style: none; cursor: default; border-radius: var(--radius-xl); }
  .coverage > summary::-webkit-details-marker { display: none; }
  .coverage > summary .section-title { margin: 0; }
  .coverage > summary :global(.icon) { margin-inline-start: auto; color: var(--text-secondary); transition: rotate var(--dur-base) var(--ease); }
  .coverage[open] > summary :global(.icon) { rotate: 180deg; }
  .badges { display: inline-flex; gap: var(--space-3); flex-wrap: wrap; }
  .cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-5); margin-block: var(--space-3) var(--space-5); }
  .cols h3 { margin-bottom: var(--space-3); }
  .cols ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); font-size: var(--text-sm); }
  .cols li { display: flex; gap: var(--space-2); align-items: flex-start; }
  .cols li > :global(.icon) { margin-top: 2px; color: var(--text-secondary); flex: none; }
  .tag { display: inline-block; margin-inline-start: var(--space-2); padding: 1px 8px; border-radius: var(--radius-full); background: var(--bg-sunken); color: var(--text-secondary); font-size: var(--text-xs); font-weight: 600; }
  .plain { margin: 0; padding-inline-start: 18px; }
  @media (max-width: 800px) { .cols { grid-template-columns: 1fr; } .start { grid-template-columns: 1fr; } }
</style>
