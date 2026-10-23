<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '../lib/i18n/index.svelte';

  let {
    title,
    dismissible = true,
    hideClose = false,
    size = 'normal',
    tone = 'normal',
    onClose,
    children,
    actions
  }: { title: string; dismissible?: boolean; hideClose?: boolean; size?: 'normal' | 'wide' | 'fit'; tone?: 'normal' | 'danger'; onClose: () => void; children?: Snippet; actions?: Snippet } = $props();

  let dialog: HTMLDialogElement | undefined = $state();
  const titleId = `dialog-${Math.random().toString(36).slice(2, 8)}`;

  // Native <dialog>: focus is trapped, Escape is handled, and the page behind is inert.
  $effect(() => {
    const node = dialog;
    if (!node) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    node.showModal();
    // The marked control wins over the close button that comes first in the markup.
    queueMicrotask(() => (node.querySelector<HTMLElement>('[data-autofocus]') ?? node.querySelector<HTMLElement>('button, input, select, textarea'))?.focus());
    return () => {
      if (node.open) node.close();
      previous?.focus();
    };
  });

  function handleCancel(event: Event): void {
    event.preventDefault();
    if (dismissible) onClose();
  }
</script>

<dialog bind:this={dialog} class="dialog" class:wide={size === 'wide'} class:fit={size === 'fit'} class:danger={tone === 'danger'} aria-labelledby={titleId} oncancel={handleCancel}>
  <div class="head">
    <h2 id={titleId}>{title}</h2>
    {#if dismissible && !hideClose}
      <button type="button" class="btn btn-quiet btn-icon btn-sm close" aria-label={t('common.close')} onclick={onClose}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    {/if}
  </div>
  <div class="body">{@render children?.()}</div>
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
</dialog>

<style>
  .dialog {
    position: fixed; inset: 0; margin: auto; padding: var(--space-5);
    width: min(520px, calc(100% - 32px)); max-height: calc(100dvh - 32px);
    overflow: auto; overscroll-behavior: contain; color: var(--text); background: var(--bg-surface);
    border: 1px solid var(--border); border-radius: var(--radius-xl); box-shadow: var(--shadow-pop);
  }
  /* A sheet appears the same way everywhere: the scrim fades, the panel fades in from 97%. */
  .dialog[open] { animation: pomi-pop var(--dur-base) var(--ease-out); }
  .dialog.wide { width: min(760px, calc(100% - 32px)); height: min(720px, calc(100dvh - 32px)); }
  .dialog.wide[open] { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; overflow: hidden; }
  .dialog.wide .body { min-height: 0; overflow: auto; }
  /* As wide, but only as tall as its content (up to the window), so a short step has no empty lower half. */
  .dialog.fit { width: min(680px, calc(100% - 32px)); }
  .dialog.fit[open] { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; overflow: hidden; }
  .dialog.fit .body { min-height: 0; overflow: auto; }
  .dialog.danger h2 { color: var(--danger-text); }
  .dialog::backdrop { background: var(--scrim); animation: pomi-fade var(--dur-base) var(--ease-out); }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
  h2 { font-size: var(--text-xl); }
  .close { margin: -4px -8px 0 0; }
  .body { margin-top: var(--space-3); display: grid; gap: var(--space-3); color: var(--text-secondary); }
  .actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: var(--space-3); margin-top: var(--space-5); }
</style>
