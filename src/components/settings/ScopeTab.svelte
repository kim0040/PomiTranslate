<script lang="ts">
  import Disclosure from '../Disclosure.svelte';
  import ExternalResourcePacks from '../ExternalResourcePacks.svelte';
  import ResourcePackSettings from '../ResourcePackSettings.svelte';
  import ScanScopeSettings from '../ScanScopeSettings.svelte';
  import SourceOverrides from '../SourceOverrides.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import type { SettingsDraft } from '../../lib/settings-draft.svelte';

  // Scan scope: what text is found, ZIP resource packs, saved manual translations.
  let { form }: { form: SettingsDraft } = $props();
</script>

<Disclosure id="scope-settings" icon="search" title={t('settings.scope.title')} open>
  <div class="sf-checks">
    <label class="sf-check">
      <input type="checkbox" bind:checked={form.draft.skip_target_language_text} />
      <span><strong>{t('settings.scope.skipTarget')}</strong><small>{t('settings.scope.skipTargetHelp')}</small></span>
    </label>
  </div>
  <ScanScopeSettings bind:options={form.draft.scan_options} />
</Disclosure>

<Disclosure id="resource-pack-settings" icon="archive" title={t('settings.scope.packTitle')} bind:open={form.packOpen} forceOpen={form.draft.resource_pack_enabled && form.packInvalid}>
  <label class="sf-check">
    <input type="checkbox" bind:checked={form.draft.resource_pack_enabled} />
    <span><strong>{t('settings.scope.pack')}</strong><small>{t('settings.scope.packHelp')}</small></span>
  </label>
  {#if form.draft.resource_pack_enabled}
    <ResourcePackSettings bind:options={form.draft.resource_pack_options} bind:invalid={form.packInvalid} />
    <ExternalResourcePacks bind:paths={form.draft.external_resource_pack_paths} />
  {/if}
</Disclosure>

<Disclosure id="manual-translations" icon="pencil" title={t('settings.overrides.title')} subtitle={t('overrides.count', { count: Object.keys(form.draft.source_overrides ?? {}).length })} forceOpen={form.overridesInvalid}>
  <SourceOverrides bind:overrides={form.draft.source_overrides} bind:invalid={form.overridesInvalid} resetKey={form.draftEpoch} />
</Disclosure>
