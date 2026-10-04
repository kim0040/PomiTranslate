import type { MessageKey } from './i18n/index.svelte';
import type { EditReason } from './workflow';

const CODES = ['timeout', 'auth', 'rate_limit', 'quota', 'invalid_response', 'content_filter', 'network', 'provider_error', 'unknown'] as const;

/** Catalog key for a failure code. Anything the catalog does not know reads as "unknown", never as raw text. */
export function failureKey(code: string | undefined): MessageKey {
  return `failure.${(CODES as readonly string[]).includes(code ?? '') ? code : 'unknown'}` as MessageKey;
}

export function editReasonKey(reason: EditReason): MessageKey {
  return `translationReview.error.${reason}` as MessageKey;
}
