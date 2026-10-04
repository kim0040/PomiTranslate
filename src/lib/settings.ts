import type { ScanOptions, Settings } from './api';
import type { MessageKey } from './i18n/index.svelte';
import { resourcePackOptions } from './resource-pack';

/** A complete, normalized copy of settings, so comparisons and drafts never share objects. */
export function copySettings(value: Settings): Settings {
  const finite = (input: unknown, fallback: number) => Number.isFinite(Number(input)) ? Number(input) : fallback;
  return {
    ...value,
    provider: value.provider || 'openai',
    model: value.model ?? '',
    openrouter_reasoning: value.openrouter_reasoning ?? 'default',
    base_url: value.base_url ?? '',
    wire_format: value.wire_format || 'openai',
    target_language: value.target_language || '한국어',
    style_preset: value.style_preset || 'neutral',
    style_prompt: value.style_prompt ?? '',
    custom_system_prompt: value.custom_system_prompt ?? '',
    temperature: finite(value.temperature, 0.3),
    batch_size: finite(value.batch_size, 40),
    request_timeout: finite(value.request_timeout, 120),
    rpm_limit: finite(value.rpm_limit, 0),
    tpm_limit: finite(value.tpm_limit, 0),
    max_batch_retries: finite(value.max_batch_retries, 3),
    max_file_write_retries: finite(value.max_file_write_retries, 2),
    continue_on_file_error: value.continue_on_file_error !== false,
    source_overrides: { ...value.source_overrides },
    glossary: (value.glossary ?? []).map((entry) => ({ ...entry })),
    custom_prices: Object.fromEntries(Object.entries(value.custom_prices ?? {}).map(([key, price]) => [key, { ...price }])),
    concurrency: finite(value.concurrency, 4),
    resource_pack_enabled: !!value.resource_pack_enabled,
    resource_pack_options: resourcePackOptions(value.resource_pack_options),
    external_resource_pack_paths: [...(value.external_resource_pack_paths ?? [])],
    skip_target_language_text: value.skip_target_language_text !== false,
    scan_options: normalizedScanOptions(value.scan_options),
    ui_language: value.ui_language || 'ko',
    last_world_dir: value.last_world_dir || ''
  };
}

export function defaultScanOptions(): ScanOptions {
  return {
    translate_signs: true, translate_books: true, translate_custom_names: true, translate_item_names: true,
    translate_lore: true, translate_titles: true, translate_filtered_titles: true, translate_command_output: true,
    translate_text_displays: true, skip_command_like_text: true,
    region_dirs: ['region', 'entities', 'DIM-1/region', 'DIM-1/entities', 'DIM1/region', 'DIM1/entities'],
    skip_patterns: ['*.bak_translate'], component_translate_key_prefixes: []
  };
}

/** Presets change categories only; custom file rules stay intact. */
export function applyScanPreset(options: ScanOptions, preset: 'recommended' | 'story' | 'all'): ScanOptions {
  const defaults = defaultScanOptions();
  return {
    ...options,
    ...Object.fromEntries(Object.entries(defaults).filter(([, value]) => typeof value === 'boolean')),
    translate_text_displays: options.translate_text_displays,
    translate_item_names: preset !== 'story',
    translate_lore: preset !== 'story'
  };
}

export function normalizedScanOptions(options?: Partial<ScanOptions>): ScanOptions {
  const defaults = defaultScanOptions();
  return {
    ...Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, options?.[key as keyof ScanOptions] ?? value])) as ScanOptions,
    region_dirs: [...(options?.region_dirs ?? defaults.region_dirs)],
    skip_patterns: [...(options?.skip_patterns ?? defaults.skip_patterns)],
    component_translate_key_prefixes: [...(options?.component_translate_key_prefixes ?? defaults.component_translate_key_prefixes)]
  };
}

/** Explicit public fields prevent unknown backend preferences from entering an export. */
export function publicSettingsForExport(settings: Settings): Settings {
  return {
    provider: settings.provider, model: settings.model, base_url: settings.base_url, wire_format: settings.wire_format,
    openrouter_reasoning: settings.openrouter_reasoning ?? 'default',
    target_language: settings.target_language, style_preset: settings.style_preset,
    style_prompt: settings.style_prompt, custom_system_prompt: settings.custom_system_prompt,
    temperature: settings.temperature, batch_size: settings.batch_size, request_timeout: settings.request_timeout,
    rpm_limit: settings.rpm_limit, tpm_limit: settings.tpm_limit, max_batch_retries: settings.max_batch_retries,
    max_file_write_retries: settings.max_file_write_retries, continue_on_file_error: settings.continue_on_file_error,
    review_before_apply: settings.review_before_apply !== false, max_cost_usd: settings.max_cost_usd ?? 0,
    source_overrides: { ...settings.source_overrides },
    glossary: (settings.glossary ?? []).map((entry) => ({ ...entry })),
    custom_prices: Object.fromEntries(Object.entries(settings.custom_prices ?? {}).map(([key, price]) => [key, {
      input: price.input, output: price.output, ...(price.updatedAt ? { updatedAt: price.updatedAt } : {})
    }])),
    concurrency: settings.concurrency, resource_pack_enabled: settings.resource_pack_enabled, resource_pack_options: resourcePackOptions(settings.resource_pack_options),
    skip_target_language_text: settings.skip_target_language_text, scan_options: normalizedScanOptions(settings.scan_options),
    ui_language: settings.ui_language, last_world_dir: settings.last_world_dir
  };
}

/** Stable comparison uses values, including list order, rather than object identity. */
export function scanOptionsSignature(options?: Partial<ScanOptions>): string {
  const normalized = normalizedScanOptions(options);
  return JSON.stringify(Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b))));
}

/** The style presets of the translation prompt, in the order a select lists them. */
export const STYLE_PRESETS: { value: string; label: MessageKey }[] = [
  { value: 'neutral', label: 'settings.style.neutral' },
  { value: 'casual', label: 'settings.style.casual' },
  { value: 'formal', label: 'settings.style.formal' },
  { value: 'polite', label: 'settings.style.polite' },
  { value: 'story', label: 'settings.style.story' },
  { value: 'custom', label: 'settings.style.custom' }
];
