<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon, { type IconName } from './Icon.svelte';

  // A whole-pane state: nothing here yet, or something stopped. One icon or the mascot, one title,
  // one sentence, one main action and at most two quiet ones. Replaces a banner above blank space.
  let {
    title, icon = 'mascot', tone = 'neutral', role, children, actions
  }: {
    title: string; icon?: IconName | 'mascot'; tone?: 'neutral' | 'warning' | 'danger'; role?: 'alert' | 'status';
    children?: Snippet; actions?: Snippet;
  } = $props();
</script>

<section class="status-screen" {role}>
  <div class="art {tone}" aria-hidden="true">
    {#if icon === 'mascot'}<img src="/images/pomi.png" alt="" width="88" height="88" />{:else}<Icon name={icon} size={30} />{/if}
  </div>
  <h2>{title}</h2>
  {#if children}<div class="text">{@render children()}</div>{/if}
  {#if actions}<div class="acts">{@render actions()}</div>{/if}
</section>

<style>
  .status-screen { display: grid; justify-items: center; align-content: start; gap: var(--space-3); text-align: center; padding: var(--space-7) var(--space-4); max-width: 520px; margin-inline: auto; }
  .art { display: grid; place-items: center; width: 88px; height: 88px; border-radius: 50%; background: var(--bg-sunken); color: var(--text-secondary); }
  .art img { width: 88px; height: 88px; object-fit: contain; }
  .art.warning { background: var(--warning-soft); color: var(--warning-text); width: 64px; height: 64px; }
  .art.danger { background: var(--danger-soft); color: var(--danger-text); width: 64px; height: 64px; }
  h2 { font-size: var(--text-xl); font-weight: 600; }
  .text { color: var(--text-secondary); display: grid; gap: var(--space-2); text-wrap: pretty; }
  .text :global(p) { margin: 0; }
  .acts { display: flex; flex-wrap: wrap; gap: var(--space-2); justify-content: center; margin-top: var(--space-2); }
</style>
