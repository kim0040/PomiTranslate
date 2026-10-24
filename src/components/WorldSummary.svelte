<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import { formatDate, formatNumber } from '../lib/format';
  import { resultPresentation } from '../lib/workflow';
  import { landingSummary } from '../lib/landing';

  // Where the last visit left off, from what the app already holds: nothing is read or started here.
  let { resume = true, showEmpty = true }: { resume?: boolean; showEmpty?: boolean } = $props();

  const summary = $derived(landingSummary({
    scan: app.scan, scanAt: app.scanAt, result: app.result, resultAt: app.resultAt, backups: app.backups, resume: app.resume,
    lastScan: app.lastScan, lastJob: app.lastJob
  }));
  const dateText = (at: number) => (at > 0 ? formatDate(new Date(at).toISOString(), app.locale) : '');
  const scanText = $derived.by(() => {
    if (!summary.scan) return '';
    const count = formatNumber(summary.scan.count, app.locale);
    const when = dateText(summary.scan.at);
    return when ? t('landing.scan.value', { date: when, count }) : t('landing.scan.undated', { count });
  });
  const translationText = $derived.by(() => {
    const item = summary.translation;
    if (!item) return '';
    const parts = [item.kind === 'result'
      ? t(`landing.status.${resultPresentation(item.status).status}` as MessageKey)
      : t('landing.backup')];
    const when = dateText(item.at);
    if (when) parts.push(when);
    parts.push(t(item.kind === 'result' ? 'landing.files.changed' : 'landing.files.backup', { count: formatNumber(item.files, app.locale) }));
    return parts.join(' · ');
  });
  const resumeText = $derived(resume && summary.resume ? t('landing.resume.value', { count: formatNumber(summary.resume.translated, app.locale) }) : '');
  const empty = $derived(!scanText && !translationText && !resumeText);
</script>

{#if empty}
  {#if showEmpty}<p class="summary-empty">{t('landing.nothing')}</p>{/if}
{:else}
  <dl class="summary">
    {#if scanText}<div><dt>{t('landing.scan.label')}</dt><dd class="num">{scanText}</dd></div>{/if}
    {#if translationText}<div><dt>{t('landing.translation.label')}</dt><dd class="num">{translationText}</dd></div>{/if}
    {#if resumeText}<div><dt>{t('landing.resume.label')}</dt><dd>{resumeText}</dd></div>{/if}
  </dl>
{/if}

<style>
  .summary { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px var(--space-3); margin: var(--space-3) 0 0; font-size: var(--text-sm); align-items: baseline; }
  .summary > div { display: contents; }
  dt { color: var(--text-secondary); }
  dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .summary-empty { margin: var(--space-3) 0 0; font-size: var(--text-sm); color: var(--text-secondary); text-wrap: pretty; }
  @media (max-width: 520px) { .summary { grid-template-columns: minmax(0, 1fr); gap: 0; } dd { margin-block-end: var(--space-1); } }
</style>
