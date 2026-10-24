<script lang="ts">
  import { tick, untrack } from 'svelte';
  import Dialog from '../components/Dialog.svelte';
  import Icon from '../components/Icon.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import AdvancedTab from '../components/settings/AdvancedTab.svelte';
  import AppTab from '../components/settings/AppTab.svelte';
  import ScopeTab from '../components/settings/ScopeTab.svelte';
  import TranslateTab from '../components/settings/TranslateTab.svelte';
  import { app } from '../lib/app.svelte';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import { SettingsDraft, TAB_LABELS } from '../lib/settings-draft.svelte';
  import { SETTINGS_TABS, type SettingsTab } from '../lib/settings-tabs';

  // The draft, its checks and every request live in SettingsDraft; the four tabs show it. This
  // screen owns what is common to them: the tab strip, the save bar and the leave dialog.
  // State only so the tabs can take it with `bind:` (their editors bind into its draft); it is never replaced.
  let form = $state(new SettingsDraft());
  let saveBarHeight = $state(0);
  const tab = $derived(app.settingsTab);

  // The update badge and the Help menu's update check both land on the app tab.
  $effect(() => { if (app.helpSection === 'updates') app.settingsTab = 'app'; });
  $effect(() => form.initWhenReady());
  $effect(() => form.scheduleAutoLookup());
  $effect(() => form.syncPriceInputs());

  // Leaving with unsaved changes asks first (AppState holds the move until it is answered), and the
  // desktop shell asks about them when the window is closed. Unfinished input that cannot be saved
  // yet (a half-written row) is also worth a question before leaving.
  $effect(() => { app.settingsDirty = form.dirty || form.incomplete; });
  // "Save and quit" in the exit dialog saves this draft.
  $effect(() => {
    app.saveDraft = () => form.save();
    return () => { app.saveDraft = null; };
  });
  $effect(() => () => {
    app.settingsDirty = false;
    app.pendingLeave = null;
    app.clearSettingsSaveError();
  });

  // The save bar appears with the first change and covers the bottom of the pane. A field being edited
  // down there is brought back above it.
  $effect(() => {
    if (!form.showSaveBar) return;
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest('.settings-form')) active.scrollIntoView({ block: 'nearest' });
    }));
    return () => cancelAnimationFrame(frame);
  });

  // The banner's "Enter the key" lands here: open the key field of the Custom provider and focus it.
  $effect(() => {
    if (!app.focusKeyField || !form.snapshot) return;
    app.focusKeyField = false;
    untrack(() => {
      app.settingsTab = 'translate';
      if (form.draft.provider !== 'custom') return;
      form.editingKey = true;
      void tick().then(() => {
        const field = document.getElementById('api-key');
        field?.scrollIntoView({ block: 'center' });
        field?.focus();
      });
    });
  });

  // A fix-it link can point at one setting: it is brought into view even inside the Advanced section.
  const ADVANCED_TARGETS = ['reasoning-settings', 'user-model-price', 'key-storage', 'style-settings'];
  $effect(() => {
    const target = app.settingsFocus;
    if (!target || !form.snapshot) return;
    untrack(() => void reveal(target));
  });
  async function reveal(id: string): Promise<void> {
    if (ADVANCED_TARGETS.includes(id)) form.advancedOpen = true;
    await tick();
    requestAnimationFrame(() => {
      const element = document.getElementById(id);
      element?.scrollIntoView({ block: 'center' });
      element?.querySelector<HTMLElement>('input:not([type="radio"]), select, textarea, button')?.focus({ preventScroll: true });
    });
    app.settingsFocus = '';
  }

  // The save bar goes away with the last change. Focus must not fall to the page, so it goes to the
  // tab of the part on screen, which stays.
  async function focusTab(): Promise<void> {
    await tick();
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected) return;
    document.getElementById(`settings-tab-${tab}`)?.focus({ preventScroll: true });
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    // Nothing to save means no save bar; an Enter key must not write the settings anyway.
    if (!form.dirty) return;
    if (await form.save()) {
      if (app.returnStep) app.returnFromSettings();
      else void focusTab();
    }
  }

  async function saveAndLeave(): Promise<void> {
    app.resolveLeave(await form.save());
  }

  function leaveWithoutSaving(): void {
    form.discard();
    app.resolveLeave(true);
  }

  function discard(): void {
    app.clearSettingsSaveError();
    form.discard();
    void focusTab();
  }

  function selectTab(next: SettingsTab, focus = false): void {
    app.settingsTab = next;
    if (focus) void tick().then(() => document.getElementById(`settings-tab-${next}`)?.focus());
  }
  function onTabKeydown(event: KeyboardEvent): void {
    const index = SETTINGS_TABS.indexOf(tab);
    const last = SETTINGS_TABS.length - 1;
    const target = event.key === 'ArrowRight' ? (index + 1) % SETTINGS_TABS.length
      : event.key === 'ArrowLeft' ? (index + last) % SETTINGS_TABS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? last : -1;
    if (target < 0) return;
    event.preventDefault();
    selectTab(SETTINGS_TABS[target], true);
  }
