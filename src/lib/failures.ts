import type { FailureCode } from './api';
import { hasMessage, t, type MessageKey } from './i18n/index.svelte';

/** Why a sentence failed, in the order the summary lists them. */
export const FAILURE_CODES: FailureCode[] = [
  'timeout', 'auth', 'rate_limit', 'quota', 'bad_request', 'unsupported_model',
  'format_mismatch', 'provider_unavailable', 'cancelled', 'other'
];

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === 'string' && (FAILURE_CODES as string[]).includes(value);
}

/** Catalog key for a failure code; anything the core adds later reads as "other". */
export function failureKey(code: unknown): MessageKey {
  return `result.failure.${isFailureCode(code) ? code : 'other'}` as MessageKey;
}

/** Counts per code, in display order, only the ones that happened. */
export function failureSummary(counts: Partial<Record<FailureCode, number>> | undefined): { code: FailureCode; count: number }[] {
  if (!counts) return [];
  const rows = FAILURE_CODES.map((code) => ({ code, count: Number(counts[code] ?? 0) })).filter((row) => row.count > 0);
  // A code this build does not know still counts, as "other".
  const unknown = Object.entries(counts).filter(([code]) => !isFailureCode(code)).reduce((sum, [, count]) => sum + Number(count || 0), 0);
  if (unknown > 0) {
    const other = rows.find((row) => row.code === 'other');
    if (other) other.count += unknown;
    else rows.push({ code: 'other', count: unknown });
  }
  return rows;
}

/** Warning codes with their own sentence; others fall back to the generic one. */
export function warningKey(code: string): MessageKey | null {
  const key = `scan.warn.${code}`;
  return hasMessage(key) ? (key as MessageKey) : null;
}

/**
 * A warning from the core as a sentence in the display language. Only the code and the numbers the
 * core sent are used; an unknown code gets the generic sentence, never the core's own text.
 */
export function warningText(warning: { code: string; file?: string; count?: number; dropped_translations?: number }): string {
  const key = warningKey(warning.code);
  // glossary_changed carries how many saved translations it dropped instead of a count.
  return key ? t(key, { file: warning.file ?? '', count: warning.count ?? warning.dropped_translations ?? 0 }) : t('scan.warn.unknown');
}
