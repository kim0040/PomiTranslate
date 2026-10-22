<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import Dialog from './Dialog.svelte';

  // Asked when a step would drop review work (excluded sentences, manual translations) that the
  // core could not store. A stored draft comes back on the next scan, so it never gets here.
  const prompt = $derived(app.discardPrompt);
</script>

{#if prompt}
  <Dialog showClose={false} tone="danger" title={t('discard.title')} onClose={() => app.answerDiscard(false)}>
    <p>{t(`discard.body.${prompt.reason}` as MessageKey, { excluded: app.excluded.size, manual: Object.keys(app.effectiveOverrides).length })}</p>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" data-autofocus onclick={() => app.answerDiscard(false)}>{t('discard.keep')}</button>
      <button type="button" class="btn btn-danger-solid" onclick={() => app.answerDiscard(true)}>{t('discard.drop')}</button>
    {/snippet}
  </Dialog>
{/if}
