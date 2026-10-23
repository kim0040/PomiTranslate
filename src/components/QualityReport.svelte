<script lang="ts">
  import { untrack } from 'svelte';
  import { app } from '../lib/app.svelte';
  import type { GlossaryEntry, GlossaryScope, TranslationWarningSample } from '../lib/api';
  import { hasMessage, t, type MessageKey } from '../lib/i18n/index.svelte';
  import { formatNumber } from '../lib/format';
  import { entryForSample, loadGlossary, shownWarningSamples, warningRows, warningTotal } from '../lib/glossary';

  // Quality warnings of a finished run: how many sentences missed a glossary rule or left a format
  // code's letters behind, and a few examples. They never stopped the translation.
  let { counts, samples }: { counts: Record<string, number> | undefined; samples: TranslationWarningSample[] | undefined } = $props();

  const rows = $derived(warningRows(counts));
  const total = $derived(warningTotal(counts));
  const examples = $derived(shownWarningSamples(samples));
  let entries = $state<Partial<Record<GlossaryScope, GlossaryEntry[]>>>({});
  let loaded = $state(false);

  // Which rule a sample missed is looked up in the glossary as it is now (the list the warning names: global or this world).
  $effect(() => {
    if (!examples.some((sample) => sample.entryId)) return;
    const world = app.worldDir;
    untrack(() => {
      void (async () => {
        const found: Partial<Record<GlossaryScope, GlossaryEntry[]>> = {};
        for (const scope of world ? (['world', 'global'] as const) : (['global'] as const)) {
          try { found[scope] = (await loadGlossary(scope, world)).entries; } catch { /* the sample then says the entry is gone */ }
        }
        entries = found;
        loaded = true;
      })();
    });
  });

  const label = (code: string): string => (hasMessage(`quality.code.${code}`) ? t(`quality.code.${code}` as MessageKey) : code);
  const explain = (code: string): string => (hasMessage(`quality.explain.${code}`) ? t(`quality.explain.${code}` as MessageKey) : '');

  function missed(sample: TranslationWarningSample): string {
    if (sample.code !== 'glossary_mismatch') return explain(sample.code);
    const entry = entryForSample(entries, sample);
    if (!entry) return loaded || !sample.entryId ? t('quality.missed.entryGone') : '';
    return entry.mode === 'keep' ? t('quality.missed.keep', { source: entry.source }) : t('quality.missed.translate', { source: entry.source, target: entry.target });
  }
</script>

{#if total > 0}
  <section class="card quality" aria-labelledby="quality-title">
    <h2 id="quality-title">{t('quality.result.title')}</h2>
    <p class="muted">{t('quality.result.lead')}</p>
    <ul class="lines counts">
      {#each rows as row (row.code)}
        <li><strong class="num">{formatNumber(row.count, app.locale)}</strong><span>{label(row.code)}</span>{#if explain(row.code)}<span class="muted">{explain(row.code)}</span>{/if}</li>
      {/each}
    </ul>
    {#if examples.length}
      <p class="muted">{t('quality.result.samples', { shown: formatNumber(examples.length, app.locale), total: formatNumber(total, app.locale) })}</p>
      <table>
        <thead><tr><th scope="col">{t('result.before')}</th><th scope="col">{t('result.after')}</th></tr></thead>
        <tbody>
          {#each examples as sample, index (index)}
            <tr><td lang="en">{sample.source}</td><td>{sample.translated}</td></tr>
            {#if missed(sample)}<tr class="why"><td colspan="2">{missed(sample)}</td></tr>{/if}
          {/each}
        </tbody>
      </table>
    {/if}
    <div><button type="button" class="btn btn-secondary btn-sm" onclick={() => app.goto('glossary')}>{t('quality.openGlossary')}</button></div>
  </section>
{/if}

<style>
  .quality { padding: var(--space-4); display: grid; gap: var(--space-3); }
  .quality h2 { font-size: var(--text-lg); font-weight: 600; }
  p { margin: 0; }
  .lines { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); font-size: var(--text-sm); }
  .lines li { display: grid; gap: 2px; padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--bg-sunken); overflow-wrap: anywhere; }
  table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
  th { text-align: start; font-size: var(--text-overline); font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-secondary); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border); }
  td { padding: var(--space-3); border-bottom: 1px solid var(--border); vertical-align: top; overflow-wrap: anywhere; width: 50%; }
  tr:not(.why) td:first-child { color: var(--text-secondary); }
  tr:has(+ .why) td { border-bottom: 0; padding-bottom: 0; }
  .why td { width: auto; padding-top: var(--space-1); color: var(--warning-text); font-size: var(--text-xs); }
</style>
