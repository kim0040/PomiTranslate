<script lang="ts">
  import { app } from '../lib/app.svelte';

  // Helper text that runs to several sentences reads as a wall at 12.5px. Each sentence gets its own
  // short line instead, split by the platform's own sentence rules for the current language, so the
  // catalogs stay one string per message and nothing is dropped.
  let { text, id }: { text: string; id?: string } = $props();

  const parts = $derived.by(() => {
    try {
      const segmenter = new Intl.Segmenter(app.locale, { granularity: 'sentence' });
      const sentences = [...segmenter.segment(text)].map((part) => part.segment.trim()).filter(Boolean);
      return sentences.length ? sentences : [text];
    } catch { return [text]; }
  });
</script>

<div class="hint-text" {id}>
  {#each parts as part, index (index)}<p>{part}</p>{/each}
</div>

<style>
  .hint-text { display: grid; gap: var(--space-1); max-width: 64ch; min-width: 0; }
  p { color: var(--text-secondary); font-size: var(--text-sm); line-height: 1.5; }
</style>
