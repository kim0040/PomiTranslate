/** The app-wide text size choices, in percent. 100 is the desktop scale the design tokens are written for. */
export const FONT_SCALES = [100, 115, 130] as const;
export type FontScale = (typeof FONT_SCALES)[number];

const KEY = 'pomi.fontscale.v1';

export function isFontScale(value: unknown): value is FontScale {
  return typeof value === 'number' && (FONT_SCALES as readonly number[]).includes(value);
}

/** A saved or typed size that is not one of the choices falls back to 100. */
export function normalizeFontScale(value: unknown): FontScale {
  return isFontScale(value) ? value : 100;
}

export function storedFontScale(): FontScale {
  try {
    return normalizeFontScale(Number(localStorage.getItem(KEY)));
  } catch {
    return 100;
  }
}

/** Set the root variable every text size and control height is multiplied by (see tokens.css). */
export function applyFontScale(scale: number): void {
  const value = normalizeFontScale(scale);
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty('--font-scale', String(value / 100));
  try { localStorage.setItem(KEY, String(value)); } catch { /* the settings file is the record */ }
}
