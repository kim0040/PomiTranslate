<script module lang="ts">
  export type IconName =
    | 'folder' | 'search' | 'list' | 'language' | 'check-circle' | 'archive' | 'sliders' | 'info' | 'chevron-right'
    | 'chevron-left' | 'chevron-down' | 'x' | 'check' | 'alert-triangle' | 'alert-circle' | 'refresh' | 'trash'
    | 'eye' | 'eye-off' | 'play' | 'stop' | 'sidebar' | 'pencil' | 'shield' | 'clock' | 'minus' | 'plus' | 'undo' | 'download' | 'help' | 'copy';
</script>

<script lang="ts">
  // One stroke set, drawn on a 24px grid. Icons take their colour from the text (currentColor).
  let { name, size = 20, label = '' }: { name: IconName; size?: number; label?: string } = $props();

  const paths: Record<IconName, string> = {
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    search: 'M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.2-4.2',
    list: 'M9 6h11M9 12h11M9 18h11M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5 2.5-2.5M3.5 18l1.5 1.5 2.5-2.5',
    language: 'M4 5h9M8.5 3v2M6 5c.5 3 2.5 6 6 8M12 5c-.8 3.5-3 6-7 8M13 20l4-9 4 9M14.5 17h5',
    'check-circle': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12.5l2.7 2.7L16 9.5',
    archive: 'M3 4h18v4H3zM5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12.5h4',
    sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM9 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
    info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8v.01',
    'chevron-right': 'M9 6l6 6-6 6',
    'chevron-left': 'M15 6l-6 6 6 6',
    'chevron-down': 'M6 9l6 6 6-6',
    x: 'M6 6l12 12M18 6L6 18',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    'alert-triangle': 'M12 4l9.5 16.5h-19zM12 10v4.5M12 17.5v.01',
    'alert-circle': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5v5M12 16v.01',
    refresh: 'M20 11a8 8 0 0 0-14.3-4L4 9M4 4v5h5M4 13a8 8 0 0 0 14.3 4L20 15M20 20v-5h-5',
    trash: 'M4.5 7h15M9 7V4.5h6V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5',
    eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5z',
    'eye-off': 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5zM4 4l16 16',
    play: 'M8 5.5v13l10.5-6.5z',
    stop: 'M8.5 6.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z',
    sidebar: 'M6.5 4.5h11a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3zM9.5 4.5v15',
    pencil: 'M4 20l1-4L16.5 4.5a2 2 0 0 1 3 3L8 19z',
    shield: 'M12 3l7 3v5.5c0 4.5-3 7.5-7 9.5-4-2-7-5-7-9.5V6zM9 12l2.2 2.2L15.5 10',
    clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
    minus: 'M5 12h14',
    plus: 'M12 5v14M5 12h14',
    undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
    download: 'M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14',
    help: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17v.01',
    copy: 'M8 8V4.5A1.5 1.5 0 0 1 9.5 3h9A1.5 1.5 0 0 1 20 4.5v12a1.5 1.5 0 0 1-1.5 1.5H15M5 7h8.5A1.5 1.5 0 0 1 15 8.5v12A1.5 1.5 0 0 1 13.5 22h-8A1.5 1.5 0 0 1 4 20.5v-12A1.5 1.5 0 0 1 5.5 7z'
  };
  const filled = new Set<IconName>(['play']);
</script>

<svg
  class="icon"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill={filled.has(name) ? 'currentColor' : 'none'}
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  role={label ? 'img' : undefined}
  aria-label={label || undefined}
  aria-hidden={label ? undefined : 'true'}
  focusable="false"
>
  <path d={paths[name]} />
</svg>

<style>
  .icon { flex: none; display: block; }
</style>
