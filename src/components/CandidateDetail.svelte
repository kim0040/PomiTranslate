<script lang="ts">
  import { app } from '../lib/app.svelte';
  import type { Candidate } from '../lib/api';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import { describeDetail, describeLocation, formatNumber } from '../lib/format';
  import Icon from './Icon.svelte';
  import { compareTokens, tokenCounts } from '../lib/tokens';
  import { counterState, effectiveOverride, MAX_MANUAL_LENGTH } from '../lib/review';

  let { candidate, onClose, showHeading = true }: { candidate: Candidate | null; onClose?: () => void; showHeading?: boolean } = $props();

  const included = $derived(candidate ? !app.excluded.has(candidate.id) : false);
  const manual = $derived(candidate ? app.manualTranslation(candidate) : '');
  // The same grammar the core checks (see lib/tokens.ts), so the note and the warning below agree with it.
  const tokens = $derived(candidate ? [...tokenCounts(candidate.source).values()].map((entry) => entry.shown) : []);
  const typed = $derived(effectiveOverride(manual));
  // Warn while typing, before the core would have refused the translation and kept the original.
  const tokenReport = $derived(candidate && typed ? compareTokens(candidate.source, typed) : null);
  const length = $derived(manual.length);
  const counter = $derived(counterState(length));
  const kinds = $derived(candidate ? Object.entries(candidate.kinds ?? { [candidate.kind]: candidate.occurrences }) : []);
  const shown = $derived(candidate?.locations ?? []);
</script>

