<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import { formatNumber } from '../lib/format';
  import type { ChunkCoverage, ChunkCoverageEntry, ChunkStatus } from '../lib/api';
  import { compressionName, dimension, fileNotes, leftOutChunks, leftOutFiles, needsNewerConfirmation, versionSummary, type FileNote } from '../lib/chunk-coverage';
  import Icon from './Icon.svelte';
  import Pill from './Pill.svelte';

  // What the scan saw chunk by chunk. The full card on the scan screen; `compact` is the one line the review header has room for.
  let { coverage, compact = false }: { coverage: ChunkCoverage; compact?: boolean } = $props();

  const summary = $derived(versionSummary(coverage));
  const newer = $derived(needsNewerConfirmation(coverage));
  const number = (value: number) => formatNumber(value, app.locale);
  const levelText = $derived(coverage.levelDataVersion === null ? t('chunks.unknown') : String(coverage.levelDataVersion));
  const versionText = $derived.by(() => {
    if (summary.kind === 'none') return t('chunks.v.none');
    if (summary.kind === 'unversioned') return t('chunks.v.unversioned');
    if (summary.kind === 'single') return String(summary.version);
    const range = summary.min !== null && summary.max !== null ? t('chunks.v.range', { min: summary.min, max: summary.max }) : '';
    return range ? `${t('chunks.v.mixed')} · ${range}` : t('chunks.v.mixed');
  });
  const statuses: ChunkStatus[] = ['processed', 'skipped_unsupported', 'unreadable', 'not_inspected'];
  const shown = $derived(statuses.filter((status) => status === 'processed' || coverage.counts[status] > 0));
  const tone = (status: ChunkStatus) => (status === 'processed' ? 'success' : 'warning');
  const statusLabel = (status: ChunkStatus) => t(`chunks.status.${status}` as MessageKey);
  const notes = $derived(fileNotes(coverage));
  const noteText = (note: FileNote & { count: number }) =>
    note.kind === 'detected'
      ? t('chunks.files.detected', { count: number(note.count), kind: note.format })
      : t(note.kind === 'unreadable' ? 'chunks.files.unreadable' : 'chunks.files.notInspected', { count: number(note.count) });
  const leftOut = $derived(leftOutChunks(coverage));
  const dimensionText = (id: string) => {
    const named = dimension(id);
    return named.known ? t(`chunks.dim.${named.known}` as MessageKey) : named.id;
  };
  const kindText = (kind: string) => (kind === 'region' || kind === 'entities' ? t(`chunks.kind.${kind}` as MessageKey) : kind);
  const versionLabel = (item: { state: string; dataVersion: number | null }) =>
    item.state === 'known' && item.dataVersion !== null ? String(item.dataVersion)
      : item.state === 'missing' ? t('chunks.version.missing') : t('chunks.version.unobserved');
  const isNewer = (item: ChunkCoverageEntry | { dataVersion: number | null }) =>
    item.dataVersion !== null && item.dataVersion > coverage.newestCovered;
</script>

