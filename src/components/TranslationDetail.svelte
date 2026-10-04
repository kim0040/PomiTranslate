<script lang="ts">
  import { app } from '../lib/app.svelte';
  import type { TranslationRow } from '../lib/api';
  import type { TranslationReview } from '../lib/translation-review.svelte';
  import { editReasonKey, failureKey } from '../lib/failures';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import { formatNumber } from '../lib/format';
  import Icon from './Icon.svelte';

  let { review, row, onQuickAdd, showHeading = true }: { review: TranslationReview; row: TranslationRow | null; onQuickAdd?: (source: string, target: string) => void; showHeading?: boolean } = $props();

  const shown = $derived(row ? review.display(row) : null);
  const problem = $derived(row ? review.reasonFor(row.id) : '');
  const tokens = $derived.by(() => {
    if (!row) return [];
    const found = row.source.match(/§.|%(?:\d+\$)?[sdif]|\{[A-Za-z0-9_]+\}/g) ?? [];
    return [...new Set(found)];
  });
  const statusKey: Record<TranslationRow['status'], MessageKey> = {
    translated: 'translationReview.state.translated.label',
    failed: 'translationReview.state.failed.label',
    kept: 'translationReview.state.kept.label',
    edited: 'translationReview.state.edited.label',
    glossary_mismatch: 'translationReview.state.glossaryMismatch'
  };
  const statusPill: Record<TranslationRow['status'], string> = { translated: 'pill-success', failed: 'pill-danger', kept: '', edited: 'pill-accent', glossary_mismatch: 'pill-warning' };
</script>

<aside class="detail" aria-label={t('translationReview.detail.title')}>
  {#if !row || !shown}
    <div class="blank">
      <Icon name="list" size={28} />
      <p>{t('translationReview.detail.empty')}</p>
    </div>
  {:else}
    {#if showHeading}<header class="top"><h2>{t('translationReview.detail.title')}</h2></header>{/if}

    <section class="block">
      <h3>{t('review.detail.source')}</h3>
      <p class="source" translate="no">{row.source}</p>
      {#if onQuickAdd}
        <button type="button" class="btn btn-secondary btn-sm revert" onclick={() => onQuickAdd(row.source, shown.text)}>
          <Icon name="plus" size={14} /> {t('glossary.quickAdd')}
        </button>
      {/if}
      {#if tokens.length}
        <p class="tokens" role="note">
          {#each tokens as token (token)}<code>{token}</code>{/each}
          <span>{t('translationReview.detail.codes')}</span>
        </p>
      {/if}
    </section>

    {#if row.status === 'failed' && !review.drafts[row.id]}
      <section class="block failed" aria-label={t('translationReview.state.failed.label')}>
        <p class="why"><Icon name="alert-circle" size={16} /> <span>{t(failureKey(row.reason))}</span></p>
        {#if row.detail}
          <details>
            <summary>{t('failure.details')}</summary>
            <p class="raw mono">{row.detail}</p>
          </details>
        {/if}
      </section>
    {/if}

    {#if row.glossaryMismatch}
      <p class="mismatch" role="note"><Icon name="alert-triangle" size={15} /> {t('glossary.mismatchHelp')}</p>
    {/if}
    {#if row.glossaryStale}
      <p class="mismatch" role="note">{t('glossary.changedHelp', { count: 1 })}</p>
    {/if}

    <section class="block">
      <div class="label-row">
        <h3><label for="translation-edit">{t('translationReview.detail.translation')}</label></h3>
        {#if row.edited || shown.status === 'edited'}<span class="pill pill-accent">{t(statusKey.edited)}</span>{/if}
        {#if row.glossaryMismatch}<span class="pill pill-warning">{t(statusKey.glossary_mismatch)}</span>{/if}
        {#if !row.edited && !row.glossaryMismatch && shown.status !== 'edited'}<span class="pill {statusPill[shown.status]}">{t(statusKey[shown.status])}</span>{/if}
      </div>
      <textarea
        id="translation-edit"
        class="textarea"
        rows="5"
        value={shown.text}
        placeholder={t('translationReview.detail.placeholder')}
        aria-invalid={problem ? 'true' : undefined}
        aria-describedby={problem ? 'translation-error translation-help' : 'translation-help'}
        oninput={(event) => review.setDraft(row, event.currentTarget.value)}
      ></textarea>
      {#if problem}
        <p id="translation-error" class="error" role="alert"><Icon name="alert-triangle" size={14} /> {t(editReasonKey(problem))}</p>
      {/if}
      <p id="translation-help" class="hint">{t('translationReview.detail.help')}</p>
      {#if review.canRevert(row)}
        <button type="button" class="btn btn-quiet btn-sm revert" onclick={() => review.revert(row)}>
          <Icon name="undo" size={16} /> {t('translationReview.detail.revert')}
        </button>
      {/if}
    </section>

    <section class="block">
      <h3>{t('review.detail.places')}</h3>
      <ul class="kinds">
        <li><span class="pill">{t(`kind.${row.kind}` as MessageKey)}</span><span class="num muted">{t('common.places', { count: formatNumber(row.occurrences, app.locale) })}</span></li>
      </ul>
    </section>
  {/if}
</aside>

<style>
  .detail { display: grid; align-content: start; gap: var(--space-4); padding: var(--space-4); overflow: auto; height: 100%; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-lg); }
  .blank { display: grid; justify-items: center; align-content: center; gap: var(--space-3); min-height: 240px; padding: var(--space-5); text-align: center; color: var(--text-secondary); }
  .top h2 { font-size: var(--text-lg); }
  .block { display: grid; gap: var(--space-2); }
  h3 { font-size: var(--text-xs); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-secondary); }
  h3 label { cursor: pointer; }
  .label-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
  .source { margin: 0; padding: var(--space-3); border-radius: var(--radius-md); background: var(--bg-sunken); white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; max-height: 180px; overflow: auto; font-size: var(--text-md); }
  .tokens { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); font-size: var(--text-xs); color: var(--text-secondary); margin: 0; }
  .tokens code { padding: 1px 6px; border-radius: 4px; background: var(--warning-soft); color: var(--warning-text); font-weight: 700; }
  .failed { padding: var(--space-3); border-radius: var(--radius-md); background: var(--danger-soft); color: var(--danger-text); }
  .mismatch { display: flex; align-items: flex-start; gap: var(--space-2); margin: 0; padding: var(--space-3); border-radius: var(--radius-md); background: var(--warning-soft); color: var(--warning-text); font-size: var(--text-sm); }
  .mismatch :global(.icon) { flex: none; margin-top: 1px; }
  .why { display: flex; align-items: flex-start; gap: var(--space-2); margin: 0; font-weight: 600; font-size: var(--text-sm); }
  .why :global(.icon) { margin-top: 1px; }
  details { font-size: var(--text-sm); }
  summary { cursor: pointer; font-weight: 600; }
  .raw { margin: var(--space-2) 0 0; padding: var(--space-2); border-radius: var(--radius-sm); background: var(--bg-surface); color: var(--text); font-size: var(--text-xs); overflow-wrap: anywhere; white-space: pre-wrap; }
  textarea[aria-invalid='true'] { border-color: var(--danger-solid); }
  .error { display: flex; align-items: flex-start; gap: 6px; margin: 0; color: var(--danger-text); font-size: var(--text-sm); font-weight: 600; }
  .error :global(.icon) { margin-top: 2px; }
  .revert { justify-self: start; }
  .kinds { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
  .kinds li { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); }
</style>
