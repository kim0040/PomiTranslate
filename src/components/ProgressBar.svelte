<script lang="ts">
  import { t } from '../lib/i18n/index.svelte';

  let { value = null, max = 100, label }: { value?: number | null; max?: number; label: string } = $props();
  const percent = $derived(value === null || max <= 0 ? null : Math.max(0, Math.min(100, (value / max) * 100)));
</script>

<div class="wrap">
  <div
    class="bar"
    role="progressbar"
    aria-label={label}
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow={percent === null ? undefined : Math.round(percent)}
  >
    <div class="fill" class:indeterminate={percent === null} style:width={percent === null ? undefined : `${percent}%`}></div>
  </div>
  <!-- With reduced motion the stripes stand still, so the words say what the bar cannot. -->
  {#if percent === null}<span class="working">{t('common.working')}</span>{/if}
</div>

<style>
  .wrap { display: grid; gap: var(--space-1); }
  .bar { height: 10px; border-radius: var(--radius-full); background: var(--bg-sunken); overflow: hidden; border: 1px solid var(--border); }
  .fill { height: 100%; border-radius: var(--radius-full); background: var(--accent); transition: width var(--dur-slow) var(--ease); }
  /* Unknown progress is a sliding block with motion, and a full-width stripe pattern without: a
     part-filled bar standing still would read as "about a third done". */
  .indeterminate { width: 32%; animation: slide 1.3s var(--ease) infinite; }
  .working { display: none; font-size: var(--text-sm); color: var(--text-secondary); }
  @keyframes slide { from { translate: -100% 0; } to { translate: 320% 0; } }
  @media (prefers-reduced-motion: reduce) {
    .indeterminate {
      width: 100%; animation: none; border-radius: 0;
      background: repeating-linear-gradient(135deg, var(--accent) 0 8px, color-mix(in srgb, var(--accent) 35%, transparent) 8px 16px);
    }
    .working { display: block; }
  }
</style>