{#if compact}
  <!-- One line in the review header: the version range, and a warning only when something needs it. -->
  <p class="compact" data-testid="chunk-coverage-compact">
    <Icon name="info" size={14} />
    <span>{t('chunks.versions')}: <strong class="num">{versionText}</strong></span>
    {#if newer}<Pill tone="warning" dot>{t('chunks.flag.newer')}</Pill>{/if}
    {#if leftOut > 0 || leftOutFiles(coverage) > 0}<Pill tone="warning" dot>{t('chunks.leftOut', { count: number(leftOut) })}</Pill>{/if}
  </p>
{:else}
  <section class="card chunks" aria-labelledby="chunks-title" data-testid="chunk-coverage">
    <h2 id="chunks-title" class="section-title">{t('chunks.title')}</h2>
    <p class="muted">{t('chunks.lead')}</p>
    <dl class="facts">
      <div><dt>{t('chunks.level')}</dt><dd class="num" data-testid="chunk-level">{levelText}</dd></div>
      <div>
        <dt>{t('chunks.versions')}</dt>
        <dd class="num" data-testid="chunk-versions">
          {versionText}
          {#if newer}<Pill tone="warning" dot>{t('chunks.flag.newer')}</Pill>{/if}
          {#if coverage.flags.missing && summary.kind !== 'unversioned'}<Pill tone="neutral">{t('chunks.flag.missing')}</Pill>{/if}
        </dd>
      </div>
    </dl>
    <ul class="counts" aria-label={t('chunks.title')}>
      {#each shown as status (status)}
        <li data-status={status}><Pill tone={tone(status)} dot>{statusLabel(status)} <span class="num">{number(coverage.counts[status])}</span></Pill></li>
      {/each}
    </ul>
    {#if notes.length}
      <ul class="notes">
        {#each notes as note (note.kind + ('format' in note ? note.format : ''))}<li><Icon name="minus" size={14} /> <span>{noteText(note)}</span></li>{/each}
      </ul>
    {/if}
    {#if coverage.partial}<p class="muted">{t('chunks.partial')}</p>{/if}

    {#if coverage.chunkVersions.distribution.length || coverage.groups.some((group) => group.entries.length)}
      <details class="more">
        <summary><span>{t('chunks.details')}</span><Icon name="chevron-down" size={16} /></summary>
        {#if coverage.chunkVersions.distribution.length}
          <h3>{t('chunks.distribution')}</h3>
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <div class="scroll" role="region" aria-label={t('chunks.distribution')} tabindex="0">
            <table>
              <thead><tr><th scope="col">{t('chunks.table.version')}</th><th scope="col" class="r">{t('chunks.table.chunks')}</th></tr></thead>
              <tbody>
                {#each coverage.chunkVersions.distribution as item (item.state + String(item.dataVersion))}
                  <tr>
                    <td class="num">{versionLabel(item)}{#if isNewer(item)} <span class="tag">{t('chunks.tag.newer')}</span>{/if}</td>
                    <td class="num r">{number(item.count)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
        {#each coverage.groups.filter((group) => group.entries.length) as group (group.dimension + group.kind)}
          <h3>{dimensionText(group.dimension)} · {kindText(group.kind)}</h3>
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <div class="scroll" role="region" aria-label="{dimensionText(group.dimension)} · {kindText(group.kind)}" tabindex="0">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('chunks.table.version')}</th>
                  <th scope="col">{t('chunks.table.compression')}</th>
                  <th scope="col">{t('chunks.table.status')}</th>
                  <th scope="col" class="r">{t('chunks.table.chunks')}</th>
                </tr>
              </thead>
              <tbody>
                {#each group.entries as entry (entry.state + String(entry.dataVersion) + String(entry.compression) + entry.status)}
                  <tr>
                    <td class="num">{versionLabel(entry)}{#if isNewer(entry)} <span class="tag">{t('chunks.tag.newer')}</span>{/if}</td>
                    <td>{compressionName(entry.compression)}</td>
                    <td>{statusLabel(entry.status)}</td>
                    <td class="num r">{number(entry.count)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/each}
      </details>
    {/if}
  </section>
{/if}

<style>
  .compact { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); margin: 0; font-size: var(--text-sm); color: var(--text-secondary); }
  .compact :global(.icon) { flex: none; }
  .chunks { padding: var(--space-4) var(--space-5); display: grid; gap: var(--space-3); }
  .chunks .section-title { margin: 0; }
  .chunks p { margin: 0; }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-3) var(--space-6); margin: 0; }
  .facts dt { font-size: var(--text-xs); color: var(--text-secondary); }
  .facts dd { margin: 2px 0 0; font-weight: 600; display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
  .counts, .notes { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-3); }
  .notes { flex-direction: column; gap: var(--space-1); font-size: var(--text-sm); color: var(--text-secondary); }
  .notes li { display: flex; gap: var(--space-2); align-items: flex-start; }
  .notes li > :global(.icon) { margin-top: 2px; flex: none; }
  .more > summary { display: flex; align-items: center; gap: var(--space-3); list-style: none; cursor: default; font-weight: 600; border-radius: var(--radius-md); }
  .more > summary::-webkit-details-marker { display: none; }
  .more > summary :global(.icon) { color: var(--text-secondary); transition: rotate var(--dur-base) var(--ease); }
  .more[open] > summary :global(.icon) { rotate: 180deg; }
  .more h3 { font-size: var(--text-sm); margin: var(--space-4) 0 var(--space-2); }
  .scroll { max-height: 16rem; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-md); }
  table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
  th, td { text-align: start; padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border); }
  th { position: sticky; top: 0; background: var(--bg-sunken); font-weight: 600; color: var(--text-secondary); }
  tr:last-child td { border-bottom: 0; }
  .r { text-align: end; }
  .tag { display: inline-block; margin-inline-start: var(--space-2); padding: 1px 8px; border-radius: var(--radius-full); background: var(--warning-soft, var(--bg-sunken)); color: var(--text-secondary); font-size: var(--text-xs); font-weight: 600; }
</style>
