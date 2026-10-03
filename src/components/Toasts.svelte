<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { t } from '../lib/i18n/index.svelte';
  import Icon from './Icon.svelte';
  import { flip } from 'svelte/animate';
  import { fade, fly } from 'svelte/transition';
  import { motion } from '../lib/motion';
</script>

<div class="toasts" role="region" aria-label={t('error.title')}>
  {#each app.toasts as toast (toast.id)}
    <div class="toast {toast.tone}" role={toast.tone === 'error' ? 'alert' : 'status'}
      in:fly={{ y: -8, duration: motion(160) }} out:fade={{ duration: motion(120) }} animate:flip={{ duration: motion(160) }}>
      <Icon name={toast.tone === 'error' ? 'alert-circle' : toast.tone === 'success' ? 'check-circle' : 'info'} size={18} />
      <span class="msg">{toast.message}</span>
      {#if toast.action}
        <button type="button" class="btn btn-quiet btn-sm action" onclick={() => { toast.action?.run(); app.dismissToast(toast.id); }}>{toast.action.label}</button>
      {/if}
      <button type="button" class="btn btn-quiet btn-icon btn-sm" aria-label={t('error.dismiss')} onclick={() => app.dismissToast(toast.id)}>
        <Icon name="x" size={16} />
      </button>
    </div>
  {/each}
</div>

<style>
  /* Top right, under the toolbar: the bottom of every screen holds its action bar, and a toast
     there would cover the very button the user is about to press. */
  .toasts { position: fixed; inset-block-start: calc(var(--toolbar-height) + var(--space-2)); inset-inline-end: var(--space-4); z-index: 50; display: grid; gap: var(--space-2); width: min(420px, calc(100vw - 32px)); pointer-events: none; }
  @media (max-width: 640px) { .toasts { inset-block-start: calc(40px + 2 * var(--space-2) + 1px + var(--space-3)); } }
  .toast { pointer-events: auto; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: start; gap: var(--space-2) var(--space-3); padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
    border-radius: var(--radius-lg); background: var(--bg-surface); color: var(--text); border: 1px solid var(--border-strong); box-shadow: var(--shadow-pop); }
  .toast :global(.icon) { margin-top: 2px; }
  .toast.success :global(.icon:first-child) { color: var(--success-solid); }
  .toast.error :global(.icon:first-child) { color: var(--danger-solid); }
  .toast.info :global(.icon:first-child) { color: var(--accent-text); }
  .msg { font-size: var(--text-sm); padding-top: 2px; }
  .action { align-self: center; color: var(--accent-text); white-space: nowrap; }
</style>
