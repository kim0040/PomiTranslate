<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';
  import type { CredentialMode } from '../lib/api';
  import { connectionErrorKey } from '../lib/models';
  import { openExternal } from '../lib/native';
  import { keyPageFor, type ProviderId } from '../lib/providers';
  import Icon from './Icon.svelte';

  // The key is checked as soon as it is pasted or the field is left, by asking the provider for its
  // model list with the typed key. Nothing is saved until the last step.
  let {
    provider, apiKey = $bindable(''), storedKey, storageMode, status, count, errorCode, onDraftChange, onCheck, onRetry, onSettings
  }: {
    provider: ProviderId; apiKey?: string; storedKey: boolean; storageMode: CredentialMode; status: 'idle' | 'checking' | 'ok' | 'error'; count: number;
    errorCode: string; onDraftChange: () => void; onCheck: () => void; onRetry: () => void; onSettings: () => void;
  } = $props();

  let show = $state(false);
  const page = $derived(keyPageFor(provider));
  const typed = $derived(!!apiKey.trim());
  const storageModeLabel = $derived(t(`settings.vault.${storageMode}` as MessageKey));

  function onPaste(): void {
    // The pasted text reaches the field after this event.
    setTimeout(onCheck, 0);
  }
</script>

<div class="key-step">
  <p class="lead">{t('setup.key.lead')}</p>
  {#if page}
    <div><button type="button" class="btn btn-secondary btn-sm" onclick={() => void openExternal(page).catch((cause) => app.fail(cause))}>
      <Icon name="key" size={14} /> {t('setup.provider.keyPage')}
    </button></div>
  {/if}

  {#if storedKey && !typed}
    <p class="stored"><Icon name="check" size={14} /> {t('setup.key.stored')}</p>
  {/if}
  <div class="field">
    <label class="label" for="setup-api-key">{storedKey ? t('settings.apiKey.new') : t('settings.apiKey.label')}</label>
    <div class="secret-input">
      <input id="setup-api-key" class="input" type={show ? 'text' : 'password'} bind:value={apiKey} autocomplete="new-password" spellcheck="false"
        placeholder={t('setup.key.placeholder')} data-step-focus oninput={onDraftChange} onpaste={onPaste} onblur={() => { if (typed) onCheck(); }}
        onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onCheck(); } }} />
      <button type="button" class="btn btn-secondary btn-icon" aria-label={show ? t('settings.apiKey.hide') : t('settings.apiKey.show')}
        title={show ? t('settings.apiKey.hide') : t('settings.apiKey.show')} onclick={() => (show = !show)}><Icon name={show ? 'eye-off' : 'eye'} size={18} /></button>
    </div>
  </div>

  <div class="check-row" role="status" aria-live="polite">
    {#if status === 'checking'}
      <span class="state"><span class="spin" aria-hidden="true"><Icon name="refresh" size={14} /></span> {t('setup.key.checking')}</span>
    {:else if status === 'ok'}
      <span class="state ok"><Icon name="check-circle" size={16} /> {t('setup.key.connected', { count })}</span>
    {:else if status === 'error'}
      <span class="state bad"><Icon name="alert-circle" size={16} /> {t(connectionErrorKey(errorCode))}</span>
    {/if}
    {#if status !== 'checking' && (typed || storedKey)}
      <button type="button" class="btn btn-quiet btn-sm" onclick={onRetry}>{t('settings.apiKey.check')}</button>
    {/if}
  </div>

  <p class="note"><Icon name="shield" size={14} /> <span>{t('setup.key.storage', { mode: storageModeLabel })} <button type="button" class="linklike" onclick={onSettings}>{t('setup.key.storageLink')}</button></span></p>
</div>

<style>
  .key-step { display: grid; gap: var(--space-3); min-width: 0; }
  .lead { margin: 0; }
  .field { display: grid; gap: var(--space-2); }
  .label { color: var(--text); font-size: var(--text-md); font-weight: 600; }
  .secret-input { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2); }
  .secret-input .btn { min-height: var(--control-height); }
  .input { font-family: var(--font-mono); }
  .stored { margin: 0; display: inline-flex; align-items: center; gap: 6px; color: var(--success-text); font-size: var(--text-sm); font-weight: 600; }
  .check-row { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2) var(--space-3); min-height: 28px; }
  .state { display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-sm); }
  .state.ok { color: var(--success-text); font-weight: 600; }
  .state.bad { color: var(--danger-text); }
  .note { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: var(--space-2); align-items: start; font-size: var(--text-sm); color: var(--text-secondary); }
  .note :global(.icon) { margin-top: 2px; }
  .linklike { background: none; border: 0; padding: 0; min-height: 0; cursor: pointer; color: var(--accent-text); text-decoration: underline; font-size: inherit; }
</style>