<aside class="detail" aria-label={t('review.detail.title')}>
  {#if !candidate}
    <div class="blank">
      <Icon name="list" size={28} />
      <p>{t('review.detail.empty')}</p>
    </div>
  {:else}
    <!-- Pinned: what this is and whether it is part of the translation stay in view while the rest scrolls. -->
    <header class="top">
      {#if showHeading}<h2>{t('review.detail.title')}</h2>{/if}
      <label class="check include">
        <input type="checkbox" checked={included} onchange={(event) => app.setIncluded(candidate.id, event.currentTarget.checked)} />
        <span class="label">{t('review.detail.include')}</span>
      </label>
      {#if onClose}<button type="button" class="btn btn-quiet btn-icon btn-sm" aria-label={t('review.detail.close')} onclick={onClose}><Icon name="x" size={18} /></button>{/if}
    </header>

    <section class="block">
      <h3>{t('review.detail.source')}</h3>
      <p class="source" lang="en">{candidate.source}</p>
      {#if tokens.length}
        <p class="tokens" role="note">
          {#each tokens as token (token)}<code>{token}</code>{/each}
          <span>{t('review.detail.codes')}</span>
        </p>
      {/if}
    </section>

    <section class="block">
      <h3><label for="manual-translation">{t('review.detail.manual')}</label></h3>
      <textarea
        id="manual-translation"
        class="textarea"
        rows="3"
        value={manual}
        maxlength={MAX_MANUAL_LENGTH}
        disabled={!included}
        placeholder={t('review.detail.manualPlaceholder')}
        aria-describedby="manual-help manual-counter manual-token-warning"
        oninput={(event) => app.setOverride(candidate.id, event.currentTarget.value)}
        onblur={(event) => {
          // Leaving the box commits the trimmed text; whitespace alone stops being an override.
          const value = event.currentTarget.value;
          if (value !== value.trim()) app.setOverride(candidate.id, value.trim());
        }}
      ></textarea>
      <p id="manual-counter" class="counter num {counter}" aria-live="off">{t('review.detail.counter', { count: formatNumber(length, app.locale), max: formatNumber(MAX_MANUAL_LENGTH, app.locale) })}</p>
      <p id="manual-help" class="hint">{t('review.detail.manualHelp')}</p>
      <div id="manual-token-warning" role="status" aria-live="polite">
        {#if tokenReport && !tokenReport.ok}
          <p class="token-warning">
            <Icon name="alert-triangle" size={14} />
            <span>
              {#if tokenReport.lost.length}{t('review.detail.tokensLost')} {#each tokenReport.lost as token, index (index)}<code>{token}</code>{/each}{/if}
              {#if tokenReport.added.length}{t('review.detail.tokensAdded')} {#each tokenReport.added as token, index (index)}<code>{token}</code>{/each}{/if}
              {t('review.detail.tokensConsequence')}
            </span>
          </p>
        {/if}
      </div>
      {#if manual.length}
        <button type="button" class="btn btn-quiet btn-sm" onclick={() => app.setOverride(candidate.id, '')}>
          <Icon name="undo" size={16} /> {t('review.detail.clearManual')}
        </button>
      {/if}
    </section>

    <section class="block">
      <h3>{t('review.detail.places')}</h3>
      <ul class="kinds">
        {#each kinds as [kind, count] (kind)}
          <li><span class="pill">{t(`kind.${kind}` as MessageKey)}</span><span class="num muted">{t('common.places', { count: formatNumber(count, app.locale) })}</span></li>
        {/each}
      </ul>
      <ul class="places">
        {#each shown as location, index (index)}
          <li>
            <span class="mono">{describeLocation(location, app.locale)}</span>
            {#if describeDetail(location.detail, app.locale)}<span class="muted"> · {describeDetail(location.detail, app.locale)}</span>{/if}
          </li>
        {/each}
      </ul>
      {#if candidate.occurrences > shown.length}
        <p class="hint">{t('review.detail.placesTotal', { count: formatNumber(candidate.occurrences, app.locale) })}</p>
      {/if}
    </section>
  {/if}
</aside>

<style>
  .detail { display: grid; align-content: start; gap: var(--space-4); padding: 0 var(--space-4) var(--space-4); overflow: auto; height: 100%; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-xl); box-shadow: var(--shadow-card); container-type: inline-size; }
  .blank { display: grid; justify-items: center; align-content: center; gap: var(--space-3); min-height: 240px; padding: var(--space-5); text-align: center; color: var(--text-secondary); }
  .top { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: var(--space-3); min-height: 44px; margin: 0 calc(-1 * var(--space-4)); padding: var(--space-2) var(--space-4); background: var(--bg-surface); border-bottom: 1px solid var(--border); }
  .top h2 { font-size: var(--text-lg); font-weight: 600; margin-inline-end: auto; white-space: nowrap; }
  @container (max-width: 380px) { .top h2 { display: none; } }
  .top .include { margin-inline-start: auto; align-items: center; }
  .top h2 + .include { margin-inline-start: 0; }
  .top .check .label { font-weight: 500; font-size: var(--text-sm); }
  .block { display: grid; gap: var(--space-2); }
  h3 { font-size: var(--text-overline); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-secondary); }
  h3 label { cursor: pointer; }
  .source { margin: 0; padding: var(--space-3); border-radius: var(--radius-md); background: var(--bg-sunken); white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; max-height: 160px; overflow: auto; font-size: var(--text-md); }
  .tokens { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); font-size: var(--text-xs); color: var(--text-secondary); margin: 0; }
  .tokens code { padding: 1px 6px; border-radius: 4px; background: var(--warning-soft); color: var(--warning-text); font-weight: 700; }
  .counter { margin: 0; font-size: var(--text-xs); color: var(--text-secondary); text-align: end; }
  .counter.near { color: var(--warning-text); }
  .counter.full { color: var(--danger-text); font-weight: 700; }
  .token-warning { display: flex; gap: var(--space-2); align-items: flex-start; margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--warning-soft); color: var(--warning-text); font-size: var(--text-sm); }
  .token-warning code { margin-inline: 2px; padding: 0 4px; border-radius: 4px; background: color-mix(in srgb, currentColor 14%, transparent); font-weight: 700; }
  .kinds, .places { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
  .kinds li { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); }
  .places { font-size: var(--text-xs); }
  .places li { padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--bg-sunken); overflow-wrap: anywhere; }
</style>
