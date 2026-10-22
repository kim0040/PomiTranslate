<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { t } from '../lib/i18n/index.svelte';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  let { onClose }: { onClose: () => void } = $props();

  // Two steps: first what goes and what stays, then a final question that cannot be answered by
  // pressing Return on the first one.
  let stage = $state<'explain' | 'confirm'>('explain');
  let clearKeys = $state(true);
  let working = $state(false);

  async function reset(): Promise<void> {
    working = true;
    if (await app.resetApp(clearKeys)) location.reload();
    else working = false;
  }
</script>

{#if stage === 'explain'}
  <Dialog showClose={false} title={t('reset.title')} tone="danger" {onClose}>
    <div class="lists">
      <section>
        <h3>{t('reset.removes')}</h3>
        <ul class="removes">
          <li><Icon name="minus" size={14} /> {t('reset.item.settings')}</li>
          <li><Icon name="minus" size={14} /> {t('reset.item.recent')}</li>
          <li><Icon name="minus" size={14} /> {t('reset.item.jobs')}</li>
          <li><Icon name="minus" size={14} /> {t('reset.item.models')}</li>
        </ul>
      </section>
      <section>
        <h3>{t('reset.keeps')}</h3>
        <ul class="keeps">
          <li><Icon name="check" size={14} /> {t('reset.keep.backups')}</li>
          <li><Icon name="check" size={14} /> {t('reset.keep.worlds')}</li>
        </ul>
      </section>
    </div>
    <label class="check keys"><input type="checkbox" bind:checked={clearKeys} /><span><span class="label">{t('reset.clearKeys')}</span><small>{t('reset.clearKeysHint')}</small></span></label>
    {#if app.isBusy}<p class="busy" role="alert">{t('reset.busy')}</p>{/if}
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" data-autofocus onclick={onClose}>{t('common.cancel')}</button>
      <!-- Cancel keeps the focus; this is the heavier of the two, with the danger colour and an arrow for "more to come". -->
      <button type="button" class="btn btn-danger go" disabled={app.isBusy} onclick={() => (stage = 'confirm')}>{t('reset.continue')} <Icon name="chevron-right" size={15} /></button>
    {/snippet}
  </Dialog>
{:else}
  <Dialog showClose={false} title={t('reset.confirmTitle')} tone="danger" {onClose}>
    <div class="warn"><Icon name="alert-triangle" size={22} /><p>{t('reset.confirmBody')}{#if clearKeys} <strong>{t('reset.confirmKeys')}</strong>{/if}</p></div>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" data-autofocus disabled={working} onclick={onClose}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-danger-solid" disabled={working || app.isBusy} onclick={reset}>{t('reset.confirm')}</button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .lists { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
  h3 { font-size: var(--text-sm); color: var(--text); margin-bottom: var(--space-2); }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; font-size: var(--text-sm); }
  li { display: grid; grid-template-columns: auto 1fr; gap: 6px; align-items: start; }
  li :global(.icon) { margin-top: 3px; }
  .removes :global(.icon) { color: var(--danger-text); }
  .keeps :global(.icon) { color: var(--success-solid); }
  .keys { padding: 10px var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-lg); }
  .keys > span { display: grid; gap: 2px; }
  .keys .label { color: var(--text); }
  .keys small { font-size: var(--text-xs); }
  .busy { color: var(--danger-text); }
  .go { background: var(--danger-soft); font-weight: 650; }
  .go:disabled { background: var(--bg-sunken); }
  .warn { display: grid; grid-template-columns: auto 1fr; gap: var(--space-3); align-items: start; }
  .warn :global(.icon) { color: var(--danger-text); }
  .warn strong { color: var(--text); }
  @media (max-width: 520px) { .lists { grid-template-columns: 1fr; } }
</style>
