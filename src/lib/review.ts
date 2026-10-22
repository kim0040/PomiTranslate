/** Rules for the review draft: what counts as a manual translation and how large one may be. */
export const MAX_MANUAL_LENGTH = 32000;

/** The text that is sent: trimmed and bounded. Whitespace only means "no override", so ''. */
export function effectiveOverride(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  return trimmed.length > MAX_MANUAL_LENGTH ? trimmed.slice(0, MAX_MANUAL_LENGTH).trim() : trimmed;
}

/** Overrides as the core should see them: trimmed, blank ones dropped. */
export function cleanOverrides(overrides: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [id, value] of Object.entries(overrides)) {
    const text = effectiveOverride(value);
    if (text) clean[id] = text;
  }
  return clean;
}

export type CounterState = 'ok' | 'near' | 'full';

/** How close a manual translation is to its limit, for the counter's tone. */
export function counterState(length: number): CounterState {
  if (length >= MAX_MANUAL_LENGTH) return 'full';
  return length >= MAX_MANUAL_LENGTH * 0.9 ? 'near' : 'ok';
}
