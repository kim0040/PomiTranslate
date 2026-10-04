<script lang="ts">
  import { app, STEPS, type Step } from '../lib/app.svelte';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import Icon from './Icon.svelte';

  const order = $derived(STEPS.indexOf(app.step));
  const isDone = (step: Step) => STEPS.indexOf(step) < order && app.stepReached[step];
  const label = (step: Step) => t(`step.${step}` as MessageKey);
  let nav: HTMLElement | undefined = $state();
  let list: HTMLElement | undefined = $state();
  // Names collapse only when the toolbar is narrower than the minimum window leaves, or when all five
  // really do not fit: the room is compared with the width the full stepper measured when it last
  // rendered whole (0 = not measured yet).
  let available = $state(Number.POSITIVE_INFINITY);
  let fullWidth = $state(0);
  let measuredLocale = '';
  // Below this the names are dropped even when they would just fit: the window is at its minimum and the
  // toolbar must keep room for the sidebar toggle and a long step name.
  const COMPACT_BELOW = 760;
  const compact = $derived(available < COMPACT_BELOW || (fullWidth > 0 && available < fullWidth));

  $effect(() => {
    const toolbar = nav?.parentElement;
    if (!toolbar) return;
    const room = () => {
      const style = getComputedStyle(toolbar);
      return toolbar.clientWidth - parseFloat(style.paddingInlineStart) - parseFloat(style.paddingInlineEnd);
    };
    available = room();
    const observer = new ResizeObserver(() => { available = room(); });
    observer.observe(toolbar);
    return () => observer.disconnect();
  });

  $effect(() => {
    const locale = app.locale;
    const collapsed = compact;
    if (!list) return;
    // The names change with the language, so a compact stepper re-measures after rendering whole once.
    if (locale !== measuredLocale) {
      measuredLocale = locale;
      if (collapsed) { fullWidth = 0; return; }
    }
    if (!collapsed) fullWidth = Math.ceil(list.getBoundingClientRect().width);
  });
</script>

<nav bind:this={nav} class="stepper" class:compact aria-label={t('step.list')}>
  <ol bind:this={list}>
    {#each STEPS as step, index (step)}
      {@const current = app.step === step}
      {@const reachable = app.stepReached[step] && !app.isBusy}
      <li class:current class:done={isDone(step)}>
        <button
          type="button"
          class="step"
          disabled={!reachable && !current}
          aria-label={`${label(step)}${isDone(step) ? ` (${t('step.done')})` : current ? ` (${t('step.current')})` : ''}`}
          title={label(step)}
          aria-current={current ? 'step' : undefined}
          onclick={() => app.goStep(step)}
        >
          <span class="marker" aria-hidden="true">
            {#if isDone(step)}<Icon name="check" size={14} />{:else}{index + 1}{/if}
          </span>
          {#if !compact || current}<span class="name">{label(step)}</span>{/if}
          {#if isDone(step)}<span class="sr-only"> ({t('step.done')})</span>{/if}
          {#if current}<span class="sr-only"> ({t('step.current')})</span>{/if}
        </button>
      </li>
    {/each}
  </ol>
  {#if compact}<span class="step-count" aria-hidden="true">{order + 1}/{STEPS.length}</span>{/if}
</nav>

<style>
  .stepper { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
  ol { display: flex; align-items: center; gap: 0; margin: 0; padding: 0; list-style: none; }
  li { display: flex; align-items: center; }
  li + li::before { content: ''; width: clamp(12px, 3vw, 36px); height: 2px; background: var(--border-strong); margin-inline: var(--space-1); border-radius: 2px; }
  li.done + li::before, li.current::before { background: var(--accent); }
  .step { display: inline-flex; align-items: center; gap: var(--space-2); white-space: nowrap; min-height: 40px; padding: 0 var(--space-3) 0 var(--space-2); border: 0; background: transparent; border-radius: var(--radius-full); color: var(--text-secondary); font-weight: 600; font-size: var(--text-sm); transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease); }
  .step:disabled { cursor: default; opacity: 0.6; }
  .marker { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; font-size: var(--text-xs); font-weight: 700; border: 1.5px solid var(--border-control); color: var(--text-secondary); background: var(--bg-surface); font-variant-numeric: tabular-nums; }
  li.done .marker { background: var(--accent); border-color: var(--accent); color: var(--text-on-accent); }
  li.current .marker { border-color: var(--accent); color: var(--accent-text); box-shadow: 0 0 0 3px var(--accent-soft); }
  li.current .step { color: var(--text); }
  @media (hover: hover) { .step:not(:disabled):hover { background: var(--bg-hover); color: var(--text); } }
  .stepper.compact li:not(.current) .step { padding-inline: var(--space-1); }
  .step-count { flex: none; color: var(--text-secondary); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
</style>