</script>

<div class="page settings" style:--settings-save-height={`${form.showSaveBar ? saveBarHeight : 0}px`}>
  <PageHeader title={t('settings.title')} lead={t('settings.lead')} />

  <form class="settings-form" onsubmit={submit} novalidate>
    <div class="tabs" role="tablist" aria-label={t('settings.tabs')} tabindex="-1" onkeydown={onTabKeydown}>
      {#each SETTINGS_TABS as name (name)}
        <button type="button" role="tab" id="settings-tab-{name}" class="tab" class:invalid={form.errorTabs.includes(name)} aria-selected={tab === name} aria-controls="settings-panel-{name}"
          tabindex={tab === name ? 0 : -1} onclick={() => selectTab(name)}>
          {t(TAB_LABELS[name])}
          {#if form.pending[name] > 0}<span class="dot num" title={t('settings.pendingTab', { count: form.pending[name] })}>{form.pending[name]}</span>{/if}
        </button>
      {/each}
    </div>
    {#if form.showCrossTabAttention}<p class="cross-tab-pending" role="status">{t('settings.otherTabsAttention', { tabs: form.tabNames(form.attentionTabs) })}</p>{/if}
    <!-- A model-list request never sets `busy`, so reading the list leaves the form usable. -->
    <fieldset disabled={!!app.busy} aria-busy={app.busy === 'settings'}>
      <div class="panel" role="tabpanel" id="settings-panel-translate" aria-labelledby="settings-tab-translate" hidden={tab !== 'translate'}>
        <TranslateTab bind:form onOpenEndpoint={() => selectTab('advanced')} />
      </div>
      <div class="panel" role="tabpanel" id="settings-panel-scope" aria-labelledby="settings-tab-scope" hidden={tab !== 'scope'}>
        <ScopeTab bind:form />
      </div>
      <div class="panel" role="tabpanel" id="settings-panel-advanced" aria-labelledby="settings-tab-advanced" hidden={tab !== 'advanced'}>
        <AdvancedTab bind:form />
      </div>
      <div class="panel" role="tabpanel" id="settings-panel-app" aria-labelledby="settings-tab-app" hidden={tab !== 'app'}>
        <AppTab {form} />
      </div>
    </fieldset>

    {#if form.showSaveBar}
      <footer class="save-bar" class:dirty={form.dirty || form.incomplete} bind:clientHeight={saveBarHeight}>
        <div class="save-status" role="status" aria-live="polite">
          <strong>{#if app.busy === 'settings'}{t('settings.saving')}
            {:else if form.dirty && form.pendingTabs.length}{t('settings.pending', { tabs: form.tabNames(form.pendingTabs), count: form.pendingTabs.reduce((sum, name) => sum + form.pending[name], 0) })}
            {:else if form.dirty}{t('settings.dirty')}
            {:else if form.incomplete}{t('settings.incomplete')}
            {:else}{t('settings.savedState')}{/if}</strong>
          {#if (form.dirty || form.incomplete) && form.hasBlockingError}<span class="sf-error">{form.errorTabs.length ? t('settings.fixErrorsIn', { tabs: form.tabNames(form.errorTabs) }) : t('settings.fixErrors')}</span>{/if}
        </div>
        {#if app.settingsSaveError}
          <!-- The reason a save failed sits here, next to the button that was pressed. -->
          <p class="save-error sf-error" role="alert">{app.settingsSaveError}</p>
        {/if}
        <div class="save-buttons">
        {#if app.returnStep && !form.dirty && !form.incomplete}
          <!-- Settings were opened to fix something a step needs: once saved, the way back is the next move. -->
          <button type="button" class="btn btn-primary" disabled={!!app.busy} onclick={() => app.returnFromSettings()}>
            <Icon name="chevron-left" size={15} /> {t('settings.returnTo', { step: t(`step.${app.returnStep}` as MessageKey) })}
          </button>
        {:else}
        <button type="button" class="btn btn-secondary" disabled={!!app.busy || (!form.dirty && !form.incomplete)} onclick={discard}>{t('settings.discard')}</button>
        <button type="submit" class="btn btn-primary" disabled={!!app.busy || form.hasBlockingError || !form.dirty}>
          <Icon name="check" size={15} /> {t(app.busy === 'settings' ? 'settings.saving' : app.returnStep ? 'settings.saveReturn' : 'common.save')}
        </button>
        {/if}
        </div>
      </footer>
    {/if}
  </form>
</div>

{#if app.pendingLeave}
  <Dialog title={t('settings.leave.title')} hideClose onClose={() => app.resolveLeave(false)}>
    <p>{t('settings.leave.body')}</p>
    {#if form.hasBlockingError}<p class="sf-error" role="alert">{t('settings.fixErrors')}</p>{/if}
    {#if app.settingsSaveError}<p class="sf-error" role="alert">{app.settingsSaveError}</p>{/if}
    {#snippet actions()}
      <button type="button" class="btn btn-quiet leave-stay" disabled={!!app.busy} onclick={() => app.resolveLeave(false)}>{t('settings.leave.stay')}</button>
      <button type="button" class="btn btn-secondary" disabled={!!app.busy} onclick={leaveWithoutSaving}>{t('settings.leave.discard')}</button>
      <button type="button" class="btn btn-primary" data-autofocus disabled={!!app.busy || form.hasBlockingError} onclick={saveAndLeave}>
        {t(app.busy === 'settings' ? 'settings.saving' : 'settings.leave.save')}
      </button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .settings > :global(*), .settings-form > fieldset { max-width: 920px; }
  .settings > .settings-form { max-width: none; }
  .settings-form { display: grid; gap: var(--space-4); }
  .settings-form > fieldset { display: grid; min-width: 0; margin: 0 auto; padding: 0; border: 0; max-width: 920px; width: 100%; }
  .settings-form > fieldset :global(input), .settings-form > fieldset :global(select), .settings-form > fieldset :global(textarea), .settings-form > fieldset :global(button), .settings-form > fieldset :global(summary) { scroll-margin-block-end: calc(var(--settings-save-height) + var(--space-4)); }
  .tabs { display: flex; gap: var(--space-1); max-width: 920px; width: 100%; margin-inline: auto; overflow-x: auto; border-block-end: 1px solid var(--border); }
  .tab { background: none; border: 0; position: relative; display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 var(--space-4); border-radius: var(--radius-md) var(--radius-md) 0 0; color: var(--text-secondary); font-size: var(--text-md); font-weight: 600; white-space: nowrap; }
  .tab[aria-selected='true'] { color: var(--accent-text); }
  .tab[aria-selected='true']::after { content: ''; position: absolute; inset-inline: var(--space-2); inset-block-end: -1px; height: 2px; border-radius: 2px; background: var(--accent); }
  .tab.invalid:not([aria-selected='true']) { color: var(--danger-text); }
  .tab:focus-visible { outline-offset: -2px; }
  @media (hover: hover) { .tab:hover { color: var(--text); background: var(--bg-hover); } }
  @media (forced-colors: active) { .tab[aria-selected='true'] { text-decoration: underline; text-underline-offset: 4px; } }
  .dot { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: var(--radius-full); background: var(--accent); color: var(--text-on-accent); font-size: var(--text-xs); font-weight: 700; }
  .panel { display: grid; gap: var(--space-4); min-width: 0; }
  .panel[hidden] { display: none; }

  /* Section cards of the app tab (updates, data, reset in AppMaintenance) when they are plain cards. */
  .settings :global(.settings-section) { padding: var(--space-5); display: grid; gap: var(--space-4); min-width: 0; scroll-margin-block-start: var(--space-4); }
  .settings :global(.section-head) { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: var(--space-3); min-width: 0; }
  .settings :global(.section-head h2) { display: block; font-size: var(--text-lg); font-weight: 600; line-height: 1.3; letter-spacing: -0.01em; }
  .settings :global(.section-head p) { display: block; max-width: 64ch; margin-top: 2px; color: var(--text-secondary); font-size: var(--text-sm); font-weight: 400; line-height: 1.5; }
  .settings :global(.section-icon) { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: var(--radius-md); background: var(--bg-sunken); border: 1px solid var(--border); color: var(--text-secondary); }
  .settings :global(.section-icon.danger) { background: var(--danger-soft); border-color: var(--danger-border); color: var(--danger-text); }

  /* A window footer, only there while there is something to save (or a way back to the step that needs it). */
  .save-bar { position: sticky; inset-block-end: calc(-1 * var(--pane-pad-bottom, 0px)); z-index: 15; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-3);
    margin: 0 calc(-1 * var(--pane-pad-x, 0px)) calc(-1 * var(--pane-pad-bottom, 0px)); padding: 10px var(--pane-pad-x, var(--space-4));
    border-top: 1px solid var(--border); background: var(--bg-toolbar); backdrop-filter: saturate(1.6) blur(16px); -webkit-backdrop-filter: saturate(1.6) blur(16px); }
  .save-bar.dirty { background: color-mix(in srgb, var(--accent-soft) 85%, transparent); border-top-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
  .save-status { display: grid; gap: var(--space-1); font-size: var(--text-sm); color: var(--text-secondary); }
  .save-bar.dirty .save-status { color: var(--accent-soft-text); }
  .save-error { flex: 1 1 260px; font-size: var(--text-sm); font-weight: 600; }
  .cross-tab-pending { margin: -4px 0 0; color: var(--text-secondary); font-size: var(--text-xs); }
  .save-buttons { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  :global(.dialog) .leave-stay { margin-inline-end: auto; }
  @media (max-width: 420px) {
    .settings :global(.settings-section) { padding: var(--space-4); }
    .save-bar { padding: var(--space-3); }
    .save-buttons { width: 100%; }
    .save-buttons .btn { flex: 1; }
  }
</style>
