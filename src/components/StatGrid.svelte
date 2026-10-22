<script lang="ts" module>
  export type Stat = { value: string; label: string; hint?: string; tone?: 'default' | 'success' | 'warning' | 'danger' };
</script>

<script lang="ts">
  // One number that matters, large, and the supporting numbers quieter beside it. Scan and Result
  // both use it, so the same fact looks the same on both screens.
  let { primary, stats = [], label }: { primary?: Stat; stats?: Stat[]; label?: string } = $props();
</script>

<section class="stats card" class:alone={!primary} aria-label={label}>
  {#if primary}
    <div class="hero">
      <span class="v num {primary.tone ?? 'default'}">{primary.value}</span>
      <span class="l">{primary.label}</span>
      {#if primary.hint}<span class="h">{primary.hint}</span>{/if}
    </div>
  {/if}
  {#if stats.length}
    <dl class="rest">
      {#each stats as stat (stat.label)}
        <div class="stat">
          <dd class="v num {stat.tone ?? 'default'}">{stat.value}</dd>
          <dt class="l">{stat.label}</dt>
          {#if stat.hint}<dd class="h">{stat.hint}</dd>{/if}
        </div>
      {/each}
    </dl>
  {/if}
</section>

<style>
  .stats { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: stretch; overflow: hidden; }
  .stats.alone { grid-template-columns: minmax(0, 1fr); }
  .hero { display: grid; align-content: center; gap: 2px; padding: var(--space-4) var(--space-6) var(--space-4) var(--space-5); min-width: 160px; }
  .rest { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(112px, 1fr)); min-width: 0; }
  .stat { display: grid; align-content: center; gap: 2px; padding: var(--space-3) var(--space-4); border-inline-start: 1px solid var(--border); min-width: 0; }
  .alone .stat:first-child { border-inline-start: 0; }
  .hero .v { font-size: var(--text-stat); font-weight: 600; letter-spacing: -0.02em; line-height: 1.15; }
  .stat .v { font-size: var(--text-xl); font-weight: 600; letter-spacing: -0.01em; line-height: 1.2; margin: 0; }
  .l { font-size: var(--text-sm); color: var(--text-secondary); margin: 0; }
  .h { font-size: var(--text-xs); color: var(--text-secondary); margin: 0; }
  .v.success { color: var(--success-text); }
  .v.warning { color: var(--warning-text); }
  .v.danger { color: var(--danger-text); }
  @media (max-width: 720px) {
    .stats { grid-template-columns: minmax(0, 1fr); }
    .hero { padding: var(--space-4); }
    .stat { border-inline-start: 0; border-block-start: 1px solid var(--border); }
    .rest { grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); }
  }
</style>
