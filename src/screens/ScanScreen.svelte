<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import { formatNumber, formatDuration, formatDate, formatRequestEstimate, baseName } from '../lib/format';
  import Icon from '../components/Icon.svelte';
  import Callout from '../components/Callout.svelte';
  import ProgressBar from '../components/ProgressBar.svelte';
  import SetupNotice from '../components/SetupNotice.svelte';
  import { exportDocument } from '../lib/document-export';

  async function exportReport(): Promise<void> {
    try {
      if (await exportDocument('scan_report', app.scan)) app.notify(t('export.saved'), 'success');
    } catch (cause) { app.fail(cause); }
  }

  let now = $state(Date.now());
  $effect(() => {
    if (app.busy !== 'scan') return;
    const timer = setInterval(() => { now = Date.now(); }, 500);
    return () => clearInterval(timer);
  });

  const scanning = $derived(app.busy === 'scan');
  const scan = $derived(app.scan);
  const done = $derived(!!scan && scan.status === 'completed');
  const blockers = $derived(scan?.writeBlockers ?? []);
  const kinds = $derived(
    Object.entries(scan?.kinds ?? {}).sort((a, b) => b[1] - a[1])
  );
  const fileLabel = (file: string) => baseName(file);
  const warnText = (w: { code: string; file?: string; count?: number }) => {
    const key = `scan.warn.${w.code}` as MessageKey;
    return t(key, { file: w.file ?? '', count: w.count ?? 0 });
  };
  const knownWarnings = ['chunk_unreadable', 'file_unwritable', 'file_unreadable', 'command_unparsed'];
  const coverage = $derived(scan?.coverage ?? []);
  const scanned = $derived(coverage.filter((item) => item.scanned));
  const notScanned = $derived(coverage.filter((item) => !item.scanned));
  const blockerLine = (code: string) => {
    const [kind, file] = code.split(': ');
    return file ? t('scan.blockedFile', { file: fileLabel(file) }) : (knownBlockers.includes(kind) ? t(`world.blocked.${kind}` as MessageKey) : t('world.blocked.unknown'));
  };
  const knownBlockers = ['bedrock', 'mcr', 'linear', 'world_in_use', 'not_writable', 'not_readable', 'missing'];
  const requestEstimate = $derived(app.estimate?.requests ?? scan?.estimate?.requests ?? scan?.requestEstimate);
  const requestEstimateObject = $derived(app.estimate ?? scan?.estimate ?? (requestEstimate === undefined ? undefined : { requests: requestEstimate }));
  const lastScanDate = $derived(app.lastScan?.at
    ? formatDate(new Date(app.lastScan.at * 1000).toISOString(), app.locale)
    : t('common.unknown'));
  const lastJobDate = $derived(app.lastJob?.at ? formatDate(new Date(app.lastJob.at * 1000).toISOString(), app.locale) : t('common.unknown'));
  const lastJobStatus = $derived(app.lastJob?.status === 'completed' ? t('scan.home.status.completed')
    : app.lastJob?.status === 'partial' ? t('scan.home.status.partial')
    : app.lastJob?.status === 'cancelled' ? t('scan.home.status.cancelled')
    : t('scan.home.status.failed'));
</script>

