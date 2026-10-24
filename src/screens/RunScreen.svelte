<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { hasMessage, t, type MessageKey } from '../lib/i18n/index.svelte';
  import { baseName, formatDuration, formatNumber, formatCompact, formatRequestEstimate, formatUsd, middleEllipsis } from '../lib/format';
  import Icon from '../components/Icon.svelte';
  import Callout from '../components/Callout.svelte';
  import ProgressBar from '../components/ProgressBar.svelte';
  import SetupNotice from '../components/SetupNotice.svelte';
  import Dialog from '../components/Dialog.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import WorldCard from '../components/WorldCard.svelte';
  import NewerVersionNotice from '../components/NewerVersionNotice.svelte';
  import UnpricedNotice from '../components/UnpricedNotice.svelte';
  import TranslationReview from '../components/TranslationReview.svelte';
  import type { TranslateOptions } from '../lib/app/translation-job.svelte';
  import { needsNewerConfirmation } from '../lib/chunk-coverage';
  import { estimateMinutes, SUGGESTED_CAP_USD } from '../lib/cost-safety';
  import { providerLabel } from '../lib/providers';
  import { REASONING_PROVIDERS, reasoningSummary, supportsReasoning } from '../lib/reasoning';
  import { clock, holdClock } from '../lib/clock.svelte';
  import { milestone, percentDone, remainingSeconds, roundEta } from '../lib/workflow';
  import { failureKey } from '../lib/failures';
  import { warningRows, warningTotal } from '../lib/glossary';

  const running = $derived(app.busy === 'translate');
  const reasoningModel = $derived(app.modelsFor(app.settings).find((model) => model.id === app.settings.model.trim()));
  const reasoning = $derived(reasoningSummary(app.settings.openrouter_reasoning ?? 'default', reasoningModel));
  // A model known not to reason has nothing to edit; an unknown one might, so the way to settings stays.
  const reasoningEditable = $derived(!reasoningModel || supportsReasoning(reasoningModel));
  let confirmFresh = $state(false);
  let confirmDiscardResume = $state(false);
  // A saved job is continued, unless it only waits for the review (that is opened, not started).
  const resumeStart = $derived(!!app.resume && app.resume.status !== 'awaiting_review');
  const awaitingReview = $derived(app.resume?.status === 'awaiting_review');
  // First send to this provider and model: say what leaves the computer and what it costs, once.
  // Every way to start (Start, start over, start above the limit) asks it first.
  let pendingStart = $state<TranslateOptions | null>(null);
  function begin(options: TranslateOptions): void {
    if (app.needsConsent) {
      pendingStart = options;
      return;
    }
    void app.startTranslate(options);
  }
  function start(): void {
    begin({ resume: resumeStart });
  }
  function sendConfirmed(): void {
    const options = pendingStart ?? { resume: resumeStart };
    pendingStart = null;
    app.grantConsent();
    void app.startTranslate(options);
  }
  function startFresh(): void {
    confirmFresh = false;
    begin({ resume: false });
  }
  // The estimate is above the limit: going on anyway is an explicit choice, for this start only.
  function startAnyway(): void {
    begin({ resume: resumeStart, budgetOverride: true });
  }
  let attemptedMetadata = false;
  $effect(() => {
    if (app.settings.provider !== 'openrouter' || app.manualOnly || app.isBusy || attemptedMetadata) return;
    const timer = setTimeout(() => {
      attemptedMetadata = true;
      void app.loadModels().catch(() => {}); // The summary explicitly keeps unknown metadata unknown.
    }, 0);
    return () => clearTimeout(timer);
  });
  const estimate = $derived(app.estimate);
  const modelText = $derived(
    app.manualOnly ? t('run.manualOnly') : app.hasModel ? `${providerLabel(app.settings.provider)} · ${app.settings.model}` : t('run.noModel')
  );

  // The spending limit is typed in dollars and saved when the field is left, so a half-typed number is never sent.
  let capText = $state(String(app.settings.max_cost_usd ?? 0));
  let capError = $state(false);
  $effect(() => { capText = String(app.settings.max_cost_usd ?? 0); });
  function commitCap(): void {
    const value = Number(capText.replace(',', '.'));
    if (capText.trim() === '' || !Number.isFinite(value) || value < 0 || value > 1000) {
      capError = true;
      return;
    }
    capError = false;
    if (value === (app.settings.max_cost_usd ?? 0)) { capText = String(value); return; }
    void app.setRunOption({ max_cost_usd: Math.round(value * 10000) / 10000 });
  }
  function focusCap(): void { document.getElementById('max-cost')?.focus(); }
  const cap = $derived(app.settings.max_cost_usd ?? 0);
  const safety = $derived(app.costSafety);
  const minutes = $derived(app.manualOnly ? null : estimateMinutes(estimate?.requestRange?.high ?? estimate?.requests, app.settings.concurrency));
  const reviewFirst = $derived(app.settings.review_before_apply !== false);

  // The sidebar and this screen read the same clock, so their elapsed times always agree.
  $effect(() => {
    if (!running) return;
    return holdClock();
  });
  const now = $derived(clock.now);

  const p = $derived(app.progress);
  // Applying reviewed translations sends no request, so only the write phase is shown for it.
  const writing = $derived(app.operation === 'apply' || app.operation === 'reapply');
  const translating = $derived(!writing);
  const allPhases: { id: 'collect' | 'translate' | 'write'; key: MessageKey }[] = [
    { id: 'collect', key: 'run.phase.collect' },
    { id: 'translate', key: 'run.phase.translate' },
    { id: 'write', key: 'run.phase.write' }
  ];
  const phases = $derived(writing ? allPhases.filter((phase) => phase.id === 'write') : allPhases);
  const order = { idle: -1, collect: 0, translate: 1, write: 2, recovery: -1 } as const;
  const phaseIndex = $derived(order[p.phase]);
  const barValue = $derived(
    p.phase === 'translate' ? (p.total ? p.done : null) : p.fileTotal ? p.fileIndex : null
  );
  const barMax = $derived(p.phase === 'translate' ? p.total || 100 : p.fileTotal || 100);
  const detail = $derived(
    p.phase === 'translate'
      ? t('run.progress.translate', { done: formatNumber(p.done, app.locale), total: formatNumber(p.total, app.locale) })
      : p.phase === 'write'
        ? t('run.progress.write', { index: p.fileIndex, total: p.fileTotal })
        : p.fileTotal
          ? t('run.progress.collect', { index: p.fileIndex, total: p.fileTotal })
          : t('common.loading')
  );
  const eta = $derived(remainingSeconds(p, now, app.cancelling));
  // What a screen reader hears: the phase when it changes, then every 10% — never each sentence.
  const announcement = $derived.by(() => {
    const phase = phases.find((item) => item.id === p.phase);
    if (!phase) return '';
    const step = milestone(percentDone(p));
    return step === null ? t(phase.key) : t('run.announce', { phase: t(phase.key), percent: step });
  });
  const busyTitle = $derived(writing ? t('run.busyApply') : app.operation === 'retry' ? t('run.busyRetry') : t('run.busy'));
  const spentText = $derived.by(() => {
    if (p.cost === null) return '–';
    const spent = formatUsd(p.cost, app.locale);
    return estimate?.cost ? t('run.cost.spentOf', { spent, high: formatUsd(estimate.cost.high, app.locale) }) : spent;
  });
  // A price from the dated list-price table says when it was read and links the page it came from.
  const tablePrice = $derived(estimate?.cost && estimate.price?.source === 'table' && estimate.price.checkedOn ? estimate.price : null);
  const tableUrl = $derived(tablePrice?.sourceUrl?.startsWith('https://') ? tablePrice.sourceUrl : '');
  const TABLE_PROVIDERS = ['openai', 'gemini', 'anthropic'];
  const costText = $derived.by(() => {
    if (app.manualOnly || estimate?.requests === 0) return t('run.cost.free');
    if (!estimate) return app.estimateLoading ? t('run.cost.calculating') : t('run.cost.unknown');
    if (!estimate.cost) return t('run.cost.unknown');
    return t('run.cost.band', { low: formatUsd(estimate.cost.low, app.locale), high: formatUsd(estimate.cost.high, app.locale) });
  });
  // The core says whether the estimate already counts reasoning tokens; without that, a reasoning model only gets the warning.
  const reasoningNote = $derived(
    estimate?.reasoningIncluded ? t('run.estimate.reasoning')
      : REASONING_PROVIDERS.includes(app.settings.provider) && app.settings.openrouter_reasoning !== 'disabled' ? t('run.reasoning.cost')
      : ''
  );
  // Quality warnings so far, said once and quietly: they never stop the run.
  const qualityLine = $derived.by(() => {
    const rows = warningRows(p.warnings);
    if (!rows.length) return '';
    const details = rows.map((row) => t('quality.run.detail', {
      label: t((hasMessage(`quality.run.short.${row.code}`) ? `quality.run.short.${row.code}` : 'quality.run.short.other') as MessageKey),
      count: formatNumber(row.count, app.locale)
    })).join(', ');
    return t('quality.run.line', { count: formatNumber(warningTotal(p.warnings), app.locale), details });
  });
  const resumeText = $derived(
    app.resume
      ? (app.resume.status === 'awaiting_review'
          ? t('run.resumeInfoReview', { count: app.resume.translatedCount ?? 0 })
          : app.resume.status === 'budget_stopped'
            ? t('run.resumeInfoBudget', { count: app.resume.translatedCount ?? 0 })
            : app.resume.status === 'cancelled'
              ? t('run.resumeInfoCancelled', { count: app.resume.translatedCount ?? 0 })
              : t('run.resumeInfo', { count: app.resume.translatedCount ?? 0 }))
      : ''
  );
