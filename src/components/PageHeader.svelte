<script lang="ts">
  import type { Snippet } from 'svelte';

  // Title, lead and the screen's secondary actions. The toolbar never repeats the title, so this is
  // the only place a page says what it is. Actions sit on the title's line, not the lead's.
  let { title, lead, actions, id }: { title: string; lead?: string; actions?: Snippet; id?: string } = $props();
</script>

<header class="page-head" class:with-actions={!!actions}>
  <h1 {id}>{title}</h1>
  {#if lead}<p class="lead">{lead}</p>{/if}
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
</header>
