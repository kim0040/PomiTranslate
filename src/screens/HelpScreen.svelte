<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { app, ISSUES_URL } from '../lib/app.svelte';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import { appVersion, isMac, openExternal } from '../lib/native';
  import { APP_VERSION } from '../lib/version';
  import Icon, { type IconName } from '../components/Icon.svelte';

  const steps: { icon: IconName; title: MessageKey; body: MessageKey }[] = [
    { icon: 'folder', title: 'tour.2.title', body: 'tour.2.body' },
    { icon: 'search', title: 'tour.3.title', body: 'tour.3.body' },
    { icon: 'language', title: 'tour.4.title', body: 'tour.4.body' },
    { icon: 'shield', title: 'tour.5.title', body: 'tour.5.body' }
  ];
  const faq: { id: string; q: MessageKey; a: MessageKey }[] = [
    { id: 'cost', q: 'help.faq.cost.q', a: 'help.faq.cost.a' },
    { id: 'restore', q: 'help.faq.restore.q', a: 'help.faq.restore.a' },
    { id: 'missing', q: 'help.faq.missing.q', a: 'help.faq.missing.a' },
    { id: 'keys', q: 'help.faq.keys.q', a: 'help.faq.keys.a' },
    { id: 'data', q: 'help.faq.data.q', a: 'help.faq.data.a' },
    { id: 'update', q: 'help.faq.update.q', a: 'help.faq.update.a' },
    { id: 'uninstall', q: 'help.faq.uninstall.q', a: 'help.faq.uninstall.a' }
  ];
  const mod = isMac() ? '⌘' : 'Ctrl';
  const shortcuts: { keys: string[]; label: MessageKey }[] = [
    { keys: [mod, 'O'], label: 'help.shortcut.open' },
    { keys: [mod, ','], label: 'help.shortcut.settings' },
    { keys: [mod, 'F'], label: 'help.shortcut.find' },
    { keys: isMac() ? [mod, '?'] : ['F1'], label: 'help.shortcut.help' },
    { keys: [mod, '+ / − / 0'], label: 'help.shortcut.zoom' },
    { keys: ['Esc'], label: 'help.shortcut.close' }
  ];
  const keyPages = [
    { name: 'OpenRouter', url: 'https://openrouter.ai/settings/keys' },
    { name: 'Google Gemini', url: 'https://aistudio.google.com/app/apikey' },
    { name: 'OpenAI', url: 'https://platform.openai.com/api-keys' },
    { name: 'Anthropic', url: 'https://console.anthropic.com/settings/keys' }
  ];

  let version = $state(APP_VERSION);
  onMount(() => { void appVersion(APP_VERSION).then((value) => (version = value)); });

  // The Help menu's "Keyboard Shortcuts" opens this page at that section.
  let shortcutsSection: HTMLElement | undefined = $state();
  $effect(() => {
    if (app.helpSection !== 'shortcuts') return;
    void tick().then(() => {
      shortcutsSection?.scrollIntoView({ block: 'start' });
      app.helpSection = '';
    });
  });

  function open(url: string): void {
    void openExternal(url).catch((cause) => app.fail(cause));
  }

  /** What a report needs and nothing personal: no paths, world names or keys. */
  async function copyDiagnostics(): Promise<void> {
    const lines = [
      `PomiTranslate ${version}`,
      `OS: ${navigator.userAgent.match(/\(([^)]+)\)/)?.[1] ?? navigator.platform}`,
      `UI: ${app.locale}, theme ${app.theme}`,
      // After a failed start the settings are only defaults, so they would name the wrong provider.
      app.startupFailed ? 'Startup: failed' : `Provider: ${app.settings.provider || '-'}, model ${app.settings.model || '-'}`
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      app.notify(t('help.support.copied'), 'success');
    } catch (cause) {
      app.fail(cause);
    }
  }
</script>

