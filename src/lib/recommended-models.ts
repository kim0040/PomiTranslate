import type { MessageKey } from './i18n/index.svelte';

/**
 * Models worth trying when the provider's own list cannot be read yet (no key saved, or the lookup
 * failed). Each entry says when it was last checked and where the recommendation comes from, so
 * an old list reads as old. A provider with nothing verified here has no entry: the list is
 * fetched once the key is saved.
 */
export type Recommendation = { models: string[]; asOf: string; source: MessageKey };

export const RECOMMENDED_MODELS: Record<string, Recommendation> = {
  gemini: { models: ['gemini-3.5-flash-lite', 'gemini-3.5-flash'], asOf: '2026-10-01', source: 'settings.model.recSource.gemini' },
  anthropic: { models: ['claude-haiku-5-5', 'claude-sonnet-5-5'], asOf: '2026-10-23', source: 'settings.model.recSource.anthropic' }
};

/** Providers whose model list can be read with a saved key (or, for OpenRouter, with none). */
export const LISTABLE_PROVIDERS = ['openai', 'gemini', 'anthropic', 'openrouter', 'comet'];

/** Price per million tokens from a per-token price string, or null when it is absent or not a number. */
export function perMillion(price: string | undefined): number | null {
  if (price === undefined || price === '') return null;
  const value = Number(price);
  return Number.isFinite(value) && value >= 0 ? value * 1_000_000 : null;
}
