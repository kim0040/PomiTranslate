<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import Dialog from './Dialog.svelte';
  import Icon, { type IconName } from './Icon.svelte';

  // Four steps of the workflow, the same words as the help page's quick start.
  const steps: { icon: IconName | null; title: MessageKey; body: MessageKey }[] = [
    { icon: null, title: 'tour.1.title', body: 'tour.1.body' },
    { icon: 'folder', title: 'tour.2.title', body: 'tour.2.body' },
    { icon: 'search', title: 'tour.3.title', body: 'tour.3.body' },
    { icon: 'language', title: 'tour.4.title', body: 'tour.4.body' },
    { icon: 'shield', title: 'tour.5.title', body: 'tour.5.body' }
  ];
  let index = $state(0);
  const step = $derived(steps[index]);
  const last = $derived(index === steps.length - 1);

  function finish(toSettings = false): void {
    app.finishTour();
    if (toSettings) app.goto('settings');
  }
</script>

<Dialog showClose={false} title={t('tour.title')} onClose={() => finish()}>
  <div class="tour">
    <div class="art" aria-hidden="true">
      {#if step.icon}<span class="ico"><Icon name={step.icon} size={30} /></span>
      {:else}<img src="/images/pomi.png" alt="" width="80" height="80" />{/if}
    </div>
    <div class="copy">
      <h3>{t(step.title)}</h3>
      <p>{t(step.body)}</p>
    </div>
    <!-- The words carry the position ("2 / 5"); the dots are only a picture of it. Not a live region. -->
    <div class="progress">
      <ol class="dots" aria-hidden="true">
        {#each steps as _, i (i)}<li class:on={i === index} class:done={i < index}></li>{/each}
      </ol>
      <span class="count">{t('tour.step', { index: index + 1, total: steps.length })}</span>
    </div>
  </div>
  {#snippet actions()}
    {#if !last}<button type="button" class="btn btn-quiet skip" onclick={() => finish()}>{t('tour.skip')}</button>{/if}
    {#if index > 0}<button type="button" class="btn btn-secondary" onclick={() => (index -= 1)}>{t('tour.prev')}</button>{/if}
    {#if last}
      {#if !app.apiKeyStored}<button type="button" class="btn btn-secondary" onclick={() => finish(true)}>{t('tour.setupKey')}</button>{/if}
      <button type="button" class="btn btn-primary" data-autofocus onclick={() => finish()}>{t('tour.done')}</button>
    {:else}
      <button type="button" class="btn btn-primary" data-autofocus onclick={() => (index += 1)}>{t('tour.next')} <Icon name="chevron-right" size={15} /></button>
    {/if}
  {/snippet}
</Dialog>

<style>
  /* The art and the progress keep their place while the copy changes length, so the buttons do not jump. */
  .tour { display: grid; justify-items: center; text-align: center; gap: var(--space-4); padding-block: var(--space-2) 0; min-height: 256px; grid-template-rows: auto minmax(0, 1fr) auto; }
  .art { height: 80px; display: grid; place-items: center; }
  .art img { width: 80px; height: 80px; object-fit: contain; }
  .ico { display: grid; place-items: center; width: 64px; height: 64px; border-radius: var(--radius-xl); background: var(--accent-soft); color: var(--accent-soft-text); }
  .copy { display: grid; gap: var(--space-2); align-content: start; justify-items: center; }
  h3 { font-size: var(--text-xl); color: var(--text); }
  p { max-width: 46ch; }
  .progress { display: flex; align-items: center; justify-content: center; gap: var(--space-3); }
  .count { color: var(--text-secondary); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  .dots { display: flex; gap: 6px; list-style: none; margin: 0; padding: 0; }
  .dots li { width: 6px; height: 6px; border-radius: 50%; background: var(--border-strong); transition: background-color var(--dur-fast) var(--ease), width var(--dur-base) var(--ease-out); }
  .dots li.done { background: var(--accent); opacity: 0.5; }
  .dots li.on { width: 18px; border-radius: 3px; background: var(--accent); }
  .skip { margin-inline-end: auto; }
</style>
