<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon, { type IconName } from './Icon.svelte';

  // A small panel that opens under (or over) its button: for a few related controls that would
  // otherwise take a whole row of the screen. Not modal: Tab moves on, Escape or a click outside
  // closes it and Escape hands focus back to the button.
  let {
    label, icon, badge = 0, badgeLabel = '', placement = 'down', quiet = false, children
  }: {
    label: string; icon?: IconName; badge?: number; badgeLabel?: string; placement?: 'down' | 'up'; quiet?: boolean; children: Snippet;
  } = $props();

  const id = `pop-${Math.random().toString(36).slice(2, 8)}`;
  let open = $state(false);
  let root: HTMLElement | undefined = $state();
  let button: HTMLButtonElement | undefined = $state();

  function outside(event: PointerEvent): void {
    if (open && root && !root.contains(event.target as Node)) open = false;
  }
  function key(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !open) return;
    event.stopPropagation();
    open = false;
    button?.focus();
  }
</script>

<svelte:document onpointerdown={outside} />

<div class="pop" bind:this={root} onkeydown={key} role="presentation">
  <button bind:this={button} type="button" class="btn btn-sm trigger {quiet ? 'btn-quiet' : 'btn-secondary'}" aria-expanded={open} aria-controls={open ? id : undefined} onclick={() => (open = !open)}>
    {#if icon}<Icon name={icon} size={15} />{/if}
    <span>{label}</span>
    {#if badge > 0}<span class="badge num">{badge}<span class="sr-only"> {badgeLabel}</span></span>{/if}
    <Icon name="chevron-down" size={14} />
  </button>
  {#if open}
    <div {id} class="panel {placement}" role="group" aria-label={label}>{@render children()}</div>
  {/if}
</div>

<style>
  .pop { position: relative; display: inline-flex; }
  .trigger { gap: 6px; }
  .badge { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: var(--radius-full); background: var(--accent); color: var(--text-on-accent); font-size: var(--text-xs); font-weight: 600; line-height: 1; }
  .panel { position: absolute; z-index: 30; inset-inline-end: 0; min-width: 260px; max-width: min(360px, calc(100vw - 32px)); padding: var(--space-3); display: grid; gap: var(--space-3);
    background: var(--bg-surface); border: 1px solid var(--border-strong); border-radius: var(--radius-lg); box-shadow: var(--shadow-pop); animation: pomi-pop var(--dur-base) var(--ease-out); }
  .panel.down { inset-block-start: calc(100% + 6px); }
  .panel.up { inset-block-end: calc(100% + 6px); }
</style>
