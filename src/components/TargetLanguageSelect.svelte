<script lang="ts">
  import { untrack } from 'svelte';
  import { CUSTOM_LANGUAGE, LANGUAGES, languageChoice } from '../lib/languages';
  import { t } from '../lib/i18n/index.svelte';

  // Common languages by their own name, plus "type your own". The stored value is just the text, so a
  // language entered by hand in an earlier version is shown as custom and keeps working.
  let { id = 'target-language', value = $bindable(''), describedby }: { id?: string; value?: string; describedby?: string } = $props();

  let forceCustom = $state(false);
  let written: string | null = null;
  // A change that did not come from this control (discard, import, reset) decides the mode again.
  $effect(() => {
    const current = value;
    untrack(() => {
      if (written !== null && current !== written) forceCustom = false;
      written = current;
    });
  });

  const choice = $derived(forceCustom ? CUSTOM_LANGUAGE : languageChoice(value));

  function pick(event: Event): void {
    const next = (event.currentTarget as HTMLSelectElement).value;
    if (next === CUSTOM_LANGUAGE) {
      forceCustom = true;
      return;
    }
    forceCustom = false;
    written = next;
    value = next;
  }
  function type(event: Event): void {
    written = (event.currentTarget as HTMLInputElement).value;
    value = written;
  }
</script>

<div class="language">
  <select {id} class="select" value={choice} aria-describedby={describedby} onchange={pick}>
    {#each LANGUAGES as language (language)}<option value={language}>{language}</option>{/each}
    <option value={CUSTOM_LANGUAGE}>{t('language.custom')}</option>
  </select>
  {#if choice === CUSTOM_LANGUAGE}
    <input id="{id}-custom" class="input" type="text" autocomplete="off" {value} oninput={type}
      aria-label={t('language.customLabel')} placeholder={t('language.customPlaceholder')} />
  {/if}
</div>

<style>
  .language { display: grid; gap: var(--space-2); min-width: 0; }
</style>
