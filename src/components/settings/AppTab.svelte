<script lang="ts">
  import AppMaintenance from '../AppMaintenance.svelte';
  import Disclosure from '../Disclosure.svelte';
  import { app } from '../../lib/app.svelte';
  import { FONT_SCALES } from '../../lib/font-scale';
  import { t, type MessageKey } from '../../lib/i18n/index.svelte';
  import type { SettingsDraft } from '../../lib/settings-draft.svelte';
  import type { ThemeChoice } from '../../lib/theme';

  // App: instant-apply items, updates, data, reset. Nothing here goes through the save bar.
  let { form }: { form: SettingsDraft } = $props();

  const themes: { value: ThemeChoice; short: MessageKey }[] = [
    { value: 'system', short: 'settings.theme.systemShort' },
    { value: 'light', short: 'settings.theme.lightShort' },
    { value: 'dark', short: 'settings.theme.darkShort' }
  ];
  // What "system" means right now, so the choice explains itself.
  let systemDark = $state(typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  $effect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(prefers-color-scheme: dark)');
    const listener = () => { systemDark = query.matches; };
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  });
</script>

<Disclosure id="application-settings" icon="monitor" title={t('settings.app.title')} subtitle={t('settings.app.subtitle')} open>
  <!-- The appearance applies the moment it is picked, like the system's own appearance setting. -->
  <fieldset class="appearance" aria-describedby="theme-help">
    <legend class="sf-label">{t('settings.app.appearance')}</legend>
    <div class="theme-options">
      {#each themes as theme (theme.value)}
        <label class="theme-option" class:selected={app.theme === theme.value}>
          <input type="radio" name="theme" value={theme.value} checked={app.theme === theme.value} onchange={() => app.setTheme(theme.value)} />
          <span class="preview {theme.value}" aria-hidden="true"><span class="bar"></span><span class="line"></span><span class="line short"></span></span>
          <span class="name">{t(theme.short)}</span>
        </label>
      {/each}
    </div>
    <span id="theme-help" class="sf-hint">{app.theme === 'system' ? t('settings.theme.following', { mode: t(systemDark ? 'settings.theme.darkShort' : 'settings.theme.lightShort') }) : t('settings.theme.instant')}</span>
  </fieldset>
  <fieldset class="appearance" aria-describedby="font-size-help">
    <legend class="sf-label">{t('settings.app.fontSize')}</legend>
    <div class="size-options">
      {#each FONT_SCALES as scale (scale)}
        <label class="size-option" class:selected={app.fontScale === scale}>
          <input type="radio" name="font-size" value={scale} checked={app.fontScale === scale} onchange={() => app.setFontScale(scale)} />
          <span class="sample" style:font-size={`${13 * scale / 100}px`} aria-hidden="true">Aa</span>
          <span class="name num">{scale}%</span>
        </label>
      {/each}
    </div>
    <span id="font-size-help" class="sf-hint">{t('settings.app.fontSizeHelp')}</span>
  </fieldset>
  <div class="sf-fields sf-two">
    <div class="sf-field">
      <label class="sf-label" for="ui-language">{t('settings.app.language')}</label>
      <select id="ui-language" class="select" value={form.draft.ui_language} aria-describedby="ui-language-help" onchange={(event) => form.changeLanguage(event.currentTarget)}>
        <option value="ko">{t('lang.ko')}</option>
        <option value="en">{t('lang.en')}</option>
        <option value="ja">{t('lang.ja')}</option>
        <option value="zh">{t('lang.zh')}</option>
      </select>
      <span id="ui-language-help" class="sf-hint">{t('settings.app.languageHelp')}</span>
    </div>
  </div>
  <label class="sf-check">
    <input type="checkbox" checked={app.prefs.notify_on_finish} onchange={(event) => app.setPrefs({ notify_on_finish: event.currentTarget.checked })} />
    <span><strong>{t('settings.app.notifyOnFinish')}</strong><small>{t('settings.app.notifyOnFinishHelp')}</small></span>
  </label>
</Disclosure>

<AppMaintenance />

<style>
  .appearance { border: 0; margin: 0; padding: 0; min-width: 0; display: grid; gap: var(--space-2); }
  .appearance legend { margin-bottom: var(--space-2); }
  .theme-options, .size-options { display: flex; flex-wrap: wrap; gap: var(--space-3); }
  .theme-option, .size-option { position: relative; display: grid; justify-items: center; gap: 6px; padding: 6px; border-radius: var(--radius-lg); border: 2px solid transparent; }
  /* The real radio covers the tile, so a click anywhere on it chooses, and the keyboard still works. */
  .theme-option input, .size-option input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; z-index: 1; }
  .theme-option.selected, .size-option.selected { border-color: var(--accent); }
  .theme-option:has(input:focus-visible), .size-option:has(input:focus-visible) { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  .theme-option .name, .size-option .name { font-size: var(--text-sm); font-weight: 500; }
  .theme-option.selected .name, .size-option.selected .name { font-weight: 600; color: var(--accent-text); }
  .size-option { min-width: 84px; }
  .size-option .sample { display: grid; place-items: center; width: 72px; height: 44px; border-radius: var(--radius-md); border: 1px solid var(--border-strong); background: var(--bg-surface); font-weight: 600; line-height: 1; }
  /* Miniature windows: fixed colours on purpose, they show each mode whatever the current one is. */
  .preview { width: 96px; height: 60px; border-radius: var(--radius-md); border: 1px solid var(--border-strong); overflow: hidden; display: grid; grid-template-rows: 12px 1fr; align-content: start; gap: 6px; padding-bottom: 6px; }
  .preview .bar { display: block; }
  .preview .line { display: block; height: 6px; margin-inline: 10px; border-radius: 3px; }
  .preview .line.short { width: 40%; }
  .preview.light { background: #f9f8f7; }
  .preview.light .bar { background: #e6e2dd; }
  .preview.light .line { background: #d6d0c8; }
  .preview.dark { background: #1d1914; }
  .preview.dark .bar { background: #37322c; }
  .preview.dark .line { background: #4a443d; }
  .preview.system { background: linear-gradient(135deg, #f9f8f7 0 50%, #1d1914 50% 100%); }
  .preview.system .bar { background: linear-gradient(135deg, #e6e2dd 0 50%, #37322c 50% 100%); }
  .preview.system .line { background: #867b6f; }
  .preview .bar + .line { background-color: #2c6cec; }
</style>
