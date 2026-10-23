<script lang="ts">
  import Dialog from '../Dialog.svelte';
  import Disclosure from '../Disclosure.svelte';
  import GlossaryEditor from '../GlossaryEditor.svelte';
  import Icon from '../Icon.svelte';
  import ModelPicker from '../ModelPicker.svelte';
  import TargetLanguageSelect from '../TargetLanguageSelect.svelte';
  import { app } from '../../lib/app.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { connectionErrorKey } from '../../lib/models';
  import { PROVIDER_CHOICES, providerLabel } from '../../lib/providers';
  import { REASONING_PROVIDERS, defaultReasoningLabel, effortLabel } from '../../lib/reasoning';
  import { STYLE_PRESETS } from '../../lib/settings';
  import type { SettingsDraft } from '../../lib/settings-draft.svelte';

  // The everyday choices come first: provider, model, key, target language, cost limit. Reasoning,
  // custom prices, how the key is stored, writing style and the glossary sit in one collapsed
  // "Advanced" section that opens by itself when something inside it needs attention.
  let { form, onOpenEndpoint }: { form: SettingsDraft; onOpenEndpoint: () => void } = $props();

  const advancedNeedsAttention = $derived(form.reasoningInvalid || form.customPriceInvalid || form.customPriceIncomplete || form.glossaryInvalid);
  const capUnenforceable = $derived(Number(form.draft.max_cost_usd) > 0 && !!form.draft.model.trim() && !form.catalogPriceAvailable &&
    !form.draft.custom_prices?.[form.selectedPriceKey]);
</script>

