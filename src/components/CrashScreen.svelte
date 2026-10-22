<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { t } from '../lib/i18n/index.svelte';
  import Callout from './Callout.svelte';

  // Shown by the error boundary in App.svelte when drawing the app itself failed. It must not depend
  // on anything that could be what failed: the catalog and the app state only.
  let { reset }: { reset: () => void } = $props();

  function openHelp(): void {
    app.page = 'help';
    reset();
  }
</script>

<main class="crash" id="main-content" tabindex="-1">
  <Callout tone="danger" title={t('crash.title')} role="alert">
    <p>{t('crash.body')}</p>
    {#if app.lastError}<p class="id">{t('error.id', { id: app.lastError.id })}</p>{/if}
    {#snippet actions()}
      <button type="button" class="btn btn-primary" data-autofocus onclick={reset}>{t('common.retry')}</button>
      <button type="button" class="btn btn-secondary" onclick={() => app.copyDiagnostics()}>{t('diagnostics.copy')}</button>
      <button type="button" class="btn btn-secondary" onclick={openHelp}>{t('startup.openHelp')}</button>
    {/snippet}
  </Callout>
</main>

<style>
  .crash { min-height: 100dvh; display: grid; align-content: center; justify-items: center; padding: var(--space-5); }
  .crash :global(.callout) { max-width: 560px; }
  .id { font-size: var(--text-sm); color: var(--text-secondary); }
</style>
