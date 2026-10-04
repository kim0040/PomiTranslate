<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon, { type IconName } from './Icon.svelte';

  // The one way a section opens and closes in settings: a header button with a chevron, and a panel
  // that slides open. The panel stays in the page while closed (inert and hidden), so what is typed
  // into it is not lost. Reduced motion turns the slide off through the global rule in base.css.
  let {
    title,
    subtitle = '',
    icon,
    open = $bindable(false),
    forceOpen = false,
    variant = 'card',
    tone = 'normal',
    level = 2,
    id,
    children
  }: {
    title: string; subtitle?: string; icon?: IconName; open?: boolean; forceOpen?: boolean;
    variant?: 'card' | 'inline'; tone?: 'normal' | 'danger'; level?: 2 | 3 | 4; id?: string; children?: Snippet;
  } = $props();

  const uid = `disclosure-${Math.random().toString(36).slice(2, 8)}`;
  const shown = $derived(open || forceOpen);
</script>

<section class="disclosure {variant}" class:card={variant === 'card'} class:open={shown} class:danger={tone === 'danger'} {id}>
  <svelte:element this={`h${level}`} class="head">
    <button type="button" class="toggle" aria-expanded={shown} aria-controls="{uid}-panel" onclick={() => { if (!forceOpen) open = !open; }}>
      {#if icon}<span class="icon-tile" aria-hidden="true"><Icon name={icon} size={16} /></span>{/if}
      <span class="text"><strong>{title}</strong>{#if subtitle}<small>{subtitle}</small>{/if}</span>
      <Icon name="chevron-down" size={18} />
    </button>
  </svelte:element>
  <div class="wrap" id="{uid}-panel" inert={!shown}>
    <div class="panel"><div class="content">{@render children?.()}</div></div>
  </div>
</section>

<style>
  .disclosure.card { padding: var(--space-4) var(--space-5); }
  .head { margin: 0; font-size: inherit; font-weight: inherit; }
  .toggle { width: 100%; background: none; border: 0; padding: 0; cursor: pointer; display: flex; align-items: center; gap: var(--space-3); text-align: start; color: var(--text); min-height: 32px; border-radius: var(--radius-md); }
  .text { flex: 1; min-width: 0; display: grid; gap: 2px; }
  .text strong { font-size: var(--text-lg); font-weight: 600; }
  .text small { color: var(--text-secondary); font-size: var(--text-sm); font-weight: 400; }
  .inline .text strong { font-size: var(--text-md); }
  .danger { border-color: var(--danger-border); }
  .danger > .head .icon-tile { background: var(--danger-solid); }
  .icon-tile { display: grid; place-items: center; flex: none; width: 28px; height: 28px; border-radius: var(--radius-md); background: var(--accent); color: var(--text-on-accent); }
  .toggle > :global(.icon) { color: var(--text-secondary); transition: rotate var(--dur-base) var(--ease-out); }
  .open > .head .toggle > :global(.icon) { rotate: 180deg; }
  .wrap { display: grid; grid-template-rows: 0fr; visibility: hidden; transition: grid-template-rows var(--dur-base) var(--ease-out), visibility 0s linear var(--dur-base); }
  .open > .wrap { grid-template-rows: 1fr; visibility: visible; transition: grid-template-rows var(--dur-base) var(--ease-out), visibility 0s; }
  /* The padding keeps focus rings from being cut by the clipping panel. */
  .panel { min-height: 0; overflow: hidden; padding: 4px; margin: -4px; }
  .content { display: grid; gap: var(--space-4); padding-block-start: var(--space-4); min-width: 0; }
  .inline .content { padding-block-start: var(--space-3); }
  .inline .toggle { padding-inline: 0; }
  @media (prefers-reduced-motion: reduce) { .wrap, .open > .wrap { transition: none; } .toggle > :global(.icon) { transition: none; } }
  @media (hover: hover) { .toggle:hover .text strong { color: var(--accent-text); } }
</style>
