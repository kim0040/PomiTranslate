import { BackendError } from './api';
import { hasMessage, t, type MessageKey } from './i18n/index.svelte';

/**
 * Text for a failed call, from the catalog. A code the shell or core sent maps to its own sentence;
 * anything else (an English tool message, a stack) is not shown and becomes the generic sentence.
 */
export function describeError(cause: unknown): string {
  const code = cause instanceof BackendError ? cause.code : cause instanceof Error ? cause.message : '';
  const key = `error.${code}`;
  return code && hasMessage(key) ? t(key as MessageKey) : t('error.default');
}
