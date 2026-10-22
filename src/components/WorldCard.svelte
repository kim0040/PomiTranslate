<script lang="ts">
  import type { Snippet } from 'svelte';
  import { middleEllipsis } from '../lib/format';
  import Icon from './Icon.svelte';

  // The one way a world is shown: a thumbnail (its own icon.png, else a folder), the name, and the
  // path with its middle shortened, because the two ends are what people recognise.
  let {
    name, path = '', icon = '', meta = '', selected = false, compact = false, eyebrow = '', children, actions
  }: {
    name: string; path?: string; icon?: string; meta?: string; selected?: boolean; compact?: boolean; eyebrow?: string;
    children?: Snippet; actions?: Snippet;
  } = $props();
</script>

<section class="world-card card" class:selected class:compact>
  <div class="head">
    {#if icon}<img class="thumb img" src={icon} alt="" width="44" height="44" />
    {:else}<span class="thumb" aria-hidden="true"><Icon name="folder" size={22} /></span>{/if}
    <div class="who">
      {#if eyebrow}<p class="overline">{eyebrow}</p>{/if}
      <h2 class="name truncate" title={name}>{name}</h2>
      {#if meta}<p class="meta">{meta}</p>{/if}
      {#if path}<p class="path mono truncate" title={path}>{middleEllipsis(path, compact ? 48 : 72)}</p>{/if}
    </div>
    {#if actions}<div class="acts">{@render actions()}</div>{/if}
  </div>
  {#if children}<div class="body">{@render children()}</div>{/if}
</section>

<style>
  .world-card { padding: var(--space-4); display: grid; gap: var(--space-3); }
  .world-card.compact { padding: var(--space-3) var(--space-4); }
  .world-card.selected { border-color: var(--accent); background: var(--bg-selected); }
  .head { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
  .thumb { flex: none; display: grid; place-items: center; width: 44px; height: 44px; border-radius: var(--radius-lg); background: var(--accent-soft); color: var(--accent-text); }
  .thumb.img { image-rendering: pixelated; object-fit: cover; outline: 1px solid var(--image-outline); outline-offset: -1px; background: var(--bg-sunken); }
  .who { min-width: 0; flex: 1; }
  .name { font-size: var(--text-xl); font-weight: 600; }
  .meta { font-size: var(--text-sm); color: var(--text-secondary); }
  .path { font-size: var(--text-xs); color: var(--text-secondary); margin-top: 2px; }
  .acts { flex: none; display: flex; gap: var(--space-2); align-items: center; }
  .compact .name { font-size: var(--text-lg); }
  .body { display: grid; gap: var(--space-3); min-width: 0; }
  @media (max-width: 560px) { .head { flex-wrap: wrap; } .acts { width: 100%; } }
</style>