<div class="page">
  <header class="page-head" class:with-actions={!!app.scan && !app.busy}>
    <h1>{t('scan.title')}</h1>
    <p class="lead">{t('scan.lead')}</p>
    {#if app.scan && !app.busy}
      <div class="actions"><button type="button" class="btn btn-secondary btn-sm" title={t('export.reportHelp')} onclick={exportReport}><Icon name="download" size={14} /> {t('export.scan')}</button></div>
    {/if}
  </header>

  {#if !scanning && app.worldDir && (!scan || app.resume?.available)}
    <section class="home-summary card" aria-label={t('scan.home.title')}>
      <div class="home-summary-head">
        <span class="ico" aria-hidden="true"><Icon name="clock" size={20} /></span>
        <h2>{t('scan.home.title')}</h2>
      </div>
      <dl class="home-facts">
        <div><dt>{t('scan.home.lastScan')}</dt><dd>{lastScanDate}</dd></div>
        <div><dt>{t('scan.home.candidates')}</dt><dd class="num">{app.lastScan ? formatNumber(app.lastScan.candidateCount, app.locale) : t('common.unknown')}</dd></div>
        {#if app.lastJob}
          <div><dt>{t('scan.home.lastTranslation')}</dt><dd>{lastJobDate} · {lastJobStatus} · {t('scan.home.jobCounts', { translated: formatNumber(app.lastJob.translated, app.locale), failed: formatNumber(app.lastJob.failed, app.locale) })}</dd></div>
        {:else}
          <div><dt>{t('scan.home.lastTranslation')}</dt><dd class="muted">{t('scan.home.noTranslation')}</dd></div>
        {/if}
      </dl>
    </section>
  {/if}

  {#if !scanning && app.resume?.available}
    <section class="resume-card card" aria-labelledby="resume-home-title">
      <div><p class="eyebrow">{t('world.resumeFound')}</p><h2 id="resume-home-title">{t('scan.home.resumeTitle')}</h2><p class="muted">{t('scan.home.resumeBody', { count: formatNumber(app.resume.translatedCount ?? 0, app.locale) })}</p></div>
      <button type="button" class="btn btn-primary" onclick={() => app.goStep('run')}>{t('scan.home.resume')} <Icon name="chevron-right" size={15} /></button>
    </section>
  {/if}

  {#if scanning}
    <section class="card working" aria-live="polite">
      <div class="row">
        <Icon name="search" size={22} />
        <h2>{t('scan.running')}</h2>
        <span class="spacer"></span>
        <span class="muted num">{formatDuration((now - app.progress.startedAt) / 1000, app.locale)}</span>
      </div>
      <ProgressBar
        label={t('scan.running')}
        value={app.progress.fileTotal ? app.progress.fileIndex : null}
        max={app.progress.fileTotal || 100}
      />
      <p class="muted num">{app.progress.fileTotal ? t('scan.reading', { index: app.progress.fileIndex, total: app.progress.fileTotal }) : t('common.loading')}</p>
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
          <li><Icon name="shield" size={18} /> {t('scan.startExplain')}</li>
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
        <section class="summary card" aria-label={t('scan.found', { count: formatNumber(scan.candidateCount, app.locale) })}>
          <div class="stat"><span class="v num">{formatNumber(scan.candidateCount, app.locale)}</span><span class="l">{t('scan.summary.texts')}</span></div>
          <div class="stat"><span class="v num">{formatNumber(scan.occurrenceCount ?? scan.candidateCount, app.locale)}</span><span class="l">{t('scan.summary.places')}</span></div>
          <div class="stat"><span class="v num">{requestEstimate === undefined ? t('common.unknown') : formatRequestEstimate(requestEstimateObject, app.locale)}</span><span class="l">{t('scan.summary.requests')}</span></div>
        </section>

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
            <li>{knownWarnings.includes(warning.code) ? warnText(warning) : (warning.message ?? t('scan.warn.unknown'))}</li>
          {/each}
        </ul>
      </Callout>
    {/if}

    {#if coverage.length}
      <section class="card coverage" aria-labelledby="coverage-title">
        <h2 id="coverage-title" class="section-title">{t('coverage.title')}</h2>
        <p class="muted">{t('coverage.lead')}</p>
        <div class="cols">
          <div>
            <h3><span class="pill pill-success"><Icon name="check" size={12} /> {t('coverage.scanned')}</span></h3>
            <ul>
              {#each scanned as item (item.id)}<li>{t(`coverage.${item.id}` as MessageKey)}</li>{/each}
            </ul>
          </div>
          <div>
            <h3><span class="pill pill-warning"><Icon name="minus" size={12} /> {t('coverage.notScanned')}</span></h3>
            <ul>
              {#each notScanned as item (item.id)}
                <li>
                  {t(`coverage.${item.id}` as MessageKey)}
                  {#if item.scopeOption}<span class="tag">{t('coverage.disabled')}</span>
                  {:else if item.present && item.count !== undefined}<span class="tag num">{t(item.id === 'datapacks' ? 'coverage.packCount' : 'common.files', { count: item.count })}</span>
                  {:else if item.present}<span class="tag">{t('coverage.detected')}</span>
                  {:else}<span class="tag absent">{t(item.id === 'external_resource_pack' ? 'settings.pack.externalEmpty' : 'coverage.absent')}</span>{/if}
                  {#if item.id === 'resource_pack' && item.present}<span class="tag">{t('coverage.enablePack')}</span>{/if}
                </li>
              {/each}
            </ul>
          </div>
        </div>
      </section>
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
  .working { padding: var(--space-4) var(--space-5); display: grid; gap: var(--space-4); }
  .working h2 { font-size: var(--text-lg); }
  .home-summary { display: grid; grid-template-columns: minmax(180px, 0.7fr) minmax(0, 1.3fr); align-items: center; gap: var(--space-4); padding: var(--space-3) var(--space-4); }
  .home-summary-head { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
  .home-summary-head h2, .resume-card h2 { font-size: var(--text-md); }
  .home-summary .ico { width: 36px; height: 36px; }
  .home-facts { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-5); margin: 0; }
  .home-facts div { min-width: 110px; }
  .home-facts dt { color: var(--text-secondary); font-size: var(--text-xs); }
  .home-facts dd { margin: 1px 0 0; font-size: var(--text-sm); font-weight: 600; }
  .resume-card { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); padding: var(--space-3) var(--space-4); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: var(--accent-soft); }
  .resume-card .eyebrow { color: var(--accent-soft-text); font-size: var(--text-xs); font-weight: 700; }
  .resume-card h2 { margin-top: 2px; color: var(--text); }
  .resume-card p { margin-top: 2px; font-size: var(--text-sm); }
  .start { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: var(--space-4); padding: var(--space-4) var(--space-5); }
  .ico { display: grid; place-items: center; width: 44px; height: 44px; border-radius: var(--radius-lg); background: var(--accent-soft); color: var(--accent-soft-text); }
  .copy h2 { font-size: var(--text-xl); overflow-wrap: anywhere; }
  .promises { list-style: none; margin: var(--space-2) 0 0; padding: 0; color: var(--text-secondary); font-size: var(--text-sm); }
  .promises li { display: flex; gap: var(--space-2); align-items: flex-start; }
  .promises :global(.icon) { margin-top: 2px; color: var(--success-solid); }
  .summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); overflow: hidden; }
  .stat { padding: var(--space-3) var(--space-4); display: grid; gap: 2px; border-inline-start: 1px solid var(--border); margin-inline-start: -1px; }
  .stat .v { font-size: var(--text-2xl); font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; }
  .stat .l { font-size: var(--text-sm); color: var(--text-secondary); }
  .kinds { padding: var(--space-4) var(--space-5); }
  .kinds ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--space-2) var(--space-5); }
  .kinds li { display: flex; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) 0; border-bottom: 1px solid var(--border); }
  .kc { font-weight: 600; }
  .coverage { padding: var(--space-4) var(--space-5); display: grid; gap: var(--space-3); }
  .coverage .section-title { margin: 0; }
  .cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-5); margin-top: var(--space-2); }
  .cols h3 { margin-bottom: var(--space-3); }
  .cols ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-3); font-size: var(--text-sm); }
  .tag { display: inline-block; margin-inline-start: var(--space-2); padding: 1px 8px; border-radius: var(--radius-full); background: var(--bg-sunken); color: var(--text-secondary); font-size: var(--text-xs); font-weight: 600; }
  .plain { margin: 0; padding-inline-start: 18px; }
  @media (max-width: 800px) { .cols { grid-template-columns: 1fr; } .start { grid-template-columns: 1fr; } .home-summary { grid-template-columns: 1fr; } }
  @media (max-width: 540px) { .resume-card { align-items: flex-start; flex-direction: column; } }
</style>
