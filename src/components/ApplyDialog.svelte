<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { t } from '../lib/i18n/index.svelte';
  import { formatNumber } from '../lib/format';
  import Dialog from './Dialog.svelte';

  // The last question before the world is written. It says what happens first (a backup), so the
  // person is never surprised: a plain apply backs up; a correction restores the job's own backup.
  let { corrections, onClose, onConfirm }: { corrections: boolean; onClose: () => void; onConfirm: () => void } = $props();

  const review = app.translationReview;
  const failed = $derived(review.counts.failed);
</script>

<Dialog title={corrections ? t('apply.reapplyTitle') : t('apply.title')} onClose={onClose}>
  {#if corrections}
    <p>{t('apply.reapplyBody', { count: formatNumber(review.dirtyCount, app.locale) })}</p>
    <ul class="steps">
      <li>{t('apply.reapplyStep1')}</li>
      <li>{t('apply.reapplyStep2')}</li>
      <li>{t('apply.reapplyStep3')}</li>
    </ul>
    <p class="note">{t('apply.reapplyNote')}</p>
  {:else}
    <p>{t('apply.body', { count: formatNumber(review.applyCount, app.locale) })}</p>
    <p class="backup">{t('apply.backup')}</p>
    {#if failed > 0}<p class="note">{t('apply.failedKept', { count: formatNumber(failed, app.locale) })}</p>{/if}
    {#if review.dirtyCount > 0}<p class="note">{t('apply.edited', { count: formatNumber(review.dirtyCount, app.locale) })}</p>{/if}
  {/if}
  <p class="note">{t('apply.noRequests')}</p>
  {#snippet actions()}
    <button type="button" class="btn btn-secondary" data-autofocus onclick={onClose}>{t('common.cancel')}</button>
    <button type="button" class="btn btn-primary" onclick={onConfirm}>{corrections ? t('apply.reapplyConfirm') : t('apply.confirm')}</button>
  {/snippet}
</Dialog>

<style>
  p { margin: 0; }
  .backup { color: var(--text); font-weight: 600; }
  .note { font-size: var(--text-sm); }
  .steps { margin: 0; padding-inline-start: 20px; display: grid; gap: var(--space-1); color: var(--text); }
</style>
