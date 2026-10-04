import type { ModelInfo } from './api';
import type { MessageKey } from './i18n/index.svelte';

/** Model families that are cheap and fast enough for bulk translation. */
const RECOMMENDED_FAMILY = /flash|mini|haiku|lite|small/i;

/** The catalog layer marks models that are not for translating text (image, audio, embeddings...). */
export function isSuitable(model: ModelInfo): boolean {
  return model.suitable !== false;
}

/** Dollars per million tokens from a per-token price string, or null when the catalog has none. */
export function perMillion(price: string | undefined): number | null {
  if (price === undefined || price.trim() === '') return null;
  const value = Number(price);
  return Number.isFinite(value) && value >= 0 ? value * 1_000_000 : null;
}

export function modelPrices(model: ModelInfo): { input: number | null; output: number | null } {
  return { input: perMillion(model.pricing_prompt), output: perMillion(model.pricing_completion) };
}

function sortPrice(model: ModelInfo): number {
  const { input, output } = modelPrices(model);
  return input === null || output === null ? Number.POSITIVE_INFINITY : input + output;
}

/**
 * The cheapest suitable models of a fast family, cheapest first. A free-tier id (":free") is left
 * out: those are rate limited and may be trained on. Without a match the first entry stands in.
 */
export function recommendedModels(models: ModelInfo[], limit = 5): ModelInfo[] {
  const suitable = models.filter(isSuitable);
  const matches = suitable
    .filter((model) => RECOMMENDED_FAMILY.test(model.id) && !model.id.endsWith(':free'))
    .map((model, index) => ({ model, index }))
    .sort((a, b) => sortPrice(a.model) - sortPrice(b.model) || a.index - b.index)
    .map((entry) => entry.model)
    .slice(0, limit);
  return matches.length ? matches : suitable.slice(0, 1);
}

export function defaultModel(models: ModelInfo[]): ModelInfo | undefined {
  return recommendedModels(models, 1)[0];
}

/** Every word typed must appear in the id or the display name. */
export function filterModels(models: ModelInfo[], query: string): ModelInfo[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return models;
  return models.filter((model) => {
    const haystack = `${model.id} ${model.display_name ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** 128000 -> "128K", 1048576 -> "1M". */
export function formatContext(length: number | undefined | null): string {
  if (!length || !Number.isFinite(length) || length <= 0) return '';
  if (length >= 1_000_000) return `${+(length / 1_048_576).toFixed(length % 1_048_576 === 0 ? 0 : 1)}M`;
  return `${Math.round(length / 1000)}K`;
}

const connectionKeys: Record<string, MessageKey> = {
  AUTH_FAILED: 'connect.error.AUTH_FAILED',
  KEY_MISSING: 'connect.error.KEY_MISSING',
  NO_CREDIT: 'connect.error.NO_CREDIT',
  RATE_LIMITED: 'connect.error.RATE_LIMITED',
  PROVIDER_ERROR: 'connect.error.PROVIDER_ERROR',
  NETWORK_ERROR: 'connect.error.NETWORK_ERROR',
  TIMEOUT: 'connect.error.TIMEOUT',
  REQUEST_REJECTED: 'connect.error.REQUEST_REJECTED',
  MODEL_NOT_FOUND: 'connect.error.REQUEST_REJECTED'
};

/** A readable reason for a failed connection check, from the provider error code. */
export function connectionErrorKey(code: string): MessageKey {
  return connectionKeys[code] ?? 'connect.error.unknown';
}
