<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { t } from '../lib/i18n/index.svelte';
  import Dialog from './Dialog.svelte';

  // The one question the desktop shell asks before the app ends (window close, Alt+F4, Quit, Cmd+Q).
  // A running job and unsaved settings are different questions: a job offers "cancel and quit" or
  // "keep working"; unsaved settings offer save, discard or stay.
  const prompt = $derived(app.exitPrompt);
  let working = $state(false);

  async function run(action: () => Promise<void>): Promise<void> {
    working = true;
    try { await action(); } finally { working = false; }
  }
</script>

{#if prompt}
  {#if prompt.phase === 'waiting'}
    <Dialog title={t('exit.waitingTitle')} dismissible={false} onClose={() => {}}>
      <p role="status" aria-live="polite">{t('exit.waitingBody')}</p>
    </Dialog>
  {:else if prompt.phase === 'stuck'}
    <Dialog title={t('exit.stuckTitle')} tone="danger" onClose={() => app.exitStay()}>
      <p>{t('exit.stuckBody')}</p>
      {#snippet actions()}
        <button type="button" class="btn btn-secondary" data-autofocus onclick={() => app.exitStay()}>{t('exit.keepWaiting')}</button>
        <button type="button" class="btn btn-danger-solid" disabled={working} onclick={() => run(() => app.exitNow())}>{t('exit.quitNow')}</button>
      {/snippet}
    </Dialog>
  {:else if prompt.job}
    <Dialog title={t('exit.jobTitle')} tone="danger" onClose={() => app.exitStay()}>
      <p>{t('exit.jobBody')}</p>
      {#if prompt.dirty}<p>{t('exit.jobDirty')}</p>{/if}
      {#snippet actions()}
        <button type="button" class="btn btn-secondary" data-autofocus onclick={() => app.exitStay()}>{t('exit.keepWorking')}</button>
        <button type="button" class="btn btn-danger-solid" disabled={working} onclick={() => run(() => app.exitQuit())}>{t('exit.cancelAndQuit')}</button>
      {/snippet}
    </Dialog>
  {:else}
    <Dialog title={t('exit.dirtyTitle')} onClose={() => app.exitStay()}>
      <p>{t('exit.dirtyBody')}</p>
      {#snippet actions()}
        <button type="button" class="btn btn-quiet" onclick={() => app.exitStay()}>{t('common.cancel')}</button>
        <button type="button" class="btn btn-secondary" disabled={working} onclick={() => run(() => app.exitQuit())}>{t('exit.quitWithoutSaving')}</button>
        <button type="button" class="btn btn-primary" data-autofocus disabled={working} onclick={() => run(() => app.exitSaveAndQuit())}>{t('exit.saveAndQuit')}</button>
      {/snippet}
    </Dialog>
  {/if}
{/if}
