<script lang="ts">
  import Disclosure from '../Disclosure.svelte';
  import FileRulesSettings from '../FileRulesSettings.svelte';
  import Icon from '../Icon.svelte';
  import { app } from '../../lib/app.svelte';
  import { t, type MessageKey } from '../../lib/i18n/index.svelte';
  import type { SettingsDraft } from '../../lib/settings-draft.svelte';

  // Advanced: speed and retries, file and key rules, the custom endpoint, import and export.
  let { form }: { form: SettingsDraft } = $props();
  let importInput: HTMLInputElement;

  function rangeText(label: MessageKey, minimum: string, maximum: string): string {
    return `${t(label)}: ${minimum}\u2013${maximum}`;
  }
</script>

<Disclosure id="performance-settings" icon="gauge" title={t('settings.speed.title')} subtitle={t('settings.speed.subtitle')} open forceOpen={form.hasRangeError}>
  <div class="sf-fields sf-three">
    <div class="sf-field">
      <label class="sf-label" for="concurrency">{t('settings.speed.concurrency')}</label>
      <input id="concurrency" class="input sf-input" class:invalid={form.rangeInvalid.concurrency} type="number" min="1" max="8" step="1" bind:value={form.draft.concurrency} aria-invalid={form.rangeInvalid.concurrency} aria-describedby={form.rangeInvalid.concurrency ? 'concurrency-error' : 'concurrency-help'} />
      <span id="concurrency-help" class="sf-hint">{t('settings.speed.concurrencyHelp')}</span>
      {#if form.rangeInvalid.concurrency}<span id="concurrency-error" class="sf-error" role="alert">{rangeText('settings.speed.concurrency', '1', '8')}</span>{/if}
    </div>
    <div class="sf-field">
      <label class="sf-label" for="batch-size">{t('settings.speed.batch')}</label>
      <input id="batch-size" class="input sf-input" class:invalid={form.rangeInvalid.batch} type="number" min="1" max="200" step="1" bind:value={form.draft.batch_size} aria-invalid={form.rangeInvalid.batch} aria-describedby={form.rangeInvalid.batch ? 'batch-error' : 'batch-help'} />
      <span id="batch-help" class="sf-hint">{t('settings.speed.batchHelp')}</span>
      {#if form.rangeInvalid.batch}<span id="batch-error" class="sf-error" role="alert">{rangeText('settings.speed.batch', '1', '200')}</span>{/if}
    </div>
    <div class="sf-field">
      <label class="sf-label" for="temperature">{t('settings.speed.temperature')}</label>
      <input id="temperature" class="input sf-input" class:invalid={form.rangeInvalid.temperature} type="number" min="0" max="2" step="0.1" bind:value={form.draft.temperature} aria-invalid={form.rangeInvalid.temperature} aria-describedby={form.rangeInvalid.temperature ? 'temperature-error' : 'temperature-help'} />
      <span id="temperature-help" class="sf-hint">{t('settings.speed.temperatureHelp')}</span>
      {#if form.rangeInvalid.temperature}<span id="temperature-error" class="sf-error" role="alert">{rangeText('settings.speed.temperature', '0', '2')}</span>{/if}
    </div>
    <div class="sf-field">
      <label class="sf-label" for="timeout">{t('settings.speed.timeout')}</label>
      <input id="timeout" class="input sf-input" class:invalid={form.rangeInvalid.timeout} type="number" min="5" max="600" step="1" bind:value={form.draft.request_timeout} aria-invalid={form.rangeInvalid.timeout} aria-describedby={form.rangeInvalid.timeout ? 'timeout-error' : 'timeout-help'} />
      <span id="timeout-help" class="sf-hint">{t('settings.speed.timeoutHelp')}</span>
      {#if form.rangeInvalid.timeout}<span id="timeout-error" class="sf-error" role="alert">{rangeText('settings.speed.timeout', '5', '600')}</span>{/if}
    </div>
    <div class="sf-field">
      <label class="sf-label" for="retries">{t('settings.speed.retries')}</label>
      <input id="retries" class="input sf-input" class:invalid={form.rangeInvalid.retries} type="number" min="0" max="10" step="1" bind:value={form.draft.max_batch_retries} aria-invalid={form.rangeInvalid.retries} aria-describedby={form.rangeInvalid.retries ? 'retries-error' : 'retries-help'} />
      <span id="retries-help" class="sf-hint">{t('settings.speed.retriesHelp')}</span>
      {#if form.rangeInvalid.retries}<span id="retries-error" class="sf-error" role="alert">{rangeText('settings.speed.retries', '0', '10')}</span>{/if}
    </div>
    <div class="sf-field">
      <label class="sf-label" for="write-retries">{t('settings.speed.writeRetries')}</label>
      <input id="write-retries" class="input sf-input" type="number" min="1" max="10" step="1" bind:value={form.draft.max_file_write_retries} aria-invalid={form.rangeInvalid.writeRetries} aria-describedby="write-retries-help" />
      <span id="write-retries-help" class="sf-hint">{t('settings.speed.writeRetriesHelp')}</span>
      {#if form.rangeInvalid.writeRetries}<span class="sf-error" role="alert">{rangeText('settings.speed.writeRetries', '1', '10')}</span>{/if}
    </div>
    <div class="sf-field">
      <label class="sf-label" for="rpm">{t('settings.speed.rpm')}</label>
      <input id="rpm" class="input sf-input" class:invalid={form.rangeInvalid.rpm} type="number" min="0" max="10000" step="1" bind:value={form.draft.rpm_limit} aria-invalid={form.rangeInvalid.rpm} aria-describedby={form.rangeInvalid.rpm ? 'rpm-error' : 'rpm-help'} />
      <span id="rpm-help" class="sf-hint">{t('settings.speed.rpmHelp')}</span>
      {#if form.rangeInvalid.rpm}<span id="rpm-error" class="sf-error" role="alert">{rangeText('settings.speed.rpm', '0', '10,000')}</span>{/if}
    </div>
    <div class="sf-field">
      <label class="sf-label" for="tpm">{t('settings.speed.tpm')}</label>
      <input id="tpm" class="input sf-input" class:invalid={form.rangeInvalid.tpm} type="number" min="0" max="10000000" step="100" bind:value={form.draft.tpm_limit} aria-invalid={form.rangeInvalid.tpm} aria-describedby={form.rangeInvalid.tpm ? 'tpm-error' : 'tpm-help'} />
      <span id="tpm-help" class="sf-hint">{t('settings.speed.tpmHelp')}</span>
      {#if form.rangeInvalid.tpm}<span id="tpm-error" class="sf-error" role="alert">{rangeText('settings.speed.tpm', '0', '10,000,000')}</span>{/if}
    </div>
    <label class="sf-check sf-field sf-full"><input type="checkbox" bind:checked={form.draft.continue_on_file_error} aria-describedby="continue-help" /><span><strong>{t('settings.speed.continueFiles')}</strong><small id="continue-help">{t('settings.speed.continueHelp')}</small></span></label>
  </div>
  <div><button type="button" class="btn btn-quiet btn-sm" onclick={() => form.resetSpeed()}><Icon name="undo" size={14} /> {t('settings.sectionDefaults')}</button></div>
</Disclosure>

<Disclosure id="file-rules" icon="list" title={t('settings.scope.fileRules')} subtitle={t('settings.scope.fileRulesHelp')}>
  <FileRulesSettings bind:options={form.draft.scan_options} />
  <div><button type="button" class="btn btn-quiet btn-sm" onclick={() => form.resetRules()}><Icon name="undo" size={14} /> {t('settings.sectionDefaults')}</button></div>
</Disclosure>

{#if form.isCustom}
  <Disclosure id="custom-endpoint" icon="sliders" title={t('settings.endpoint.title')} subtitle={t('settings.endpoint.help')} open forceOpen={form.baseUrlInvalid}>
    <div class="sf-fields sf-two">
      <div class="sf-field sf-full">
        <label class="sf-label" for="base-url">{t('settings.baseUrl.label')}</label>
        <input
          id="base-url"
          class="input"
          class:invalid={form.baseUrlInvalid}
          type="url"
          bind:value={form.draft.base_url}
          placeholder="https://example.com/v1"
          autocomplete="url"
          aria-invalid={form.baseUrlInvalid}
          aria-describedby={form.baseUrlInvalid ? 'base-url-error' : undefined}
        />
        {#if form.baseUrlInvalid}<span id="base-url-error" class="sf-error" role="alert">{t('settings.baseUrl.invalid')}</span>{/if}
      </div>
      <div class="sf-field">
        <label class="sf-label" for="wire-format">{t('settings.wire.label')}</label>
        <select id="wire-format" class="select" bind:value={form.draft.wire_format}>
          <option value="openai">OpenAI Chat</option>
          <option value="anthropic">Anthropic Messages</option>
        </select>
      </div>
    </div>
  </Disclosure>
{/if}

<Disclosure id="settings-management" icon="upload" title={t('settings.manage')} subtitle={t('settings.manageHelp')}>
  <div class="sf-row">
    <input type="file" accept="application/json,.json,.py" bind:this={importInput} onchange={(event) => form.importFrom(event.currentTarget)} hidden />
    <button type="button" class="btn btn-secondary" disabled={!!app.busy || form.importingSettings} onclick={() => importInput.click()}>{t('settings.import.action')}</button>
    <button type="button" class="btn btn-secondary" disabled={!!app.busy} onclick={() => form.exportDraft()}>{t('settings.export')}</button>
    <button type="button" class="btn btn-quiet" disabled={!!app.busy} onclick={() => form.resetToDefaults()}>{t('settings.resetDraft')}</button>
  </div>
  <p class="sf-hint">{t('settings.import.help')}</p>
</Disclosure>
