<script lang="ts">
  import { tick } from 'svelte';
  import { app } from '../lib/app.svelte';
  import { t, hasMessage, type MessageKey } from '../lib/i18n/index.svelte';
  import { formatNumber, formatCompact, formatUsd } from '../lib/format';
  import Icon from '../components/Icon.svelte';
  import Callout from '../components/Callout.svelte';
  import { resultPresentation } from '../lib/workflow';
  import { exportDocument } from '../lib/document-export';
  import { failureKey } from '../lib/failures';
  import TranslationReview from '../components/TranslationReview.svelte';
  import Dialog from '../components/Dialog.svelte';

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
  const body = $derived(
    presentation.status === 'completed' ? t('result.completedBody', { files: formatNumber(result?.changedFileCount ?? 0, app.locale) })
      : presentation.status === 'budget_stopped' ? t('result.budget_stoppedBody', { cap: formatUsd(app.settings.max_cost_usd ?? 0, app.locale) })
      // Nothing was written, so there is nothing to check or restore.
      : presentation.status === 'failed' && !result?.changedFileCount ? t('result.failedBodyUnchanged')
      : t(bodyKey)
  );
  const stats = $derived(result?.translation ?? {});
  const firstError = $derived(result?.errors?.[0]);
  const reason = $derived.by(() => {
    if (!firstError) return '';
    if (!firstError.code) return firstError.message ?? '';
    const key = `result.errorCode.${firstError.code}`;
    return hasMessage(key) ? t(key as MessageKey) : firstError.message ?? '';
  });
  const showReason = $derived(presentation.showReason);
  const resumable = $derived(!!app.resume && app.isResumeStatus(status));

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
  // No saved table: a failed run can only be translated again from the start.
  const canRetranslate = $derived(['failed', 'needs_retry'].includes(status) && failures.checkpoint === false && !!app.scan);
  const canCorrect = $derived(written && failures.checkpoint === true && failures.meta?.applied === true && !!app.scan);
  const rescanSecondary = $derived(!['completed', 'cancelled', 'budget_stopped'].includes(status));
  const usage = $derived(result?.usage);
  const cards = $derived([
    // "Applied" only once the world was written; before that the same rows are "prepared" (U9).
    { label: t(written ? 'result.stat.applied' : 'result.stat.prepared'), value: stats.translated ?? 0, tone: written ? 'ok' : '' },
    { label: t('result.stat.unchanged'), value: stats.unchanged ?? 0, tone: '' },
    { label: t('result.stat.failed'), value: failedTotal, tone: failedTotal > 0 ? 'bad' : '' },
    ...(unsentTotal > 0 ? [{ label: t(status === 'budget_stopped' ? 'result.stat.unsentBudget' : 'result.stat.unsent'), value: unsentTotal, tone: 'warn' }] : []),
    // Only when a term check actually flagged something: otherwise it is one more zero to read past.
    ...((result?.glossaryMismatchCount ?? 0) > 0 ? [{ label: t('glossary.mismatchCount'), value: result?.glossaryMismatchCount ?? 0, tone: 'warn' }] : []),
    { label: t('result.stat.kept'), value: stats.kept_original ?? 0, tone: (stats.kept_original ?? 0) > 0 ? 'warn' : '' },
    { label: t('result.stat.files'), value: result?.changedFileCount ?? 0, tone: '' },
    // The whole job, as the tokens and cost below are, not only the request of the call that just ended.
    { label: t('result.stat.requests'), value: result?.jobProviderRequests ?? usage?.requests ?? result?.providerRequests ?? 0, tone: '' }
  ]);
  const samples = $derived((result?.translationSamples ?? []).slice(0, canCorrect ? 3 : 12));
  const warnKnown = ['chunk_unreadable', 'file_unwritable', 'file_unreadable', 'command_unparsed'];
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

