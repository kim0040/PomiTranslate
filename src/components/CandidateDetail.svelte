<script lang="ts">
  import { app } from '../lib/app.svelte';
  import type { Candidate } from '../lib/api';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import { describeDetail, describeLocation, formatNumber, rawLocation, teleportCommand } from '../lib/format';
  import Icon from './Icon.svelte';

  let { candidate, onClose, onQuickAdd, showHeading = true }: { candidate: Candidate | null; onClose?: () => void; onQuickAdd?: (source: string, target: string) => void; showHeading?: boolean } = $props();

  const included = $derived(candidate ? !app.excluded.has(candidate.id) : false);
  const manual = $derived(candidate ? app.manualTranslation(candidate) : '');
  const tokens = $derived.by(() => {
    if (!candidate) return [];
    const found = candidate.source.match(/§.|%(?:\d+\$)?[sdif]|\{[A-Za-z0-9_]+\}/g) ?? [];
    return [...new Set(found)];
  });
  const kinds = $derived(candidate ? Object.entries(candidate.kinds ?? { [candidate.kind]: candidate.occurrences }) : []);
  const shown = $derived(candidate?.locations ?? []);

  async function copyTeleport(location: NonNullable<Candidate['locations']>[number]): Promise<void> {
    const command = teleportCommand(location);
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      app.notify(t('review.detail.teleportCopied'), 'success');
    } catch {
      app.notify(t('review.detail.teleportCopyFailed'), 'error');
    }
  }
</script>

<aside class="detail" aria-label={t('review.detail.title')}>
  {#if !candidate}
    <div class="blank">
      <Icon name="list" size={28} />
      <p>{t('review.detail.empty')}</p>
    </div>
  {:else}
    {#if showHeading}<header class="top">
      <h2>{t('review.detail.title')}</h2>
      {#if onClose}<button type="button" class="btn btn-quiet btn-icon btn-sm" aria-label={t('review.detail.close')} onclick={onClose}><Icon name="x" size={18} /></button>{/if}
    </header>{/if}

    <section class="block">
      <h3>{t('review.detail.source')}</h3>
      <p class="source" translate="no">{candidate.source}</p>
      {#if onQuickAdd}
        <button type="button" class="btn btn-secondary btn-sm glossary-add" onclick={() => onQuickAdd(candidate.source, manual)}>
          <Icon name="plus" size={14} /> {t('glossary.quickAdd')}
        </button>
      {/if}
      {#if tokens.length}
        <p class="tokens" role="note">
          {#each tokens as token (token)}<code>{token}</code>{/each}
          <span>{t('review.detail.codes')}</span>
        </p>
      {/if}
    </section>

    <section class="block">
      <label class="check">
        <input type="checkbox" checked={included} onchange={(event) => app.setIncluded(candidate.id, event.currentTarget.checked)} />
        <span class="label">{t('review.detail.include')}</span>
      </label>
    </section>

    <section class="block">
      <h3><label for="manual-translation">{t('review.detail.manual')}</label></h3>
      <textarea
        id="manual-translation"
        class="textarea"
        rows="4"
        value={manual}
        disabled={!included}
        placeholder={t('review.detail.manualPlaceholder')}
        aria-describedby="manual-help"
        oninput={(event) => app.setOverride(candidate.id, event.currentTarget.value)}
      ></textarea>
      <p id="manual-help" class="hint">{t('review.detail.manualHelp')}</p>
      {#if manual}
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
          <li title={rawLocation(location)}>
            <div class="place-copy">
              <span class="mono">{describeLocation(location, app.locale, candidate.kind)}</span>
              {#if describeDetail(location.detail, app.locale)}<span class="muted">{describeDetail(location.detail, app.locale)}</span>{/if}
            </div>
            {#if location.pos}
              <button type="button" class="btn btn-quiet btn-sm teleport" aria-label={t('review.detail.teleportCopy')} onclick={() => copyTeleport(location)}>
                <Icon name="copy" size={13} /> {t('review.detail.teleportCopy')}
              </button>
            {/if}
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
  .detail { display: grid; align-content: start; gap: var(--space-4); padding: var(--space-4); overflow: auto; height: 100%; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-lg); }
  .blank { display: grid; justify-items: center; align-content: center; gap: var(--space-3); min-height: 240px; padding: var(--space-5); text-align: center; color: var(--text-secondary); }
  .top { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
  .top h2 { font-size: var(--text-lg); }
  .block { display: grid; gap: var(--space-2); }
  h3 { font-size: var(--text-xs); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-secondary); }
  h3 label { cursor: pointer; }
  .source { margin: 0; padding: var(--space-3); border-radius: var(--radius-md); background: var(--bg-sunken); white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; max-height: 220px; overflow: auto; font-size: var(--text-md); }
  .tokens { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); font-size: var(--text-xs); color: var(--text-secondary); margin: 0; }
  .tokens code { padding: 1px 6px; border-radius: 4px; background: var(--warning-soft); color: var(--warning-text); font-weight: 700; }
  .kinds, .places { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
  .kinds li { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); }
  .places { font-size: var(--text-xs); }
  .places li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--bg-sunken); overflow-wrap: anywhere; }
  .place-copy { min-width: 0; display: grid; gap: 2px; }
  .teleport { flex: none; }
  @media (max-width: 480px) { .places li { align-items: flex-start; flex-direction: column; } }
</style>
