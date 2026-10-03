import type { MessageKey } from './i18n/index.svelte';

export type ProviderId = 'openrouter' | 'gemini' | 'openai' | 'anthropic' | 'comet' | 'custom';

/** Where each provider hands out API keys. One table for the setup wizard and the settings screen. */
export const KEY_PAGES: Record<Exclude<ProviderId, 'custom'>, string> = {
  openrouter: 'https://openrouter.ai/settings/keys',
  gemini: 'https://aistudio.google.com/app/apikey',
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  comet: 'https://www.cometapi.com/console/token'
};

/** Public providers use their canonical endpoint; only Custom exposes and stores a URL. */
export const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; wireFormat: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', wireFormat: 'openai' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', wireFormat: 'gemini' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', wireFormat: 'anthropic' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', wireFormat: 'openai' },
  comet: { baseUrl: 'https://api.cometapi.com/v1', wireFormat: 'openai' }
};

export type ProviderCard = { id: ProviderId; label: string; description: MessageKey; badge?: MessageKey };

/** The order of the wizard's provider step. Custom is listed last, under "Advanced". */
export const PROVIDER_CARDS: ProviderCard[] = [
  { id: 'openrouter', label: 'OpenRouter', description: 'setup.provider.openrouter', badge: 'setup.provider.recommended' },
  { id: 'gemini', label: 'Google Gemini', description: 'setup.provider.gemini' },
  { id: 'openai', label: 'OpenAI', description: 'setup.provider.openai' },
  { id: 'anthropic', label: 'Anthropic', description: 'setup.provider.anthropic' },
  { id: 'comet', label: 'Comet API', description: 'setup.provider.comet' },
  { id: 'custom', label: '', description: 'setup.provider.custom' }
];

export function keyPageFor(provider: string): string | null {
  return Object.hasOwn(KEY_PAGES, provider) ? KEY_PAGES[provider as keyof typeof KEY_PAGES] : null;
}
