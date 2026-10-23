<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { t } from '../lib/i18n/index.svelte';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // Asked when the app cannot tell which entries it made in the system keychain. It lists nothing it
  // cannot know and deletes nothing there: the person removes the entries, then says so.
  const prompt = $derived(app.keychainAck);
  let removed = $state(false);
  // Every new question starts unticked.
  $effect(() => { if (!prompt) removed = false; });
</script>

{#if prompt}
  <Dialog showClose={false} tone="danger" title={t('keychain.ack.title')} onClose={() => app.cancelKeychainAck()}>
    <div class="warn"><Icon name="alert-triangle" size={22} /><p>{t('keychain.ack.body')}</p></div>
    <p>{t('keychain.ack.steps')}</p>
    <label class="check"><input type="checkbox" bind:checked={removed} disabled={prompt.working} /><span class="label">{t('keychain.ack.check')}</span></label>
    <p class="note">{t('keychain.ack.note')}</p>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" data-autofocus disabled={prompt.working} onclick={() => app.cancelKeychainAck()}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-danger-solid" disabled={!removed || prompt.working} onclick={() => app.confirmKeychainAck()}>
        {t(prompt.working ? 'keychain.ack.working' : 'keychain.ack.confirm')}
      </button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .warn { display: grid; grid-template-columns: auto 1fr; gap: var(--space-3); align-items: start; }
  .warn :global(.icon) { color: var(--danger-text); }
  p { margin: 0; }
  .note { font-size: var(--text-sm); color: var(--text-secondary); }
  .check { padding: 10px var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-lg); }
  .check .label { color: var(--text); }
</style>
