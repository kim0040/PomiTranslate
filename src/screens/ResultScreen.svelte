<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { t, hasMessage, type MessageKey } from '../lib/i18n/index.svelte';
  import { formatNumber, formatCompact, formatUsd } from '../lib/format';
  import Icon, { type IconName } from '../components/Icon.svelte';
  import Callout from '../components/Callout.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import StatGrid, { type Stat } from '../components/StatGrid.svelte';
  import { resultPresentation } from '../lib/workflow';
  import { exportDocument } from '../lib/document-export';
  import { failureKey, failureSummary, warningText } from '../lib/failures';
  import QualityReport from '../components/QualityReport.svelte';

  async function exportReport(): Promise<void> {
    try {
      if (await exportDocument('translation_report', result)) app.notify(t('export.saved'), 'success');
    } catch (cause) { app.fail(cause); }
  }

  const result = $derived(app.result);
  const status = $derived(result?.status ?? 'failed');
  const presentation = $derived(resultPresentation(status));
  const tone = $derived(presentation.tone);
  const titleKey = $derived(`result.${presentation.status}` as MessageKey);
  const bodyKey = $derived(`result.${presentation.status}Body` as MessageKey);
  const resumable = $derived(!!app.resume && app.isResumeStatus(status));
  // Nothing was written and no saved progress is left to continue.
  const noSavedProgress = $derived(!resumable && !(result?.changedFileCount ?? 0));
  const body = $derived(
    presentation.status === 'completed' ? t('result.completedBody', { files: formatNumber(result?.changedFileCount ?? 0, app.locale) })
      // Nothing was written, so there is nothing to check or restore.
      : presentation.status === 'failed' && !result?.changedFileCount ? t('result.failedBodyUnchanged')
      // These two bodies promise that the saved sentences are continued; with no saved progress that would be untrue.
      : noSavedProgress && ['needs_retry', 'cancelled'].includes(presentation.status) ? t('result.noSavedProgress')
      : t(bodyKey)
  );
  const stats = $derived(result?.translation ?? {});
  const firstError = $derived(result?.errors?.[0]);
  // The core's own message is for the exported report; the screen shows text from the catalog.
  const reason = $derived.by(() => {
    if (!firstError) return '';
    const code = firstError.code ?? '';
    for (const key of [`result.errorCode.${code}`, `error.${code}`]) if (code && hasMessage(key)) return t(key as MessageKey);
    return t('result.errorCode.default');
  });
  const failureRows = $derived(failureSummary(result?.translationFailureCodes));
  const showReason = $derived(presentation.showReason);
  // Nothing written and the scan still on screen: the same reviewed scan can simply be run again.
  const canTranslateAgain = $derived(
    !resumable && !!app.scan && ['failed', 'needs_retry', 'cancelled', 'locked'].includes(status) && !(result?.changedFileCount ?? 0)
  );
  // What the screen says to do next, matching the main button: continue the saved sentences, or
  // translate again from the scan that is still on screen.
  const nextHint = $derived.by(() => {
    if (primary === 'retry' && presentation.status === 'failed') return t('result.resumeHint', { count: formatNumber(app.resume?.translatedCount ?? 0, app.locale) });
    if (primary === 'again') return t('result.againHint');
    return '';
  });
  const usage = $derived(result?.usage);
  // One number leads (what the provider returned); the rest sit quietly beside it, with the same
  // labels on every status so a slot never changes meaning between screens. The leading label says
  // whether those sentences reached the world: "applied" counts files written into it.
  const num = (value: number) => formatNumber(value, app.locale);
  const primaryLabel = $derived(
    status === 'completed' ? t('result.stat.applied')
      : (result?.changedFileCount ?? 0) > 0 ? t('result.stat.partlyApplied')
      : t('result.stat.preparedOnly')
  );
  const primaryStat = $derived<Stat>({ label: primaryLabel, value: num(stats.translated ?? 0), tone: status === 'completed' ? 'success' : 'default' });
  const otherStats = $derived<Stat[]>([
    { label: t('result.stat.unchanged'), value: num(stats.unchanged ?? 0) },
    { label: t('result.stat.failed'), value: num(stats.failed ?? 0), tone: (stats.failed ?? 0) > 0 ? 'danger' : 'default' },
    { label: t('result.stat.kept'), value: num(stats.kept_original ?? 0), tone: (stats.kept_original ?? 0) > 0 ? 'warning' : 'default' },
    { label: t('result.stat.filesApplied'), value: num(result?.changedFileCount ?? 0), tone: (result?.changedFileCount ?? 0) > 0 ? 'success' : 'default' },
    { label: t('result.stat.requests'), value: num(result?.providerRequests ?? 0) }
  ]);
  // Nothing was written: say that first and keep the surface calm; only the icon is red.
  const unchanged = $derived(presentation.status === 'failed' && !result?.changedFileCount);
  const heroTitle = $derived(unchanged ? t('result.unchangedTitle') : t(titleKey));
  const heroBody = $derived(unchanged ? t('result.failedShort') : body);
  const heroIcon = $derived<IconName>(tone === 'success' ? 'check-circle' : tone === 'danger' ? 'alert-circle' : tone === 'warning' ? 'alert-triangle' : 'info');
  // One primary next step; the rest are quiet.
  const primary = $derived<'interrupted' | 'retry' | 'again' | 'folder' | ''>(
    firstError?.code === 'RECOVERY_REQUIRED' ? 'interrupted'
      : resumable ? 'retry'
      : canTranslateAgain ? 'again'
      : status === 'completed' && app.worldDir ? 'folder'
      : ''
  );
  const adapted = $derived(result?.usage?.adapted_parameters?.filter((name) => typeof name === 'string' && name) ?? []);
