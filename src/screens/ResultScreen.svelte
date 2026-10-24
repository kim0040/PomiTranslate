<script lang="ts">
  import { tick } from 'svelte';
  import { app } from '../lib/app.svelte';
  import { t, hasMessage, type MessageKey } from '../lib/i18n/index.svelte';
  import { formatNumber, formatCompact, formatUsd } from '../lib/format';
  import Icon, { type IconName } from '../components/Icon.svelte';
  import Callout from '../components/Callout.svelte';
  import Dialog from '../components/Dialog.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import StatGrid, { type Stat } from '../components/StatGrid.svelte';
  import UnpricedNotice from '../components/UnpricedNotice.svelte';
  import TranslationReview from '../components/TranslationReview.svelte';
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
      : presentation.status === 'budget_stopped' ? t('result.budget_stoppedBody', { cap: formatUsd(app.settings.max_cost_usd ?? 0, app.locale) })
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

  // The full list of failed rows lives in the saved table, not in the result's bounded preview.
  const failures = $derived(app.failures);
  $effect(() => {
    if (result && app.tableStatuses.includes(result.status) && failures.checkpoint === null && !failures.loading) void app.loadFailures();
  });
  // The failure list holds only rows the AI got wrong. Rows never sent (the cost cap or a cancel stopped the
  // run first) are counted apart, so the number, the list and the retry button always agree.
  const failedTotal = $derived(failures.checkpoint ? failures.total : (stats.failed ?? 0));
  const unsentTotal = $derived(failures.checkpoint ? (failures.counts?.unsent ?? failures.meta?.unsentCount ?? 0) : (stats.pending ?? 0));
  // A retry sends both kinds.
  const retryTotal = $derived(failures.checkpoint ? failures.total + unsentTotal : 0);
  const written = $derived(status === 'completed' || status === 'partial');
  // A saved table exists and still has rows to send again.
  const canRetryFailed = $derived(['partial', 'failed', 'needs_retry'].includes(status) && failures.checkpoint === true && retryTotal > 0 && !!app.scan);
  // Translations already in the world can be corrected and applied again, without any AI request.
  const canCorrect = $derived(written && failures.checkpoint === true && failures.meta?.applied === true && !!app.scan);
  // Nothing written and the scan still on screen: the same reviewed scan can simply be run again.
  const canTranslateAgain = $derived(
    !resumable && !!app.scan && ['failed', 'needs_retry', 'cancelled', 'locked'].includes(status) && !(result?.changedFileCount ?? 0)
  );
  // One primary next step; the rest are quiet.
  const primary = $derived<'interrupted' | 'budget' | 'retryFailed' | 'retry' | 'again' | 'folder' | ''>(
    firstError?.code === 'RECOVERY_REQUIRED' ? 'interrupted'
      : status === 'budget_stopped' && resumable ? 'budget'
      : canRetryFailed ? 'retryFailed'
      : resumable ? 'retry'
      : canTranslateAgain ? 'again'
      : status === 'completed' && app.worldDir ? 'folder'
      : ''
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
  const mismatches = $derived(result?.glossaryMismatchCount ?? 0);
  const otherStats = $derived<Stat[]>([
    { label: t('result.stat.unchanged'), value: num(stats.unchanged ?? 0) },
    { label: t('result.stat.failed'), value: num(failedTotal), tone: failedTotal > 0 ? 'danger' : 'default' },
    ...(unsentTotal > 0 ? [{ label: t(status === 'budget_stopped' ? 'result.stat.unsentBudget' : 'result.stat.unsent'), value: num(unsentTotal), tone: 'warning' as const }] : []),
    // Only when a term check actually flagged something: otherwise it is one more zero to read past.
    ...(mismatches > 0 ? [{ label: t('glossary.mismatchCount'), value: num(mismatches), tone: 'warning' as const }] : []),
    { label: t('result.stat.kept'), value: num(stats.kept_original ?? 0), tone: (stats.kept_original ?? 0) > 0 ? 'warning' : 'default' },
    { label: t('result.stat.filesApplied'), value: num(result?.changedFileCount ?? 0), tone: (result?.changedFileCount ?? 0) > 0 ? 'success' : 'default' },
    // The whole job, as the tokens and cost below are, not only the requests of the call that just ended.
    { label: t('result.stat.requests'), value: num(result?.jobProviderRequests ?? usage?.requests ?? result?.providerRequests ?? 0) }
  ]);
  // Nothing was written: say that first and keep the surface calm; only the icon is red.
  const unchanged = $derived(presentation.status === 'failed' && !result?.changedFileCount);
  const heroTitle = $derived(unchanged ? t('result.unchangedTitle') : t(titleKey));
  const heroBody = $derived(unchanged ? t('result.failedShort') : body);
  const heroIcon = $derived<IconName>(tone === 'success' ? 'check-circle' : tone === 'danger' ? 'alert-circle' : tone === 'warning' ? 'alert-triangle' : 'info');
  const adapted = $derived(result?.usage?.adapted_parameters?.filter((name) => typeof name === 'string' && name) ?? []);
  // With the full table one click away, a few samples are enough here.
  const samples = $derived((result?.translationSamples ?? []).slice(0, canCorrect ? 3 : undefined));

  let confirmBudgetDisabled = $state(false);
  async function raiseCap(): Promise<void> {
    app.goStep('run');
    await tick();
    document.getElementById('max-cost')?.focus();
  }
  function continueWithoutCap(): void {
    confirmBudgetDisabled = false;
    void app.startTranslate({ resume: true, budgetDisabled: true });
  }
</script>

<!-- Corrections after the world was written open the same translation table in place of the result. -->
{#if app.reviewOpen}
  <TranslationReview />
{:else}
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
        {:else if primary === 'budget'}
          <button type="button" class="btn btn-primary btn-lg" disabled={app.isBusy || !app.canRun} onclick={() => (confirmBudgetDisabled = true)}><Icon name="refresh" size={16} /> {t('result.budgetResume')}</button>
          <button type="button" class="btn btn-secondary" disabled={app.isBusy} onclick={raiseCap}>{t('result.budgetChange')}</button>
        {:else if primary === 'retryFailed'}
          <button type="button" class="btn btn-primary btn-lg" disabled={app.isBusy || !app.canRun} onclick={() => app.retryFailed()}><Icon name="refresh" size={16} /> {t('result.retryFailed', { count: formatNumber(retryTotal, app.locale) })}</button>
        {:else if primary === 'retry'}
          <button type="button" class="btn btn-primary btn-lg" disabled={app.isBusy} onclick={() => app.startTranslate({ resume: true })}><Icon name="refresh" size={16} /> {t('result.retry')}</button>
        {:else if primary === 'again'}
          <button type="button" class="btn btn-primary btn-lg" disabled={app.isBusy} onclick={() => app.translateAgain()}><Icon name="refresh" size={16} /> {t('result.again')}</button>
        {:else if primary === 'folder'}
          <button type="button" class="btn btn-primary btn-lg" onclick={() => app.openFolder(app.worldDir, 'world')}><Icon name="folder" size={16} /> {t('result.openFolder')}</button>
        {/if}
        {#if canCorrect}
          <button type="button" class="btn btn-secondary" disabled={app.isBusy} onclick={() => app.openCorrections()}><Icon name="pencil" size={16} /> {t('result.edit')}</button>
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

    <UnpricedNotice />
    {#if result.costCapEnforced === false}
      <!-- The run went ahead with the person's agreement, without the limit that was set. -->
      <Callout tone="warning" title={t('result.capNotEnforced.title')} role="status">{t('result.capNotEnforced.body')}</Callout>
    {/if}

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
    {#if result.priceSource === 'user'}<p class="muted quiet-note" role="note">{t('settings.price.userBasis')}</p>{/if}
    {#if adapted.length}<p class="muted quiet-note">{t('result.adapted', { params: adapted.join(', ') })}</p>{/if}

    {#if result.warnings?.length}
      <Callout tone="warning" title={t('result.warnings')}>
        <ul class="plain">
          {#each result.warnings as warning}
            <li>{warning.code === 'GLOSSARY_MISMATCH' ? t('glossary.warning', { count: warning.count ?? mismatches }) : warningText(warning)}</li>
          {/each}
        </ul>
      </Callout>
    {/if}

    <QualityReport counts={result.translationWarnings} samples={result.translationWarningSamples} />

    {#if samples.length}
      <section class="card samples" aria-labelledby="samples-title">
        <h2 id="samples-title">{t('result.samples')}</h2>
        <p class="muted">{t('result.samplesLead')}</p>
        <table>
          <thead><tr><th scope="col">{t('result.before')}</th><th scope="col">{t('result.after')}</th></tr></thead>
          <tbody>
            {#each samples as sample (sample.source)}
              <tr><td lang="en" translate="no">{sample.source}</td><td>{sample.translated}</td></tr>
            {/each}
          </tbody>
        </table>
        {#if canCorrect}
          <div><button type="button" class="btn btn-secondary btn-sm" disabled={app.isBusy} onclick={() => app.openCorrections()}><Icon name="list" size={14} /> {t('result.viewAll')}</button></div>
        {/if}
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

    {#if failures.rows.length || result.translationFailures?.length}
      <section class="card samples" aria-labelledby="fail-title">
        <h2 id="fail-title">{t('result.failures')}</h2>
        {#if failures.checkpoint && failures.total > 0}
          <p class="muted">{t('result.failuresTotal', { total: formatNumber(failures.total, app.locale) })}</p>
        {:else if (stats.failed ?? 0) > (result.translationFailures?.length ?? 0)}
          <p class="muted">{t('result.failuresShown', { total: formatNumber(stats.failed ?? 0, app.locale), shown: formatNumber(result.translationFailures?.length ?? 0, app.locale) })}</p>
        {/if}
        <ul class="lines">
          {#if failures.rows.length}
            {#each failures.rows as item (item.id)}
              <li>
                <strong translate="no">{item.source}</strong>
                <span class="muted">{t(failureKey(item.reason))}</span>
                {#if item.detail}<details><summary>{t('failure.details')}</summary><span class="raw mono">{item.detail}</span></details>{/if}
              </li>
            {/each}
          {:else}
            {#each result.translationFailures ?? [] as item, index (index)}
              <li>
                <strong translate="no">{item.source}</strong>
                <span class="muted">{t(failureKey(item.code ?? item.reason))}</span>
                {#if item.detail}<details><summary>{t('failure.details')}</summary><span class="raw mono">{item.detail}</span></details>{/if}
              </li>
            {/each}
          {/if}
        </ul>
        {#if failures.checkpoint && failures.rows.length < failures.total}
          <div><button type="button" class="btn btn-secondary btn-sm" disabled={failures.loading} onclick={() => app.loadFailures(true)}>{t('result.failuresMore', { count: formatNumber(failures.total - failures.rows.length, app.locale) })}</button></div>
        {/if}
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
{/if}

{#if confirmBudgetDisabled}
  <Dialog showClose={false} title={t('result.budgetUnlimitedConfirm.title')} onClose={() => (confirmBudgetDisabled = false)}>
    <Callout tone="warning" title={t('result.budget_stopped')} role="alert">{t('result.budgetUnlimitedConfirm.body')}</Callout>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" data-autofocus onclick={() => (confirmBudgetDisabled = false)}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-danger-solid" onclick={continueWithoutCap}>{t('result.budgetUnlimitedConfirm.confirm')}</button>
    {/snippet}
  </Dialog>
{/if}

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
  details { font-size: var(--text-sm); }
  summary { cursor: pointer; font-weight: 600; color: var(--text-secondary); }
  .raw { display: block; margin-top: var(--space-1); padding: var(--space-2); border-radius: var(--radius-sm); background: var(--bg-surface); color: var(--text); font-size: var(--text-xs); white-space: pre-wrap; }
  .plain { margin: 0; padding-inline-start: 18px; }
  @media (max-width: 560px) { .hero { grid-template-columns: minmax(0, 1fr); } .hero-actions { grid-column: 1; } }
</style>