</script>

<!-- The translations wait here for review before anything is written to the world. -->
{#if !running && app.reviewOpen}
  <TranslationReview />
{:else}
<div class="page">
  {#if running}
    <PageHeader title={busyTitle} lead={writing ? t('run.busyApplyHelp') : t('run.busyHelp')} />

    <div class="live-grid" class:two={translating && p.samples.length > 0}>
      <section class="card live">
        <p class="sr-only" role="status" aria-live="polite">{announcement}</p>
        <ol class="phases" aria-label={t('step.list')}>
          {#each phases as phase, index (phase.id)}
            {@const at = order[phase.id]}
            <li class:done={phaseIndex > at} class:current={phaseIndex === at}>
              <span class="dot" aria-hidden="true">
                {#if phaseIndex > at}<Icon name="check" size={14} />{:else if phaseIndex === at}<span class="ping"></span>{:else}{index + 1}{/if}
              </span>
              <span>{t(phase.key)}</span>
            </li>
          {/each}
        </ol>

        <div class="bar">
          <ProgressBar label={detail} value={barValue} max={barMax} />
          <div class="line">
            <span class="num strong">{detail}</span>
            <span class="spacer"></span>
            <span class="num muted" role="timer" aria-live="off">{t('run.progress.elapsed', { time: formatDuration((now - p.startedAt) / 1000, app.locale) })}</span>
          </div>
          <!-- Always one line tall, so the rows below do not move when an estimate appears. -->
          <p class="num muted detail-line">
            {#if translating && eta !== null}{t('run.progress.eta', { time: formatDuration(roundEta(eta), app.locale) })}{:else}&nbsp;{/if}
            {#if p.currentFile && p.phase !== 'translate'}<span class="file mono" title={p.currentFile}>{middleEllipsis(p.currentFile, 56)}</span>{/if}
          </p>
        </div>

        <!-- Always laid out while translating, so the cancel button does not move when translation starts. -->
        {#if translating}
          <dl class="facts" class:four={cap > 0}>
            <div><dt>{t('run.progress.requestsLabel')}</dt><dd class="num">{p.phase === 'translate' ? t('run.progress.requests', { done: p.requests, total: p.requestsEstimate || estimate?.requests || 0 }) : '–'}</dd></div>
            <div><dt>{t('result.stat.failed')}</dt><dd class="num" class:bad={p.failed > 0}>{p.phase === 'translate' ? p.failed : '–'}</dd></div>
            <div><dt>{t('run.cost.soFar')}</dt><dd class="num">{spentText}</dd></div>
            {#if cap > 0}<div><dt>{t('run.budget.label')}</dt><dd class="num">{formatUsd(cap, app.locale)}</dd></div>{/if}
          </dl>
        {/if}

        {#if p.retry}
          <Callout tone="warning" title={t('run.progress.retry', { attempt: p.retry.attempt, max: p.retry.max })} role="status">
            {#if p.retry.code}{t(failureKey(p.retry.code))}{/if}
          </Callout>
        {/if}

        {#if p.glossaryDropped !== null}
          <p class="muted quality">{t('quality.glossaryChanged', { count: formatNumber(p.glossaryDropped, app.locale) })}</p>
        {/if}
        {#if qualityLine}<p class="muted quality">{qualityLine}</p>{/if}

        <div>
          <button type="button" class="btn btn-secondary" disabled={app.cancelling} onclick={() => app.cancel()}>
            <Icon name="stop" size={18} /> {app.cancelling ? t('run.cancelling') : t('run.cancel')}
          </button>
        </div>
      </section>

      <!-- The strongest trust signal for a translation tool: what was just translated, as it happens. -->
      {#if translating && p.samples.length}
        <section class="card feed" aria-labelledby="feed-title">
          <h2 id="feed-title" class="section-title">{t('run.samples')}</h2>
          <ul>
            {#each p.samples as sample, index (index + sample.source)}
              <li>
                <span class="from" title={sample.source} translate="no">{sample.source}</span>
                <span class="to" title={sample.translated}><span class="arrow" aria-hidden="true">→</span> {sample.translated}</span>
              </li>
            {/each}
          </ul>
        </section>
      {/if}
    </div>
  {:else}
    {#if app.resume}
      <Callout tone="info" title={t('world.resumeFound')}>
        {resumeText}
        {#if app.resume.reason}<br /><strong>{t('run.resumeReason')}:</strong> {app.resume.reason}{/if}
        {#snippet actions()}
          <button type="button" class="btn btn-quiet btn-sm" disabled={app.isBusy} onclick={() => (confirmDiscardResume = true)}>{t('run.discard')}</button>
        {/snippet}
      </Callout>
    {/if}

    <PageHeader title={t('run.title')} lead={t('run.lead')} />

    <SetupNotice blocking />

    {#if needsNewerConfirmation(app.scan?.chunkCoverage)}
      <NewerVersionNotice confirm />
    {/if}

    {#if (safety === 'unlimited' || (safety === 'pending' && cap <= 0)) && !app.noLimitAcknowledged && !app.manualOnly}
      <!-- Not a blocker: someone who chose no limit can go on. It is only a reminder with a one-click fix. It shows while the estimate is still
           on its way (the limit is already known), so the page below does not jump when the estimate arrives. -->
      <Callout tone="warning" title={t('run.nolimit.title')} role="status">
        {t('run.nolimit.body')}
        {#snippet actions()}
          <button type="button" class="btn btn-primary btn-sm" disabled={!!app.busy} onclick={() => void app.setRunOption({ max_cost_usd: SUGGESTED_CAP_USD })}>{t('run.nolimit.set', { cap: formatUsd(SUGGESTED_CAP_USD, app.locale) })}</button>
          <button type="button" class="btn btn-quiet btn-sm" onclick={() => (app.noLimitAcknowledged = true)}>{t('run.nolimit.keep')}</button>
        {/snippet}
      </Callout>
    {/if}

    <UnpricedNotice onConsent={() => begin({ resume: resumeStart, unpricedCapAck: true })} />

    <div class="cols">
      <section class="col" aria-labelledby="summary-title">
        <h2 id="summary-title" class="group-title">{t('run.summaryTitle')}</h2>
        <WorldCard compact name={baseName(app.worldDir)} path={app.worldDir} />
        <dl class="group">
          <div class="row-item"><dt class="k">{t('run.summary.language')}</dt><dd class="v">{app.settings.target_language}</dd></div>
          <div class="row-item"><dt class="k">{t('run.summary.model')}</dt><dd class="v" class:warn={!app.hasModel && !app.manualOnly}>{modelText}</dd></div>
          {#if REASONING_PROVIDERS.includes(app.settings.provider) && !app.manualOnly}
            <div class="row-item"><dt class="k">{t('settings.reasoning.label')}</dt><dd class="v inline"><span class="text">{reasoning}</span>{#if reasoningEditable}<button type="button" class="btn btn-quiet btn-sm edit-settings" disabled={!!app.busy} onclick={() => app.openSettingsFor('run', 'translate', 'reasoning-settings')}>{t('run.reasoning.edit')}</button>{/if}</dd></div>
          {/if}
          <div class="row-item">
            <dt class="k"><label for="review-before-apply">{t('run.review.label')}</label></dt>
            <dd class="v">
              <label class="check inline-check">
                <input id="review-before-apply" type="checkbox" checked={reviewFirst} disabled={!!app.busy}
                  aria-describedby="review-before-apply-help" onchange={(event) => void app.setRunOption({ review_before_apply: event.currentTarget.checked })} />
                <span class="label">{t('run.review.check')}</span>
              </label>
              <span id="review-before-apply-help" class="sub">{reviewFirst ? t('run.review.helpOn') : t('run.review.helpOff')}</span>
            </dd>
          </div>
        </dl>
      </section>

      <section class="col" aria-labelledby="work-title">
        <h2 id="work-title" class="group-title">{t('run.workTitle')}</h2>
        <!-- The one number to decide on, set apart from the facts around it. -->
        <div class="card cost">
          <p class="overline">{t('run.summary.cost')}</p>
          <p class="cost-head num" class:warn={safety === 'unpriced'}>{costText}</p>
          <!-- While a new estimate is on its way its lines keep their place, so nothing below jumps. -->
          {#if (estimate && estimate.requests > 0) || (!estimate && app.estimateLoading && !app.manualOnly)}
            <span class="sub">{estimate ? t('run.summary.tokens', { input: formatCompact(estimate.inputTokens, app.locale), output: formatCompact(estimate.outputTokens, app.locale) }) : ' '}</span>
            <span class="sub">{estimate ? (estimate.cost ? t('run.cost.note') : t(TABLE_PROVIDERS.includes(app.settings.provider) ? 'run.cost.unknownTable' : 'run.cost.unknownWhy')) : ' '}</span>
            {#if tablePrice}
              <span class="sub" data-testid="cost-table-note">{t('run.cost.table', { date: tablePrice.checkedOn ?? '' })}{#if tableUrl} <a href={tableUrl} target="_blank" rel="noreferrer">{t('run.cost.tableLink')}</a>{/if} {t('run.cost.tableBill')}</span>
            {/if}
            {#if estimate?.priceSource === 'user'}<span class="sub">{t('settings.price.userBasis')}</span>{/if}
            {#if reasoningNote}<span class="sub">{reasoningNote}</span>{/if}
          {/if}
          {#if minutes !== null}
            <span class="sub time">{t('run.glance.time', { minutes: formatNumber(minutes, app.locale) })} · {t('run.glance.timeNote')}</span>
          {/if}
        </div>
        <dl class="group">
          <div class="row-item"><dt class="k">{t('run.summary.texts')}</dt><dd class="v num">{formatNumber(app.outgoingCount, app.locale)}</dd></div>
          <div class="row-item"><dt class="k">{t('run.summary.manual')}</dt><dd class="v num">{formatNumber(app.manualCount, app.locale)}</dd></div>
          <div class="row-item"><dt class="k">{t('run.summary.requests')}</dt><dd class="v num">{app.manualOnly ? '0' : estimate ? formatRequestEstimate(estimate, app.locale) : app.estimateLoading ? t('run.cost.calculating') : t('common.unknown')}</dd></div>
          {#if !app.manualOnly}
            <div class="row-item">
              <dt class="k"><label for="max-cost">{t('run.budget.label')}</label></dt>
              <dd class="v">
                <span class="cap">
                  <span class="unit">$</span>
                  <input id="max-cost" class="input num" type="text" inputmode="decimal" autocomplete="off" bind:value={capText} disabled={!!app.busy}
                    aria-invalid={capError ? 'true' : undefined} aria-describedby="max-cost-help" onchange={commitCap} onkeydown={(event) => { if (event.key === 'Enter') commitCap(); }} />
                  <span class="unit">USD</span>
                </span>
                <span id="max-cost-help" class="sub" class:bad={capError}>{capError ? t('run.budget.invalid') : cap > 0 ? t('run.budget.help') : t('run.budget.none')}</span>
              </dd>
            </div>
          {/if}
          <div class="row-item"><dt class="k">{t('run.summary.backup')}</dt><dd class="v backup"><Icon name="shield" size={14} /> {t('run.summary.backupValue')}</dd></div>
          <div class="row-item"><dt class="k">{t('run.summary.redistribute')}</dt><dd class="v">{t('run.summary.redistributeValue')}</dd></div>
          {#if app.settings.resource_pack_enabled && app.settings.external_resource_pack_paths?.length}
            <div class="row-item"><dt class="k">{t('settings.pack.externalTitle')}</dt><dd class="v"><ul class="external-paths">{#each app.settings.external_resource_pack_paths as path}<li class="mono">{path}</li>{/each}</ul><span class="sub">{t('settings.pack.externalHelp')}</span></dd></div>
          {/if}
        </dl>
      </section>
    </div>

    <!-- With the review on, nothing is written until it is applied, so failed rows are retried there instead. -->
    {#if !reviewFirst}
      <fieldset class="group policy">
        <legend class="group-title">{t('run.failurePolicy')}</legend>
        <label class="row-item check"><input type="radio" name="policy" value="stop" bind:group={app.failurePolicy} /><span>{t('run.failure.stop')}</span></label>
        <label class="row-item check"><input type="radio" name="policy" value="skip" bind:group={app.failurePolicy} /><span>{t('run.failure.skip')}</span></label>
      </fieldset>
    {/if}

    {#if app.overBudget}
      <Callout tone="warning" title={t('run.budget.title')} role="alert">
        {t('run.budget.body', { high: formatUsd(estimate?.cost?.high ?? 0, app.locale), cap: formatUsd(cap, app.locale) })}
        {#snippet actions()}
          <button type="button" class="btn btn-secondary btn-sm" onclick={focusCap}>{t('run.budget.change')}</button>
          <button type="button" class="btn btn-primary btn-sm" disabled={!app.canRun} onclick={startAnyway}>{t('run.budget.anyway')}</button>
        {/snippet}
      </Callout>
    {/if}

    <div class="action-bar">
      <p class="note">{t('run.confirm.note')}</p>
      <div class="buttons">
        <button type="button" class="btn btn-secondary btn-lg" disabled={app.isBusy} onclick={() => app.goStep('review')}>
          <Icon name="chevron-left" size={16} /> {t('step.review')}
        </button>
        {#if app.resume}
          <!-- Resuming is the default; starting over is offered, behind a cost warning. -->
          <button type="button" class="btn btn-secondary btn-lg" disabled={!app.canRun} onclick={() => (confirmFresh = true)}>{t('run.fresh')}</button>
        {/if}
        {#if awaitingReview}
          <button type="button" class="btn btn-primary btn-lg" disabled={!!app.busy} onclick={() => app.openReview()}>
            <Icon name="list" size={16} /> {t('run.openReview')}
          </button>
        {:else}
          <!-- Above the limit, or a limit that cannot be checked: the notices above hold the explicit way on. -->
          <button type="button" class="btn btn-primary btn-lg" disabled={!app.canRun || app.overBudget || app.unpriced} onclick={start}>
            <Icon name="play" size={16} /> {app.resume ? t('run.resume') : t('run.start')}
          </button>
        {/if}
      </div>
    </div>
  {/if}
</div>
{/if}

{#if confirmFresh && app.resume}
  <Dialog showClose={false} title={t('run.freshTitle')} onClose={() => (confirmFresh = false)}>
    <p>{t('run.freshBody', { count: formatNumber(app.resume.translatedCount ?? 0, app.locale) })}</p>
    {#if app.overBudget}<p class="bad">{t('run.budget.body', { high: formatUsd(estimate?.cost?.high ?? 0, app.locale), cap: formatUsd(cap, app.locale) })}</p>{/if}
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" data-autofocus onclick={() => (confirmFresh = false)}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-primary" disabled={!app.canRun} onclick={startFresh}>{t('run.freshConfirm')}</button>
    {/snippet}
  </Dialog>
{/if}

{#if pendingStart}
  <Dialog showClose={false} title={t('run.confirm.title')} onClose={() => (pendingStart = null)}>
    <p>{t('run.confirm.body')}</p>
    <dl class="group">
      <div class="row-item"><dt class="k">{t('run.summary.model')}</dt><dd class="v">{modelText}</dd></div>
      <div class="row-item"><dt class="k">{t('run.summary.texts')}</dt><dd class="v num">{formatNumber(app.outgoingCount, app.locale)}</dd></div>
      <div class="row-item"><dt class="k">{t('run.summary.cost')}</dt><dd class="v num">{costText}</dd></div>
      {#if !app.manualOnly}
        <div class="row-item"><dt class="k">{t('run.budget.label')}</dt><dd class="v num">{cap > 0 ? formatUsd(cap, app.locale) : t('run.glance.limitNone')}</dd></div>
      {/if}
    </dl>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" data-autofocus onclick={() => (pendingStart = null)}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-primary" disabled={!app.canRun} onclick={sendConfirmed}>{t('run.confirm.send')}</button>
    {/snippet}
  </Dialog>
{/if}

{#if confirmDiscardResume}
  <Dialog showClose={false} title={t('run.discardTitle')} onClose={() => (confirmDiscardResume = false)}>
    <p>{t('run.discardBody')}</p>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" data-autofocus onclick={() => (confirmDiscardResume = false)}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-danger-solid" onclick={() => { confirmDiscardResume = false; void app.discardResume(); }}>{t('run.discardConfirm')}</button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-5); align-items: start; }
  .col { display: grid; gap: var(--space-3); min-width: 0; }
  .col > .group-title { margin: 0; }
  .group-title { font-size: var(--text-sm); font-weight: 600; color: var(--text-secondary); margin: 0 0 6px var(--space-1); }
  .cost { padding: var(--space-4); display: grid; gap: 2px; }
  .cost a { color: var(--accent-text); text-decoration: underline; }
  .cost-head { font-size: var(--text-xl); font-weight: 600; letter-spacing: -0.01em; min-height: 1.4em; }
  .cost-head.warn { color: var(--warning-text); }
  .cost .time { margin-top: var(--space-2); }
  .detail-line { margin: 0; min-height: 1.4em; font-size: var(--text-sm); display: flex; gap: var(--space-3); }
  .file { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); }
  .external-paths { padding-inline-start: 1em; margin: 0; overflow-wrap: anywhere; }
  /* The edit button keeps its line when the summary text changes length, so the rows below stay put. */
  .inline { display: flex; align-items: center; gap: var(--space-2); }
  .inline > .text { flex: 1 1 auto; min-width: 0; }
  .edit-settings { flex: none; }
  .cap { display: inline-flex; align-items: center; gap: var(--space-2); }
  .cap .input { width: 96px; text-align: end; }
  .cap .unit { color: var(--text-secondary); font-size: var(--text-sm); }
  .inline-check { display: flex; align-items: center; gap: var(--space-2); }
  .inline-check .label { font-weight: 500; }
  .inline-check input[type='checkbox'] { width: 16px; height: 16px; margin: 0; }
  /* Progress: the live card on the left, the feed of finished sentences beside it when the core sends them. */
  .live-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); align-items: start; }
  .live-grid.two { grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); }
  .live { padding: var(--space-5); display: grid; gap: var(--space-5); }
  .phases { display: flex; gap: var(--space-5); margin: 0; padding: 0; list-style: none; flex-wrap: wrap; }
  .phases li { display: flex; align-items: center; gap: var(--space-2); color: var(--text-secondary); font-weight: 500; }
  .phases li.current { color: var(--text); font-weight: 600; }
  .phases li.done { color: var(--success-text); }
  .dot { position: relative; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; border: 1.5px solid var(--border-control); font-size: var(--text-xs); font-variant-numeric: tabular-nums; background: var(--bg-surface); }
  li.done .dot { background: var(--success-solid); border-color: var(--success-solid); color: #fff; }
  li.current .dot { border-color: var(--accent); }
  .ping { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); animation: pomi-pulse 1.2s ease-in-out infinite; }
  @keyframes pomi-pulse { 50% { opacity: 0.3; scale: 0.8; } }
  .bar { display: grid; gap: var(--space-2); }
  .line { display: flex; align-items: baseline; gap: var(--space-3); }
  .strong { font-weight: 600; }
  .quality { margin: 0; font-size: var(--text-sm); text-wrap: pretty; }
  .facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-4); margin: 0; padding-top: var(--space-4); border-top: 1px solid var(--border); }
  .facts.four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .facts dt { font-size: var(--text-sm); color: var(--text-secondary); font-weight: 500; }
  .facts dd { margin: 0; font-size: var(--text-lg); font-weight: 600; }
  .bad { color: var(--danger-text); }
  dd.warn { color: var(--warning-text); }
  .feed { padding: var(--space-4); display: grid; gap: var(--space-3); align-content: start; }
  .feed .section-title { margin: 0; }
  .feed ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
  .feed li { display: grid; gap: 2px; padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--bg-sunken); font-size: var(--text-sm); min-width: 0; }
  .feed .from { color: var(--text-secondary); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .feed .to { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .feed .arrow { color: var(--accent-text); }
  .backup { display: flex; align-items: center; gap: 6px; }
  .backup :global(.icon) { color: var(--success-text); flex: none; }
  .sub { display: block; font-weight: 400; font-size: var(--text-sm); color: var(--text-secondary); margin-top: 2px; }
  .sub.bad { color: var(--danger-text); }
  .policy { min-width: 0; }
  .policy legend { float: left; width: 100%; padding: 10px var(--space-4) 0; margin: 0; }
  .policy legend + .row-item { clear: both; }
  .policy .row-item { display: flex; align-items: center; gap: var(--space-2); }
  .policy .row-item:first-of-type { border-top: 0; }
  .check span { font-weight: 500; }
  .check input[type='radio'] { width: 16px; height: 16px; margin: 0; }
  @media (max-width: 860px) { .cols, .live-grid.two { grid-template-columns: minmax(0, 1fr); } }
  @media (max-width: 720px) { .facts.four { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 520px) { .facts, .facts.four { grid-template-columns: minmax(0, 1fr); gap: var(--space-2); } }
</style>
