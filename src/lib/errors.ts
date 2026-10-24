import { BackendError } from './api';
import { hasMessage, t, type MessageKey } from './i18n/index.svelte';

/** An error whose message is already shown text in the display language (made by the app itself). */
export class LocalizedError extends Error {}

/**
 * Text for a failed call, from the catalog. A code the shell or core sent maps to its own sentence
 * with a next step; anything else (an English tool message, a stack) is not shown and becomes the
 * generic sentence. The update codes keep their own catalog section.
 */
export function describeError(cause: unknown): string {
  if (cause instanceof LocalizedError) return cause.message;
  if (cause instanceof BackendError) {
    if (cause.code === 'BUSY') return t('error.busy');
    const key = cause.code.startsWith('UPDATE_') ? `update.error.${cause.code}` : `error.${cause.code}`;
    if (hasMessage(key)) {
      // A storage failure also says which step repairs it.
      const why = cause.detail ? `error.${cause.detail}` : '';
      return why && hasMessage(why) ? `${t(key as MessageKey)} ${t(why as MessageKey)}` : t(key as MessageKey);
    }
  }
  return t('error.default');
}

/** The code behind a failure, or '' when it has none. */
export function errorCode(cause: unknown): string {
  return cause instanceof BackendError ? cause.code : '';
}
