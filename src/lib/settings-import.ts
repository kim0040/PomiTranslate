import { validateResourcePackOptions } from './resource-pack';
import type { ScanFlag, ScanOptions, Settings } from './api';
import { normalizedScanOptions, publicSettingsForExport } from './settings';
import { inspectGlossaryEntries } from './glossary-validation';

const MAX_IMPORT_BYTES = 1024 * 1024;
const MAX_MODEL_CHARS = 256;
const MAX_ENDPOINT_CHARS = 2048;
const MAX_LANGUAGE_CHARS = 256;
const MAX_STYLE_PROMPT_CHARS = 8000;
const MAX_CUSTOM_PROMPT_CHARS = 8000;

const SCAN_FLAGS: readonly ScanFlag[] = [
  'translate_signs', 'translate_books', 'translate_custom_names', 'translate_item_names', 'translate_lore',
  'translate_titles', 'translate_filtered_titles', 'translate_command_output', 'translate_text_displays',
  'skip_command_like_text'
];
const SCAN_LIST_LIMITS = {
  region_dirs: { items: 64, chars: 256 },
  skip_patterns: { items: 64, chars: 256 },
  component_translate_key_prefixes: { items: 128, chars: 256 }
} as const;
const STYLE_PRESETS = new Set(['neutral', 'casual', 'formal', 'polite', 'story', 'custom']);
const CUSTOM_WIRE_FORMATS = new Set(['openai', 'anthropic']);
const WIRE_FORMATS = new Set([...CUSTOM_WIRE_FORMATS, 'gemini']);
const BUILTIN_PROVIDERS: Record<string, { baseUrl: string; wireFormat: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', wireFormat: 'openai' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', wireFormat: 'gemini' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', wireFormat: 'anthropic' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', wireFormat: 'openai' },
  comet: { baseUrl: 'https://api.cometapi.com/v1', wireFormat: 'openai' }
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function object(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function charLength(value: string): number {
  return Array.from(value).length;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || charLength(value) > maximum) {
    throw new Error(`${label} must be a string of at most ${maximum} characters`);
  }
  return value;
}

function boundedNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  integer = false
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} must be a finite number from ${minimum} to ${maximum}`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

export function validateSourceOverrides(value: unknown): Record<string, string> {
  const source = object(value, 'source_overrides');
  if (Object.keys(source).length > 5000 || new TextEncoder().encode(JSON.stringify(source)).byteLength > MAX_IMPORT_BYTES) throw new Error('Too many source overrides');
  return Object.fromEntries(Object.entries(source).map(([key, target]) => {
    if (!key.trim() || charLength(key) > 32000) throw new Error('Invalid source');
    const cleaned = boundedString(target, 'translation', 32000).trim();
    if (!cleaned) throw new Error('Empty translation');
    for (const text of [key, cleaned]) {
      if (text.includes('\u0000') || Array.from(text).some((char) => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff)) throw new Error('Invalid Unicode');
    }
    return [key, cleaned];
  }));
}

function validCustomEndpoint(value: unknown, label: string): string {
  const endpoint = boundedString(value, label, MAX_ENDPOINT_CHARS).trim();
  if (!endpoint || /\s/.test(endpoint) || endpoint.includes('?') || endpoint.includes('#')) {
    throw new Error(`${label} must be an HTTP(S) endpoint without user info, query, or fragment`);
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) endpoint`);
  }
  const authority = endpoint.match(/^https?:\/\/([^/?#]*)/i)?.[1] ?? '';
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.hostname || authority.includes('@') ||
      parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an HTTP(S) endpoint without user info, query, or fragment`);
  }
  return endpoint;
}

export function isValidCustomEndpoint(value: string): boolean {
  try {
    validCustomEndpoint(value, 'endpoint');
    return true;
  } catch {
    return false;
  }
}

function optionalEndpoint(value: unknown, label: string): string {
  const endpoint = boundedString(value, label, MAX_ENDPOINT_CHARS).trim();
  return endpoint ? validCustomEndpoint(endpoint, label) : '';
}

function validatedScanOptions(value: unknown, label: string): Partial<ScanOptions> {
  const source = object(value, label);
  const result: Partial<ScanOptions> = {};
  for (const key of SCAN_FLAGS) {
    if (hasOwn(source, key)) result[key] = booleanValue(source[key], `${label}.${key}`);
  }
  for (const [key, limit] of Object.entries(SCAN_LIST_LIMITS) as Array<[keyof typeof SCAN_LIST_LIMITS, (typeof SCAN_LIST_LIMITS)[keyof typeof SCAN_LIST_LIMITS]]>) {
    if (!hasOwn(source, key)) continue;
    const raw = source[key];
    if (!Array.isArray(raw) || raw.length > limit.items) {
      throw new Error(`${label}.${key} must contain at most ${limit.items} strings`);
    }
    const entries = raw.map((entry, index) => {
      if (typeof entry !== 'string') throw new Error(`${label}.${key}[${index}] must be a string`);
      const cleaned = entry.trim();
      if (!cleaned || charLength(cleaned) > limit.chars || /[\u0000-\u001f]/.test(cleaned)) {
        throw new Error(`${label}.${key}[${index}] is empty, too long, or contains a control character`);
      }
      return cleaned;
    });
    result[key] = entries;
  }
  return result;
}

function importScanOptions(target: Settings, value: unknown, label: string): void {
  const patch = validatedScanOptions(value, label);
  target.scan_options = normalizedScanOptions({ ...target.scan_options, ...patch });
}

function validateWireFormat(value: unknown, label: string): string {
  const wireFormat = boundedString(value, label, 32).trim();
  if (!WIRE_FORMATS.has(wireFormat)) throw new Error(`${label} is unsupported`);
  return wireFormat;
}

function setStringField(
  target: Settings,
  source: JsonObject,
  key: 'model' | 'target_language' | 'style_prompt' | 'custom_system_prompt' | 'base_url' | 'wire_format',
  maximum: number,
  label: string = key
): void {
  if (!hasOwn(source, key)) return;
  const value = boundedString(source[key], label, maximum);
  if (key === 'model') target.model = value;
  else if (key === 'target_language') target.target_language = value;
  else if (key === 'style_prompt') target.style_prompt = value;
  else if (key === 'custom_system_prompt') target.custom_system_prompt = value;
  else if (key === 'base_url') target.base_url = value;
  else target.wire_format = validateWireFormat(value, label);
}

function setNumberField(target: Settings, source: JsonObject, key: string, labelPrefix: string): void {
  if (!hasOwn(source, key)) return;
  const rules: Record<string, [number, number, boolean]> = {
    temperature: [0, 2, false],
    batch_size: [1, 200, true],
    request_timeout: [5, 600, true],
    rpm_limit: [0, 10000, true],
    tpm_limit: [0, 10000000, true],
    max_batch_retries: [0, 10, true],
    max_file_write_retries: [1, 10, true],
    concurrency: [1, 8, true]
  };
  const rule = rules[key];
  if (!rule) return;
  const [minimum, maximum, integer] = rule;
  const value = boundedNumber(source[key], `${labelPrefix}.${key}`, minimum, maximum, integer);
  switch (key) {
    case 'temperature': target.temperature = value; break;
    case 'batch_size': target.batch_size = value; break;
    case 'request_timeout': target.request_timeout = value; break;
    case 'rpm_limit': target.rpm_limit = value; break;
    case 'tpm_limit': target.tpm_limit = value; break;
    case 'max_batch_retries': target.max_batch_retries = value; break;
    case 'max_file_write_retries': target.max_file_write_retries = value; break;
    case 'concurrency': target.concurrency = value; break;
  }
}

function setBooleanField(target: Settings, source: JsonObject, key: 'resource_pack_enabled' | 'skip_target_language_text', label: string): void {
  if (!hasOwn(source, key)) return;
  const value = booleanValue(source[key], label);
  if (key === 'resource_pack_enabled') target.resource_pack_enabled = value;
  else target.skip_target_language_text = value;
}

function validateCustomPrices(value: unknown): NonNullable<Settings['custom_prices']> {
  const prices = object(value, 'settings.custom_prices');
  if (Object.keys(prices).length > 1000) throw new Error('settings.custom_prices can contain at most 1000 prices');
  const normalized: NonNullable<Settings['custom_prices']> = {};
  for (const [key, raw] of Object.entries(prices)) {
    const separator = key.indexOf('/');
    const provider = separator >= 0 ? key.slice(0, separator) : '';
    const model = separator >= 0 ? key.slice(separator + 1) : '';
    if (!['openai', 'gemini', 'anthropic', 'openrouter', 'comet', 'custom'].includes(provider) || !model.trim()) {
      throw new Error('settings.custom_prices contains an invalid provider/model key');
    }
    const price = object(raw, `settings.custom_prices.${key}`);
    const rate = (name: 'input' | 'output') => {
      const item = price[name];
      if (typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 1000) {
        throw new Error(`settings.custom_prices.${key}.${name} must be between 0 and 1000`);
      }
      return item;
    };
    const updatedAt = price.updatedAt;
    if (updatedAt !== undefined && (typeof updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(updatedAt) || !Number.isFinite(Date.parse(updatedAt)))) {
      throw new Error(`settings.custom_prices.${key}.updatedAt must be an ISO timestamp`);
    }
    normalized[key] = { input: rate('input'), output: rate('output'), ...(typeof updatedAt === 'string' ? { updatedAt } : {}) };
  }
  return normalized;
}

function applyCurrentShape(target: Settings, source: JsonObject): void {
  const currentProvider = target.provider;
  const providerWasSupplied = hasOwn(source, 'provider');
  let selectedProvider: string | undefined;
  if (providerWasSupplied) {
    selectedProvider = boundedString(source.provider, 'settings.provider', 32).trim();
    if (!['openai', 'gemini', 'anthropic', 'openrouter', 'comet', 'custom'].includes(selectedProvider)) {
      throw new Error(`Unsupported provider: ${selectedProvider}`);
    }
    target.provider = selectedProvider;
  }

  if (hasOwn(source, 'openrouter_reasoning')) {
    const value = source.openrouter_reasoning;
    if (typeof value !== 'string' || !['default', 'enabled', 'disabled', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) throw new Error('Invalid openrouter_reasoning');
    target.openrouter_reasoning = value;
  }
  setStringField(target, source, 'model', MAX_MODEL_CHARS, 'settings.model');
  setStringField(target, source, 'target_language', MAX_LANGUAGE_CHARS, 'settings.target_language');
  setStringField(target, source, 'style_prompt', MAX_STYLE_PROMPT_CHARS, 'settings.style_prompt');
  setStringField(target, source, 'custom_system_prompt', MAX_CUSTOM_PROMPT_CHARS, 'settings.custom_system_prompt');
  if (hasOwn(source, 'style_preset')) {
    const style = boundedString(source.style_preset, 'settings.style_preset', 32).trim();
    if (!STYLE_PRESETS.has(style)) throw new Error(`Unsupported style preset: ${style}`);
    target.style_preset = style;
  }
  if (hasOwn(source, 'base_url')) {
    const endpoint = optionalEndpoint(source.base_url, 'settings.base_url');
    target.base_url = endpoint;
  }
  if (hasOwn(source, 'wire_format')) setStringField(target, source, 'wire_format', 32, 'settings.wire_format');

  const numericKeys = ['temperature', 'batch_size', 'request_timeout', 'rpm_limit', 'tpm_limit', 'max_batch_retries', 'max_file_write_retries', 'concurrency'];
  for (const key of numericKeys) setNumberField(target, source, key, 'settings');
  if (hasOwn(source, 'review_before_apply')) target.review_before_apply = booleanValue(source.review_before_apply, 'settings.review_before_apply');
  if (hasOwn(source, 'max_cost_usd')) target.max_cost_usd = boundedNumber(source.max_cost_usd, 'settings.max_cost_usd', 0, 1000);
  setBooleanField(target, source, 'resource_pack_enabled', 'settings.resource_pack_enabled');
  setBooleanField(target, source, 'skip_target_language_text', 'settings.skip_target_language_text');
  if (hasOwn(source, 'resource_pack_options')) target.resource_pack_options = validateResourcePackOptions(source.resource_pack_options, target.resource_pack_options);
  if (hasOwn(source, 'scan_options')) importScanOptions(target, source.scan_options, 'settings.scan_options');
  if (hasOwn(source, 'source_overrides')) target.source_overrides = validateSourceOverrides(source.source_overrides);
  if (hasOwn(source, 'glossary')) {
    const result = inspectGlossaryEntries(source.glossary);
    if (!result.entries) throw new Error('settings.glossary contains invalid entries');
    target.glossary = result.entries;
  }
  if (hasOwn(source, 'custom_prices')) target.custom_prices = validateCustomPrices(source.custom_prices);
  if (hasOwn(source, 'continue_on_file_error')) target.continue_on_file_error = booleanValue(source.continue_on_file_error, 'continue_on_file_error');

  if (selectedProvider && selectedProvider !== 'custom') {
    target.base_url = BUILTIN_PROVIDERS[selectedProvider].baseUrl;
    target.wire_format = BUILTIN_PROVIDERS[selectedProvider].wireFormat;
  } else if (selectedProvider === 'custom' && providerWasSupplied && currentProvider !== 'custom' && !hasOwn(source, 'base_url')) {
    throw new Error('settings.base_url is required when selecting the custom provider');
  }
}

function applyLegacyShape(target: Settings, root: JsonObject): void {
  const api = hasOwn(root, 'api') ? object(root.api, 'api') : {};
  const prompt = hasOwn(root, 'prompt') ? object(root.prompt, 'prompt') : {};
  const scan = hasOwn(root, 'scan') ? object(root.scan, 'scan') : {};
  const resourcePack = hasOwn(root, 'resource_pack') ? object(root.resource_pack, 'resource_pack') : {};
  const runtime = hasOwn(root, 'runtime') ? object(root.runtime, 'runtime') : {};

  const legacyProvider = hasOwn(api, 'provider') ? boundedString(api.provider, 'api.provider', 32).trim() : undefined;
  let selectedProvider = legacyProvider;
  let forcedWire: string | undefined;
  if (legacyProvider === 'custom_openai') {
    selectedProvider = 'custom';
    forcedWire = 'openai';
  } else if (legacyProvider === 'custom_anthropic') {
    selectedProvider = 'custom';
    forcedWire = 'anthropic';
  } else if (legacyProvider === 'comet' && hasOwn(api, 'base_url') && api.base_url !== '' && String(api.base_url).replace(/\/$/, '') !== BUILTIN_PROVIDERS.comet.baseUrl) {
    selectedProvider = 'custom';
    forcedWire = 'openai';
    if (!hasOwn(api, 'base_url')) throw new Error('api.base_url is required when importing comet settings');
  } else if (legacyProvider && !['openai', 'gemini', 'anthropic', 'openrouter', 'comet', 'custom'].includes(legacyProvider)) {
    throw new Error(`Unsupported provider: ${legacyProvider}`);
  }

  if (selectedProvider) target.provider = selectedProvider;
  setStringField(target, api, 'model', MAX_MODEL_CHARS, 'api.model');
  if (hasOwn(api, 'base_url')) target.base_url = optionalEndpoint(api.base_url, 'api.base_url');
  if (hasOwn(api, 'wire_format')) {
    const wire = boundedString(api.wire_format, 'api.wire_format', 32).trim();
    if (wire) {
      const validatedWire = validateWireFormat(wire, 'api.wire_format');
      if (!forcedWire) target.wire_format = validatedWire;
    }
  }
  for (const key of ['request_timeout', 'rpm_limit', 'tpm_limit']) setNumberField(target, api, key, 'api');

  setStringField(target, prompt, 'target_language', MAX_LANGUAGE_CHARS, 'prompt.target_language');
  setStringField(target, prompt, 'style_prompt', MAX_STYLE_PROMPT_CHARS, 'prompt.style_prompt');
  setStringField(target, prompt, 'custom_system_prompt', MAX_CUSTOM_PROMPT_CHARS, 'prompt.custom_system_prompt');
  if (hasOwn(prompt, 'style_preset')) {
    const style = boundedString(prompt.style_preset, 'prompt.style_preset', 32).trim();
    if (!STYLE_PRESETS.has(style)) throw new Error(`Unsupported style preset: ${style}`);
    target.style_preset = style;
  }

  const scanOptions = validatedScanOptions(scan, 'scan');
  target.scan_options = normalizedScanOptions({ ...target.scan_options, ...scanOptions });
  if (hasOwn(scan, 'overrides')) target.source_overrides = validateSourceOverrides(scan.overrides);
  setBooleanField(target, scan, 'skip_target_language_text', 'scan.skip_target_language_text');
  const packOptions = Object.fromEntries(['source_lang_files', 'target_lang_file', 'skip_if_target_exists'].filter((key) => hasOwn(resourcePack, key)).map((key) => [key, resourcePack[key]]));
  target.resource_pack_options = validateResourcePackOptions(packOptions, target.resource_pack_options);
  if (hasOwn(resourcePack, 'enabled')) {
    target.resource_pack_enabled = booleanValue(resourcePack.enabled, 'resource_pack.enabled');
  }
  for (const key of ['concurrency', 'max_batch_retries', 'max_file_write_retries']) setNumberField(target, runtime, key, 'runtime');
  if (hasOwn(runtime, 'continue_on_file_error')) target.continue_on_file_error = booleanValue(runtime.continue_on_file_error, 'runtime.continue_on_file_error');
  for (const key of ['temperature', 'batch_size']) setNumberField(target, root, key, 'root');

  if (selectedProvider && selectedProvider !== 'custom') {
    target.base_url = BUILTIN_PROVIDERS[selectedProvider].baseUrl;
    target.wire_format = BUILTIN_PROVIDERS[selectedProvider].wireFormat;
  } else if (selectedProvider === 'custom') {
    if (!hasOwn(api, 'base_url')) throw new Error('api.base_url is required for custom provider settings');
    target.base_url = validCustomEndpoint(api.base_url, 'api.base_url');
    const importedWire = hasOwn(api, 'wire_format') ? boundedString(api.wire_format, 'api.wire_format', 32).trim() : '';
    target.wire_format = forcedWire ?? (importedWire ? validateWireFormat(importedWire, 'api.wire_format') : 'openai');
    if (!CUSTOM_WIRE_FORMATS.has(target.wire_format)) throw new Error('api.wire_format is unsupported');
  }
}

/** Parse public settings exports or legacy execution configs without importing credentials. */
export function parseSettingsImport(text: string, current: Settings): Settings {
  if (typeof text !== 'string') throw new Error('Settings import must be text');
  if (text.length > MAX_IMPORT_BYTES || new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) {
    throw new Error('Settings import exceeds 1 MiB');
  }
  const parsed: unknown = JSON.parse(text);
  const root = object(parsed, 'Settings import');
  const target = publicSettingsForExport(current);

  if (hasOwn(root, 'schema')) {
    if (root.schema !== 1) throw new Error('Unsupported settings schema');
    applyCurrentShape(target, object(root.settings, 'settings'));
  } else {
    const hasLegacySettings = ['api', 'prompt', 'scan', 'resource_pack', 'runtime', 'temperature', 'batch_size']
      .some((key) => hasOwn(root, key));
    if (!hasLegacySettings) throw new Error('Unsupported settings import format');
    applyLegacyShape(target, root);
  }

  // Language and current world belong to the running app's navigation state, never an import.
  target.ui_language = current.ui_language;
  target.last_world_dir = current.last_world_dir;

  if (target.provider === 'custom') {
    target.base_url = validCustomEndpoint(target.base_url, 'settings.base_url');
    if (!CUSTOM_WIRE_FORMATS.has(target.wire_format)) throw new Error('Unsupported Custom wire format');
  }
  else if (BUILTIN_PROVIDERS[target.provider]) {
    target.base_url = BUILTIN_PROVIDERS[target.provider].baseUrl;
    target.wire_format = BUILTIN_PROVIDERS[target.provider].wireFormat;
  } else throw new Error(`Unsupported provider: ${target.provider}`);
  return target;
}