<div class="page help">
  <header class="page-head" class:with-actions={!app.startupFailed}>
    <h1>{t('help.title')}</h1>
    <p class="lead">{t('help.lead')}</p>
    <!-- The tour walks into settings, which needs a started core. -->
    {#if !app.startupFailed}
      <div class="actions">
        <button type="button" class="btn btn-secondary btn-sm" onclick={() => (app.showTour = true)}><Icon name="play" size={12} /> {t('help.tourButton')}</button>
        <button type="button" class="btn btn-secondary btn-sm" onclick={() => app.openWizard()}><Icon name="sliders" size={12} /> {t('help.wizardButton')}</button>
      </div>
    {/if}
  </header>

  <section aria-labelledby="start-title">
    <h2 id="start-title" class="section-title">{t('help.start.title')}</h2>
    <ol class="steps">
      {#each steps as step (step.title)}
        <li class="card">
          <span class="ico" aria-hidden="true"><Icon name={step.icon} size={18} /></span>
          <div><h3>{t(step.title)}</h3><p>{t(step.body)}</p></div>
        </li>
      {/each}
    </ol>
  </section>

  <section aria-labelledby="faq-title">
    <h2 id="faq-title" class="section-title">{t('help.faq.title')}</h2>
    <div class="group faq">
      {#each faq as item (item.id)}
        <details id={`faq-${item.id}`}>
          <summary><span>{t(item.q)}</span><Icon name="chevron-down" size={16} /></summary>
          <p class="selectable">{t(item.a)}</p>
        </details>
      {/each}
    </div>
  </section>

  <div class="columns">
    <section id="shortcuts" aria-labelledby="shortcuts-title" bind:this={shortcutsSection}>
      <h2 id="shortcuts-title" class="section-title">{t('help.shortcuts.title')}</h2>
      <dl class="group">
        {#each shortcuts as shortcut (shortcut.label)}
          <div class="row-item"><dt class="k">{t(shortcut.label)}</dt><dd class="v keys">{#each shortcut.keys as key}<kbd>{key}</kbd>{/each}</dd></div>
        {/each}
      </dl>
    </section>

    <section aria-labelledby="keys-title">
      <h2 id="keys-title" class="section-title">{t('help.keys.title')}</h2>
      <p class="muted small">{t('help.keys.lead')}</p>
      <ul class="group links">
        {#each keyPages as page (page.name)}
          <li><button type="button" class="link" onclick={() => open(page.url)}><span>{page.name}</span><Icon name="chevron-right" size={15} /></button></li>
        {/each}
      </ul>
    </section>
  </div>

  <section class="card support" aria-labelledby="support-title">
    <div>
      <h2 id="support-title">{t('help.support.title')}</h2>
      <p class="muted">{t('help.support.body')}</p>
    </div>
    <div class="buttons">
      <button type="button" class="btn btn-secondary" onclick={copyDiagnostics}>{t('help.support.copy')}</button>
      <button type="button" class="btn btn-primary" onclick={() => open(ISSUES_URL)}>{t('help.support.report')}</button>
    </div>
  </section>
</div>

<style>
  /* Four steps read as 2×2 or one row of four, never three plus a stray one. */
  .steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); counter-reset: none; }
  @media (min-width: 1360px) { .steps { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  @media (max-width: 640px) { .steps { grid-template-columns: 1fr; } }
  .steps li { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-3); padding: var(--space-3) var(--space-4); align-items: start; }
  .steps h3 { font-size: var(--text-md); }
  .steps p { margin-top: 2px; font-size: var(--text-sm); color: var(--text-secondary); }
  .ico { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius-md); background: var(--accent-soft); color: var(--accent-soft-text); }
  .faq details + details { border-top: 1px solid var(--border); }
  .faq summary { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: 10px var(--space-4); font-weight: 500; list-style: none; }
  .faq summary::-webkit-details-marker { display: none; }
  .faq summary :global(.icon) { color: var(--text-secondary); flex: none; transition: rotate var(--dur-base) var(--ease-out); }
  .faq details[open] summary :global(.icon) { rotate: 180deg; }
  .faq details p { padding: 0 var(--space-4) var(--space-3); color: var(--text-secondary); font-size: var(--text-sm); max-width: 80ch; }
  @media (hover: hover) { .faq summary:hover { background: var(--bg-hover); } }
  .columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-5); align-items: start; }
  #shortcuts { scroll-margin-top: var(--space-4); }
  .keys { display: flex; gap: 4px; flex-wrap: wrap; }
  kbd { display: inline-grid; place-items: center; min-width: 24px; height: 22px; padding: 0 6px; border: 1px solid var(--border-strong); border-bottom-width: 2px; border-radius: var(--radius-sm); background: var(--bg-surface); font-size: var(--text-xs); color: var(--text); }
  .small { font-size: var(--text-sm); margin-bottom: var(--space-2); }
  .links { list-style: none; }
  .links li + li { border-top: 1px solid var(--border); }
  .link { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: 10px var(--space-4); border: 0; background: transparent; color: var(--accent-text); font-weight: 500; text-align: start; }
  .link :global(.icon) { color: var(--text-secondary); }
  @media (hover: hover) { .link:hover { background: var(--bg-hover); } }
  .support { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; padding: var(--space-4) var(--space-5); }
  .support h2 { font-size: var(--text-lg); font-weight: 600; }
  .support .muted { font-size: var(--text-sm); margin-top: 2px; max-width: 64ch; }
  .support .buttons { display: flex; gap: var(--space-2); }
  @media (max-width: 760px) { .columns { grid-template-columns: 1fr; } }
</style>