{#if app.reviewOpen}
  <TranslationReview />
{:else}
<div class="page">
  <header class="page-head with-actions">
    <h1>{t('result.title')}</h1>
    <div class="actions"><button type="button" class="btn btn-secondary btn-sm" title={t('export.reportHelp')} disabled={!!app.busy} onclick={exportReport}><Icon name="download" size={14} /> {t('export.report')}</button></div>
  </header>

  {#if result}
    <Callout {tone} title={t(titleKey)} role="status">
      {body}
      {#if showReason && reason}<br />{reason}{/if}
      {#if status === 'completed'}<br />{t('result.completedNext')}{/if}
      {#snippet actions()}
        {#if status === 'budget_stopped'}
          <button type="button" class="btn btn-primary" disabled={app.isBusy || !app.canRun} onclick={() => (confirmBudgetDisabled = true)}><Icon name="refresh" size={18} /> {t('result.budgetResume')}</button>
          <button type="button" class="btn btn-secondary" disabled={app.isBusy} onclick={raiseCap}>{t('result.budgetChange')}</button>
        {:else if canRetryFailed}
          <button type="button" class="btn btn-primary" disabled={app.isBusy || !app.canRun} onclick={() => app.retryFailed()}><Icon name="refresh" size={18} /> {t('result.retryFailed', { count: formatNumber(retryTotal, app.locale) })}</button>
        {:else if canRetranslate}
          <button type="button" class="btn btn-primary" disabled={app.isBusy || !app.canRun} onclick={() => app.startTranslate({ resume: false })}><Icon name="refresh" size={18} /> {t('result.retranslate')}</button>
        {:else if resumable}
          <button type="button" class="btn btn-primary" disabled={app.isBusy || !app.canRun} onclick={() => app.startTranslate({ resume: true })}><Icon name="refresh" size={18} /> {t('result.retry')}</button>
        {/if}
        {#if canCorrect}
          <button type="button" class="btn btn-secondary" disabled={app.isBusy} onclick={() => app.openCorrections()}><Icon name="pencil" size={18} /> {t('result.edit')}</button>
        {/if}
        {#if rescanSecondary}
          <button type="button" class="btn btn-secondary" disabled={app.isBusy} onclick={() => app.goStep('scan')}>{t('result.retryAll')}</button>
        {/if}
        {#if written}
          <button type="button" class="btn btn-secondary" onclick={() => app.revealWorld()}><Icon name="folder" size={18} /> {t('result.openWorld')}</button>
        {/if}
        {#if result.backupSetId}
          <button type="button" class="btn btn-secondary" onclick={() => app.goto('backups')}><Icon name="archive" size={18} /> {t('result.toBackups')}</button>
        {/if}
        {#if status === 'completed'}
          <button type="button" class="btn btn-secondary" onclick={() => { app.goto('workspace'); app.goStep('world'); }}>{t('result.newRun')}</button>
        {/if}
      {/snippet}
    </Callout>

    <section class="stats card" aria-label={t('result.title')}>
      {#each cards as card (card.label)}
        <div class="stat {card.tone}"><span class="v num">{formatNumber(card.value, app.locale)}</span><span class="l">{card.label}</span></div>
      {/each}
    </section>
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
    {#if result.priceSource === 'user'}<p class="muted price-source" role="note">{t('settings.price.userBasis')}</p>{/if}

    {#if result.warnings?.length}
      <Callout tone="warning" title={t('result.warnings')}>
        <ul class="plain">
          {#each result.warnings as warning}
            <li>{warning.code === 'GLOSSARY_MISMATCH' ? t('glossary.warning', { count: warning.count ?? result.glossaryMismatchCount ?? 0 }) : warnKnown.includes(warning.code) ? t(`scan.warn.${warning.code}` as MessageKey, { file: warning.file ?? '', count: warning.count ?? 0 }) : warning.message ?? t('scan.warn.unknown')}</li>
          {/each}
        </ul>
      </Callout>
    {/if}

    {#if samples.length}
      <section class="card samples" aria-labelledby="samples-title">
        <h2 id="samples-title">{t('result.samples')}</h2>
        <p class="muted">{t('result.samplesLead')}</p>
        <table>
          <thead><tr><th scope="col">{t('result.before')}</th><th scope="col">{t('result.after')}</th></tr></thead>
          <tbody>
            {#each samples as sample (sample.source)}
              <tr><td translate="no">{sample.source}</td><td>{sample.translated}</td></tr>
            {/each}
          </tbody>
        </table>
        {#if canCorrect}
          <div><button type="button" class="btn btn-secondary btn-sm" disabled={app.isBusy} onclick={() => app.openCorrections()}><Icon name="list" size={14} /> {t('result.viewAll')}</button></div>
        {/if}
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
                <span class="muted">{t(failureKey(item.reason))}</span>
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
  <Dialog title={t('result.budgetUnlimitedConfirm.title')} onClose={() => (confirmBudgetDisabled = false)}>
    <Callout tone="warning" title={t('result.budget_stopped')} role="alert">{t('result.budgetUnlimitedConfirm.body')}</Callout>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" data-autofocus onclick={() => (confirmBudgetDisabled = false)}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-danger" onclick={continueWithoutCap}>{t('result.budgetUnlimitedConfirm.confirm')}</button>
    {/snippet}
  </Dialog>
{/if}

<style>
  /* One strip of numbers, divided by hairlines, instead of a dashboard of cards. */
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); overflow: hidden; }
  .stat { padding: var(--space-3) var(--space-4); display: grid; gap: 2px; align-content: start; border-inline-start: 1px solid var(--border); margin-inline-start: -1px; }
  .stat .v { font-size: var(--text-2xl); font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; }
  .stat .l { font-size: var(--text-sm); color: var(--text-secondary); }
  .stat.ok .v { color: var(--success-text); }
  .stat.bad .v { color: var(--danger-text); }
  .stat.warn .v { color: var(--warning-text); }
  .samples { padding: var(--space-4); display: grid; gap: var(--space-3); }
  .samples h2 { font-size: var(--text-lg); }
  table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
  th { text-align: start; font-size: var(--text-xs); letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-secondary); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border); }
  td { padding: var(--space-3); border-bottom: 1px solid var(--border); vertical-align: top; overflow-wrap: anywhere; width: 50%; }
  td:first-child { color: var(--text-secondary); }
  .lines { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); font-size: var(--text-sm); }
  .lines li { display: grid; gap: 2px; padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--bg-sunken); overflow-wrap: anywhere; }
  details { font-size: var(--text-sm); }
  summary { cursor: pointer; font-weight: 600; color: var(--text-secondary); }
  .raw { display: block; margin-top: var(--space-1); padding: var(--space-2); border-radius: var(--radius-sm); background: var(--bg-surface); color: var(--text); font-size: var(--text-xs); white-space: pre-wrap; }
  .plain { margin: 0; padding-inline-start: 18px; }
</style>
