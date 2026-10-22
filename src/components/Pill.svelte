<script lang="ts">
  import type { Snippet } from 'svelte';

  // A state word. Use it only for a state worth noticing: the default state of a list is plain text.
  let { tone = 'neutral', dot = false, children }: { tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; dot?: boolean; children: Snippet } = $props();
</script>

<span class="pill" class:pill-accent={tone === 'accent'} class:pill-success={tone === 'success'} class:pill-warning={tone === 'warning'}
  class:pill-danger={tone === 'danger'} class:pill-dot={dot}>{@render children()}</span>