<Disclosure id="provider-settings" icon="key" title={t('settings.provider.title')} subtitle={t('settings.provider.help')} open>
  <div class="sf-fields sf-two">
    <div class="sf-field">
      <label class="sf-label" for="provider">{t('settings.provider.label')}</label>
      <select id="provider" class="select" value={form.draft.provider} onchange={(event) => form.providerChanged(event.currentTarget.value)}>
        {#each PROVIDER_CHOICES as provider (provider)}<option value={provider}>{providerLabel(provider)}</option>{/each}
      </select>
    </div>
    <div class="sf-field">
      <label class="sf-label" for="model">{t('settings.model.label')}</label>
      <ModelPicker id="model" bind:value={form.draft.model} models={form.models} placeholder={t('settings.model.placeholder')} describedby="model-hint" />
      <div class="sf-actions">
        <button type="button" class="btn btn-secondary btn-sm" disabled={!!app.busy || form.baseUrlInvalid} onclick={() => form.loadModels(true)}>
          <Icon name="refresh" size={15} /> {t(app.busy === 'models' ? 'settings.model.listing' : 'settings.model.refresh')}
        </button>
        {#if form.draft.provider === 'openrouter'}<span class="sf-hint">{t('settings.model.public')}</span>{/if}
      </div>
      <div id="model-hint" class="sf-hint" role="status" aria-live="polite">
        {#if form.visibleModelError}<span class="sf-error">{form.visibleModelError}</span>
        {:else if app.busy === 'models'}{t('settings.model.listing')}
        {:else if form.draft.model.trim() && form.models.length && !form.reasoningModel}{t('settings.model.notFound')}
        {:else if form.reasoningModel}{t('settings.model.verified')}{#if app.modelsCached} · {t('settings.model.cached')}{/if}{/if}
      </div>
    </div>
    {#if form.isCustom}
      <p class="sf-hint sf-full">
        {t('settings.endpoint.pointer')}
        <button type="button" class="sf-link" onclick={onOpenEndpoint}>{t('settings.endpoint.open')}</button>
        {#if form.baseUrlInvalid}<span class="sf-error" role="alert"> {t('settings.baseUrl.invalid')}</span>{/if}
      </p>
    {/if}
    <div class="sf-field sf-full key-status">
      <div class="sf-label-row">
        <span class="sf-label">{t('settings.apiKey.label')}</span>
        {#if form.credentialLoading}<span class="sf-hint" role="status">{t('common.loading')}</span>
        {:else if form.stored === true}<span class="pill pill-success"><Icon name="check" size={13} /> {t('settings.apiKey.stored')}</span>
        {:else if form.stored === false}<span class="pill">{t('settings.apiKey.missing')}</span>{/if}
      </div>
      {#if form.stored}<span class="sf-hint">{t(form.savedCredentialMode === 'local' ? 'settings.vault.local' : form.savedCredentialMode === 'session' ? 'settings.vault.session' : 'settings.vault.keychain')}</span>{/if}
      {#if form.stored && !form.editingKey}
        <div class="sf-actions">
          <button type="button" class="btn btn-secondary btn-sm" onclick={() => (form.editingKey = true)}>{t('settings.apiKey.change')}</button>
          <button type="button" class="btn btn-danger btn-sm" disabled={!!app.busy} onclick={() => (form.showDeleteConfirm = true)}>{t('settings.apiKey.delete')}</button>
        </div>
      {/if}
      {#if form.stored === false || form.editingKey || form.apiKey}
        <div class="sf-field">
          <label class="sf-label" for="api-key">{t('settings.apiKey.new')}</label>
          <div class="sf-secret">
            <input id="api-key" class="input sf-input" type={form.showApiKey ? 'text' : 'password'} bind:value={form.apiKey} autocomplete="new-password" placeholder={t('settings.apiKey.placeholder')} spellcheck="false"
              oninput={() => { form.connection = { status: 'idle', count: 0, code: '' }; }} />
            <button type="button" class="btn btn-secondary btn-icon" aria-label={form.showApiKey ? t('settings.apiKey.hide') : t('settings.apiKey.show')} title={form.showApiKey ? t('settings.apiKey.hide') : t('settings.apiKey.show')} onclick={() => (form.showApiKey = !form.showApiKey)}><Icon name={form.showApiKey ? 'eye-off' : 'eye'} size={18} /></button>
          </div>
          <span class="sf-hint">{t('settings.apiKey.help')}</span>
          {#if form.stored}<button type="button" class="btn btn-quiet btn-sm key-cancel" onclick={() => form.cancelKeyChange()}>{t('settings.apiKey.cancelChange')}</button>{/if}
        </div>
      {/if}
      <div class="sf-actions">
        <button type="button" class="btn btn-secondary btn-sm" disabled={!!app.busy || form.baseUrlInvalid || (!form.stored && !form.apiKey.trim())} onclick={() => form.checkKey()}>
          <Icon name="check-circle" size={15} /> {t(form.connection.status === 'checking' ? 'setup.key.checking' : 'settings.apiKey.check')}
        </button>
        <span class="sf-hint" role="status" aria-live="polite">
          {#if form.connection.status === 'ok'}<span class="sf-ok"><Icon name="check" size={13} /> {t('setup.key.connected', { count: form.connection.count })}</span>
          {:else if form.connection.status === 'error'}<span class="sf-error">{t(connectionErrorKey(form.connection.code))}</span>{/if}
        </span>
      </div>
      {#if form.credentialError}<p class="sf-error" role="alert">{form.credentialError}</p>{/if}
    </div>
  </div>
</Disclosure>

<Disclosure id="translation-settings" icon="language" title={t('settings.language.title')} subtitle={t('settings.language.subtitle')} open>
  <div class="sf-fields sf-two">
    <div class="sf-field">
      <label class="sf-label" for="target-language">{t('settings.language.target')}</label>
      <TargetLanguageSelect id="target-language" bind:value={form.draft.target_language} describedby="target-language-help" />
      <span id="target-language-help" class="sf-hint">{t('settings.language.targetHelp')}</span>
    </div>
  </div>
</Disclosure>

<Disclosure id="cost-protection" icon="shield" title={t('settings.costProtection.title')} subtitle={t('settings.costProtection.subtitle')} open forceOpen={form.rangeInvalid.maxCost}>
  <div class="sf-fields sf-two">
    <label class="sf-check">
      <input type="checkbox" bind:checked={form.draft.review_before_apply} />
      <span><strong>{t('settings.costProtection.review')}</strong><small>{t('settings.costProtection.reviewHelp')}</small></span>
    </label>
    <div class="sf-field">
      <label class="sf-label" for="max-cost-usd">{t('settings.costProtection.cap')}</label>
      <input id="max-cost-usd" class="input sf-input" type="number" min="0" max="1000" step="0.01" bind:value={form.draft.max_cost_usd}
        aria-invalid={form.rangeInvalid.maxCost} aria-describedby="max-cost-help max-cost-error" />
      <span id="max-cost-help" class="sf-hint">{t('settings.costProtection.capHelp')}</span>
      {#if Number(form.draft.max_cost_usd) === 0 && !form.rangeInvalid.maxCost}<span class="sf-hint warn">{t('settings.costProtection.noneNote')}</span>{/if}
      {#if capUnenforceable}<span class="sf-hint warn">{t('settings.costProtection.unpricedNote')}</span>{/if}
      {#if form.rangeInvalid.maxCost}<span id="max-cost-error" class="sf-error" role="alert">{t('settings.costProtection.capError')}</span>{/if}
    </div>
  </div>
</Disclosure>

<Disclosure id="translate-advanced" icon="sliders" title={t('settings.advanced.title')} subtitle={t('settings.advanced.subtitle')} bind:open={form.advancedOpen} forceOpen={advancedNeedsAttention}>
  {#if REASONING_PROVIDERS.includes(form.draft.provider)}
    <div class="sf-field reasoning" id="reasoning-settings">
      <fieldset class="reasoning-modes" aria-describedby="reasoning-help reasoning-default">
        <legend class="sf-label">{t('settings.reasoning.label')}</legend>
        <div class="mode-options">
          {#each ['default', 'disabled', 'custom'] as choice}
            <label class="mode-option" class:selected={form.mode === choice}>
              <input type="radio" name="reasoning-mode" value={choice} checked={form.mode === choice}
                disabled={choice !== 'default' && (!form.reasoningSupported || (choice === 'disabled' && !!form.reasoningMetadata?.mandatory))}
                onchange={() => form.chooseReasoning(choice as 'default' | 'disabled' | 'custom')} />
              <span>{t(choice === 'default' ? 'settings.reasoning.default' : choice === 'disabled' ? 'settings.reasoning.disabled' : 'settings.reasoning.custom')}</span>
            </label>
          {/each}
        </div>
      </fieldset>
      <span id="reasoning-default" class="sf-hint">{defaultReasoningLabel(form.reasoningModel)}</span>
      {#if form.mode === 'custom'}
        <div class="sf-field strength">
          <label class="sf-label" for="openrouter-reasoning">{t('settings.reasoning.strength')}</label>
          <select id="openrouter-reasoning" class="select" bind:value={form.draft.openrouter_reasoning}
            aria-describedby="reasoning-help" aria-invalid={form.reasoningInvalid}>
            {#if form.currentReasoning === 'enabled' || !form.reasoningEfforts.length}<option value="enabled">{t('settings.reasoning.unspecified')}</option>{/if}
            {#each form.reasoningEfforts as effort}<option value={effort}>{effortLabel(effort)}</option>{/each}
            {#if form.hiddenReasoning}<option value={form.currentReasoning}>{effortLabel(form.currentReasoning)}</option>{/if}
          </select>
        </div>
      {/if}
      <span id="reasoning-help" class="sf-hint">{t('settings.reasoning.help')}</span>
      {#if form.reasoningMetadata?.mandatory}<span class="sf-hint">{t('settings.reasoning.mandatory')}</span>{/if}
      {#if form.reasoningInvalid}<span class="sf-error" role="alert">{t('settings.reasoning.unsupported')}</span>{/if}
    </div>
  {/if}

  {#if form.draft.model.trim() && !form.catalogPriceAvailable}
    <div class="sf-group" id="user-model-price">
      <h3>{t('settings.price.title')}</h3>
      <p class="sf-hint">{t('settings.price.subtitle')}</p>
      <p id="custom-price-help" class="sf-hint">{t('settings.price.help')}</p>
      <div class="sf-fields sf-two">
        <div class="sf-field">
          <label class="sf-label" for="custom-price-input">{t('settings.price.input')}</label>
          <input id="custom-price-input" class="input sf-input" type="number" min="0" max="1000" step="any" value={form.customPriceInput}
            aria-invalid={form.customPriceInvalid} aria-describedby="custom-price-help custom-price-input-error"
            oninput={(event) => form.changeCustomPrice('input', event.currentTarget.value)} />
          {#if form.customPriceInvalid && form.customPriceInput}<span id="custom-price-input-error" class="sf-error" role="alert">{t('settings.price.range')}</span>{/if}
        </div>
        <div class="sf-field">
          <label class="sf-label" for="custom-price-output">{t('settings.price.output')}</label>
          <input id="custom-price-output" class="input sf-input" type="number" min="0" max="1000" step="any" value={form.customPriceOutput}
            aria-invalid={form.customPriceInvalid} aria-describedby="custom-price-help custom-price-output-error"
            oninput={(event) => form.changeCustomPrice('output', event.currentTarget.value)} />
          {#if form.customPriceInvalid && form.customPriceOutput}<span id="custom-price-output-error" class="sf-error" role="alert">{t('settings.price.range')}</span>{/if}
          {#if form.customPriceIncomplete}<span class="sf-error" role="alert">{t('settings.price.bothRequired')}</span>{/if}
        </div>
      </div>
      {#if form.draft.custom_prices?.[form.selectedPriceKey]}<p class="sf-hint">{t('settings.price.userBasis')}</p>{/if}
    </div>
  {/if}

  <div class="sf-group" id="key-storage">
    <Disclosure id="key-management" variant="inline" level={3} title={t('settings.vault.manage')} bind:open={form.keyOpen}>
      <div class="sf-field">
        <label class="sf-label" for="credential-mode">{t('settings.vault.mode')}</label>
        <select id="credential-mode" class="select" bind:value={form.credentialMode}>
          <option value="local">{t('settings.vault.local')}</option>
          <option value="session">{t('settings.vault.session')}</option>
          <option value="keychain">{t('settings.vault.keychain')}</option>
        </select>
        <span class="sf-hint">{t('settings.vault.help')}</span>
      </div>
      <div class="sf-field">
        <div><button type="button" class="btn btn-secondary" disabled={form.importing || !!app.busy} onclick={() => form.importExisting()}>{form.importing ? t('common.loading') : t('settings.vault.import')}</button></div>
        <span class="sf-hint">{t('settings.vault.importHelp')}</span>
      </div>
    </Disclosure>
    {#if form.draft.provider === 'openrouter'}
      <div class="usage-panel">
        <button type="button" class="btn btn-secondary" disabled={!!app.busy || !form.stored || !!form.apiKey.trim()} onclick={() => form.checkUsage()}>{app.busy === 'usage' ? t('common.loading') : t('settings.usage.check')}</button>
        <p class="sf-hint">{t('settings.usage.help')}</p>
        {#if form.usageError}<p class="sf-error" role="alert">{form.usageError}</p>{/if}
        <div role="status" aria-live="polite">
          {#each form.usageSnapshots as usage}
            <p class="sf-hint">{new Date(usage.checkedAt).toLocaleString()} · {t('settings.usage.total')}: {usage.usage.toFixed(6)}{usage.byokUsage !== null ? ` · BYOK: ${usage.byokUsage.toFixed(6)}` : ''}</p>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <div class="sf-group" id="style-settings">
    <h3>{t('settings.style.label')}</h3>
    <div class="sf-fields sf-two">
      <div class="sf-field">
        <label class="sf-label" for="style-preset">{t('settings.style.label')}</label>
        <select id="style-preset" class="select" bind:value={form.draft.style_preset}>
          {#each STYLE_PRESETS as style (style.value)}<option value={style.value}>{t(style.label)}</option>{/each}
        </select>
      </div>
      <div class="sf-field sf-full">
        <label class="sf-label" for="style-prompt">{t('settings.style.extra')} <span class="sf-optional">{t('common.optional')}</span></label>
        <textarea id="style-prompt" class="textarea" rows="3" bind:value={form.draft.style_prompt} placeholder={t('settings.style.extraPlaceholder')}></textarea>
      </div>
      <div class="sf-full">
        <Disclosure id="style-assist" variant="inline" level={3} title={t('settings.styleAssist.title')}>
          <div class="sf-field">
            <label class="sf-label" for="style-brief">{t('settings.styleAssist.brief')}</label>
            <textarea id="style-brief" class="textarea" rows="2" maxlength="4000" bind:value={form.styleBrief}></textarea>
            <p class="sf-hint">{t('settings.styleAssist.help')}</p>
            {#if form.styleError}<p class="sf-error" role="alert">{form.styleError}</p>{/if}
            <div><button type="button" class="btn btn-secondary" disabled={!!app.busy || !form.styleBrief.trim() || !form.draft.model.trim() || !!form.apiKey.trim() || !form.credentialState || form.hasBlockingError} onclick={() => (form.showStyleConfirm = true)}>{t('settings.styleAssist.action')}</button></div>
          </div>
        </Disclosure>
      </div>
      {#if form.draft.style_preset === 'custom'}
        <div class="sf-field sf-full">
          <label class="sf-label" for="custom-prompt">{t('settings.style.system')}</label>
          <textarea id="custom-prompt" class="textarea" rows="5" bind:value={form.draft.custom_system_prompt} placeholder={t('settings.style.system')}></textarea>
        </div>
      {/if}
    </div>
  </div>

  <div class="sf-group" id="global-glossary">
    <h3>{t('glossary.title')} <span class="sf-optional">{t('glossary.count', { count: form.draft.glossary?.length ?? 0 })}</span></h3>
    <GlossaryEditor bind:entries={form.draft.glossary} bind:invalid={form.glossaryInvalid} resetKey={form.draftEpoch} />
  </div>
</Disclosure>

{#if form.showStyleConfirm}
  <Dialog title={t('settings.styleAssist.title')} onClose={() => (form.showStyleConfirm = false)}>
    <p>{t('settings.styleAssist.confirm')}</p>
    <p><strong>{providerLabel(form.draft.provider)} · {form.draft.model}</strong></p>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" onclick={() => (form.showStyleConfirm = false)}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-primary" onclick={() => form.enhanceStyle()}>{t('settings.styleAssist.action')}</button>
    {/snippet}
  </Dialog>
{/if}

{#if form.showDeleteConfirm}
  <Dialog title={t('settings.apiKey.deleteTitle', { provider: providerLabel(form.draft.provider) })} onClose={() => (form.showDeleteConfirm = false)}>
    <p>{t('settings.apiKey.deleteBody')}</p>
    {#snippet actions()}
      <button type="button" class="btn btn-secondary" onclick={() => (form.showDeleteConfirm = false)}>{t('common.cancel')}</button>
      <button type="button" class="btn btn-danger-solid" onclick={() => form.deleteApiKey()}>{t('settings.apiKey.delete')}</button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .key-status { border-block-start: 1px solid var(--border); padding-block-start: var(--space-4); }
  .key-cancel { justify-self: start; }
  .usage-panel { display: grid; gap: var(--space-2); justify-items: start; }
  .reasoning-modes { border: 0; padding: 0; margin: 0; min-width: 0; }
  .reasoning-modes legend { margin-block-end: var(--space-2); }
  .mode-options { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .mode-option { display: flex; align-items: center; gap: var(--space-2); padding: 0 var(--space-3); min-height: var(--control-height); border: 1px solid var(--border-strong); border-radius: var(--radius-md); background: var(--bg-surface); font-size: var(--text-sm); }
  .mode-option.selected { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-soft-text); }
  .mode-option:has(input:disabled) { opacity: 0.6; cursor: default; }
  .mode-option input { accent-color: var(--accent); margin: 0; }
  .strength { max-width: 320px; }
  .warn { color: var(--warning-text); }
</style>
