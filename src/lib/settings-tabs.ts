import type { Settings } from './api';
import { copySettings } from './settings';

export type SettingsTab = 'translate' | 'scope' | 'advanced' | 'app';
export const SETTINGS_TABS: readonly SettingsTab[] = ['translate', 'scope', 'advanced', 'app'];

type Field = keyof Settings;

/**
 * Which tab each saved setting is edited on. The app tab holds only instant-apply items (appearance,
 * display language, update check), which are never part of a pending save.
 */
const TAB_OF: Partial<Record<Field, SettingsTab>> = {
  provider: 'translate', model: 'translate', openrouter_reasoning: 'translate',
  review_before_apply: 'translate', max_cost_usd: 'translate', glossary: 'translate', custom_prices: 'translate',
  target_language: 'translate', style_preset: 'translate', style_prompt: 'translate', custom_system_prompt: 'translate',
  resource_pack_enabled: 'scope', resource_pack_options: 'scope', external_resource_pack_paths: 'scope',
  skip_target_language_text: 'scope', source_overrides: 'scope',
  base_url: 'advanced', wire_format: 'advanced', temperature: 'advanced', batch_size: 'advanced', request_timeout: 'advanced',
  rpm_limit: 'advanced', tpm_limit: 'advanced', max_batch_retries: 'advanced', max_file_write_retries: 'advanced',
  continue_on_file_error: 'advanced', concurrency: 'advanced'
};

/** File and key rules sit on the advanced tab; the category switches of the scan options on the scope tab. */
const ADVANCED_SCAN_LISTS = new Set(['region_dirs', 'skip_patterns', 'component_translate_key_prefixes']);

export type PendingChanges = Record<SettingsTab, number>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** How many saved settings differ from the saved copy, counted per tab. */
export function pendingChanges(draft: Settings, saved: Settings, extra: { keyTyped: boolean; storageModeChanged: boolean }): PendingChanges {
  const next = copySettings(draft);
  const before = copySettings(saved);
  const counts: PendingChanges = { translate: 0, scope: 0, advanced: 0, app: 0 };
  for (const field of Object.keys(TAB_OF) as Field[]) {
    if (!same(next[field], before[field])) counts[TAB_OF[field]!] += 1;
  }
  const options = next.scan_options!;
  const previous = before.scan_options!;
  for (const key of Object.keys(options) as (keyof typeof options)[]) {
    if (!same(options[key], previous[key])) counts[ADVANCED_SCAN_LISTS.has(key) ? 'advanced' : 'scope'] += 1;
  }
  if (extra.keyTyped) counts.translate += 1;
  if (extra.storageModeChanged) counts.translate += 1;
  return counts;
}

export function totalPending(counts: PendingChanges): number {
  return counts.translate + counts.scope + counts.advanced + counts.app;
}
