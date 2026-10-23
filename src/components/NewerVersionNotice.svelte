<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { t } from '../lib/i18n/index.svelte';
  import Callout from './Callout.svelte';

  // The scan met chunks saved by a newer game version than this app has been tested with. Writing is still
  // allowed (a backup is always made), but only after one explicit confirmation per scan: `confirm` asks for it.
  let { confirm = false }: { confirm?: boolean } = $props();
  const coverage = $derived(app.scan?.chunkCoverage);
</script>

{#if coverage}
  <Callout tone="warning" title={t('chunks.newer.title')} role={confirm ? undefined : 'status'}>
    <p data-testid="newer-version-notice">{t('chunks.newer.body', { newest: coverage.newestCovered, max: coverage.chunkVersions.max ?? '?' })}</p>
    {#if confirm}
      <label class="ack">
        <input type="checkbox" bind:checked={app.newerAccepted} disabled={app.isBusy} />
        <span>{t('chunks.newer.confirm')}</span>
      </label>
      {#if !app.newerAccepted}<p class="need">{t('chunks.newer.required')}</p>{/if}
    {:else}
      <p class="need">{t('chunks.newer.scanNote')}</p>
    {/if}
  </Callout>
{/if}

<style>
  p { margin: 0; }
  .ack { display: flex; gap: var(--space-2); align-items: flex-start; margin-top: var(--space-3); font-weight: 600; }
  .ack input { margin-top: 3px; flex: none; }
  .need { margin-top: var(--space-2); font-size: var(--text-sm); }
</style>
