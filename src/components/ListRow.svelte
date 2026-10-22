<script lang="ts">
  import type { Snippet } from 'svelte';

  // A 44px line: a leading mark, a title with muted detail, and whatever belongs at the end (a state
  // word or an action). Used for backups, recent worlds and shortcuts so lists read the same everywhere.
  let {
    selected = false, leading, children, trailing, detail
  }: { selected?: boolean; leading?: Snippet; children: Snippet; trailing?: Snippet; detail?: Snippet } = $props();
</script>

<li class="list-row" class:selected>
  <div class="line">
    {#if leading}<span class="lead">{@render leading()}</span>{/if}
    <div class="main">{@render children()}</div>
    {#if trailing}<div class="end">{@render trailing()}</div>{/if}
  </div>
  {#if detail}<div class="detail">{@render detail()}</div>{/if}
</li>

<style>
  .list-row { list-style: none; min-width: 0; }
  .list-row.selected { background: var(--bg-selected); }
  .line { display: flex; align-items: center; gap: var(--space-3); min-height: 44px; padding: 6px var(--space-4); min-width: 0; }
  .lead { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: var(--radius-md); background: var(--bg-sunken); color: var(--text-secondary); }
  .main { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: var(--space-3); }
  .end { flex: none; display: flex; align-items: center; gap: var(--space-2); }
  .detail { padding: 0 var(--space-4) var(--space-3); }
</style>