</script>

<div class="page">
  <PageHeader title={t('result.title')}>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary btn-sm" title={t('export.reportHelp')} disabled={!!app.busy} onclick={exportReport}><Icon name="download" size={14} /> {t('export.report')}</button>
    {/snippet}
  </PageHeader>

  {#if result}
    <section class="card hero {tone}" class:unchanged role="status">
      <span class="hero-icon" aria-hidden="true"><Icon name={heroIcon} size={24} /></span>
      <div class="hero-text">
        <h2>{heroTitle}</h2>
        <p>{heroBody}{#if showReason && reason}<br />{reason}{/if}{#if status === 'completed'}<br />{t('result.completedNext')}{/if}{#if nextHint}<br />{nextHint}{/if}</p>
      </div>
      <div class="hero-actions">
        {#if primary === 'interrupted'}
          <button type="button" class="btn btn-primary btn-lg" disabled={app.isBusy} onclick={() => app.openInterrupted()}>{t('result.toInterrupted')}</button>
        {:else if primary === 'retry'}
          <button type="button" class="btn btn-primary btn-lg" disabled={app.isBusy} onclick={() => app.startTranslate({ resume: true })}><Icon name="refresh" size={16} /> {t('result.retry')}</button>
        {:else if primary === 'again'}
          <button type="button" class="btn btn-primary btn-lg" disabled={app.isBusy} onclick={() => app.translateAgain()}><Icon name="refresh" size={16} /> {t('result.again')}</button>
        {:else if primary === 'folder'}
          <button type="button" class="btn btn-primary btn-lg" onclick={() => app.openFolder(app.worldDir)}><Icon name="folder" size={16} /> {t('result.openFolder')}</button>
        {/if}
        {#if status === 'invalidated' || status === 'partial' || (!resumable && status !== 'completed')}
          <button type="button" class="btn {primary ? 'btn-quiet' : 'btn-secondary'}" disabled={app.isBusy} onclick={() => app.goStep('scan')}>{t('result.retryAll')}</button>
        {/if}
        {#if result.backupSetId}
          <button type="button" class="btn btn-quiet" onclick={() => app.goto('backups')}><Icon name="archive" size={16} /> {t('result.toBackups')}</button>
        {/if}
        {#if status === 'completed'}
          <button type="button" class="btn btn-quiet" onclick={() => { app.goto('workspace'); app.goStep('world'); }}>{t('result.newRun')}</button>
        {/if}
      </div>
    </section>

    <StatGrid label={t('result.title')} primary={primaryStat} stats={otherStats} />
    <p class="muted stat-help">{t('result.stat.help')}</p>
    {#if (usage && (usage.prompt_tokens || usage.completion_tokens)) || usage?.cost_reported}
      <dl class="group usage">
        {#if usage && (usage.prompt_tokens || usage.completion_tokens)}
          <div class="row-item"><dt class="k">{t('result.stat.tokens')}</dt><dd class="v num">{t('result.tokensValue', { input: formatCompact(usage.prompt_tokens ?? 0, app.locale), output: formatCompact(usage.completion_tokens ?? 0, app.locale) })}</dd></div>
        {/if}
        {#if usage?.cost_reported}
          <div class="row-item"><dt class="k">{t('result.stat.cost')}</dt><dd class="v num">{t('result.costValue', { cost: formatUsd(usage.cost ?? 0, app.locale) })}</dd></div>
        {/if}
      </dl>
    {/if}
    {#if adapted.length}<p class="muted quiet-note">{t('result.adapted', { params: adapted.join(', ') })}</p>{/if}

    {#if result.warnings?.length}
      <Callout tone="warning" title={t('result.warnings')}>
        <ul class="plain">
          {#each result.warnings as warning}
            <li>{warningText(warning)}</li>
          {/each}
        </ul>
      </Callout>
    {/if}

    <QualityReport counts={result.translationWarnings} samples={result.translationWarningSamples} />

    {#if result.translationSamples?.length}
      <section class="card samples" aria-labelledby="samples-title">
        <h2 id="samples-title">{t('result.samples')}</h2>
        <p class="muted">{t('result.samplesLead')}</p>
        <table>
          <thead><tr><th scope="col">{t('result.before')}</th><th scope="col">{t('result.after')}</th></tr></thead>
          <tbody>
            {#each result.translationSamples as sample (sample.source)}
              <tr><td lang="en">{sample.source}</td><td>{sample.translated}</td></tr>
            {/each}
          </tbody>
        </table>
      </section>
    {/if}

    {#if failureRows.length}
      <section class="card samples" aria-labelledby="fail-summary-title">
        <h2 id="fail-summary-title">{t('result.failureSummary')}</h2>
        <ul class="lines">
          {#each failureRows as row (row.code)}<li><strong class="num">{formatNumber(row.count, app.locale)}</strong><span>{t(failureKey(row.code))}</span></li>{/each}
        </ul>
      </section>
    {/if}

    {#if result.translationFailures?.length}
      <section class="card samples" aria-labelledby="fail-title">
        <h2 id="fail-title">{t('result.failures')}</h2>
        {#if (stats.failed ?? 0) > result.translationFailures.length}
          <p class="muted">{t('result.failuresShown', { total: formatNumber(stats.failed ?? 0, app.locale), shown: formatNumber(result.translationFailures.length, app.locale) })}</p>
        {/if}
        <ul class="lines">
          {#each result.translationFailures as item, index (index)}<li><strong>{item.source}</strong><span class="muted">{t(failureKey(item.code))}</span></li>{/each}
        </ul>
      </section>
    {/if}

    {#if result.keptOriginalSamples?.length}
      <section class="card samples" aria-labelledby="kept-title">
        <h2 id="kept-title">{t('result.kept')}</h2>
        <p class="muted">{t('result.keptHelp')}</p>
        <ul class="lines">{#each result.keptOriginalSamples as source (source)}<li><strong>{source}</strong></li>{/each}</ul>
      </section>
    {/if}
  {/if}
</div>

<style>
  .stat-help, .quiet-note { margin: 0; font-size: var(--text-sm); }
  /* The outcome: a neutral card with a coloured icon. A failure is not shouted; the first line says what is safe. */
  .hero { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-3) var(--space-4); align-items: start; padding: var(--space-5); }
  .hero-icon { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; background: var(--bg-sunken); color: var(--text-secondary); }
  .hero.success .hero-icon { background: var(--success-soft); color: var(--success-text); }
  .hero.warning .hero-icon { background: var(--warning-soft); color: var(--warning-text); }
  .hero.danger .hero-icon { background: var(--danger-soft); color: var(--danger-text); }
  .hero.info .hero-icon { background: var(--accent-soft); color: var(--accent-soft-text); }
  .hero-text { min-width: 0; align-self: center; }
  .hero-text h2 { font-size: var(--text-xl); font-weight: 600; }
  .hero-text p { margin-top: var(--space-1); color: var(--text-secondary); text-wrap: pretty; }
  .hero-actions { grid-column: 2; display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  .samples { padding: var(--space-4); display: grid; gap: var(--space-3); }
  .samples h2 { font-size: var(--text-lg); font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
  th { text-align: start; font-size: var(--text-overline); font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-secondary); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border); }
  td { padding: var(--space-3); border-bottom: 1px solid var(--border); vertical-align: top; overflow-wrap: anywhere; width: 50%; }
  td:first-child { color: var(--text-secondary); }
  .lines { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); font-size: var(--text-sm); }
  .lines li { display: grid; gap: 2px; padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--bg-sunken); overflow-wrap: anywhere; }
  .plain { margin: 0; padding-inline-start: 18px; }
  @media (max-width: 560px) { .hero { grid-template-columns: minmax(0, 1fr); } .hero-actions { grid-column: 1; } }
</style>
