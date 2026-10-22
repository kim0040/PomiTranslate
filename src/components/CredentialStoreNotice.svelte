<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { hasMessage, t, type MessageKey } from '../lib/i18n/index.svelte';
  import Callout from './Callout.svelte';
  import Dialog from './Dialog.svelte';

  // Shown when the key store cannot be opened. It says so instead of pretending no key is saved, and
  // offers the one repair that always works: set the damaged store aside and start an empty one.
  let confirming = $state(false);
  let working = $state(false);

  const reason = $derived.by(() => {
    const key = `error.${app.credentialStoreError}`;
    return app.credentialStoreError && hasMessage(key) ? t(key as MessageKey) : t('credential.unavailable.generic');
  });

  async function reset(): Promise<void> {
    working = true;
    const done = await app.resetKeyStorage();
    working = false;
    if (done) confirming = false;
  }
</script>

{#if app.credentialStoreError}
  <div class="field full">
    <Callout tone="warning" title={t('credential.unavailable.title')} role="alert">
      <p>{reason}</p>
      <p>{t('credential.unavailable.next')}</p>
      {#snippet actions()}
        <button type="button" class="btn btn-secondary btn-sm" disabled={app.isBusy} onclick={() => (confirming = true)}>{t('credential.reset.button')}</button>
      {/snippet}
    </Callout>
  </div>
{/if}

{#if confirming}
  <Dialog showClose={false} title={t('credential.reset.title')} tone="danger" onClose={() => (confirming = false)}>
    <p>{t('credential.reset.body')}</p>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" data-autofocus disabled={working} onclick={() => (confirming = false)}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-danger-solid" disabled={working || app.isBusy} onclick={reset}>{t('credential.reset.confirm')}</button>
    {/snippet}
  </Dialog>
{/if}
