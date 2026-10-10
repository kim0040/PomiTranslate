import { en } from './en';
import { ja } from './ja';
import { ko, type MessageKey } from './ko';
import { zh } from './zh';
import { LOCALES, type Locale } from './locale';

export { LOCALES, detectSystemLocale, isLocale, localeFromLanguageTag } from './locale';
export type { Locale } from './locale';
export type { MessageKey };

const catalogs: Record<Locale, Record<MessageKey, string>> = { ko, en, ja, zh };

// A plain object, so every `t()` call in a template re-runs when the locale changes.
export const i18n = $state<{ locale: Locale }>({ locale: 'ko' });

export function setLocale(locale: Locale): void {
  i18n.locale = locale;
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

/**
 * Never throws: a key missing from the locale falls back to Korean (the source catalog), and a key
 * missing everywhere shows the last part of its name instead of breaking the screen.
 */
export function translate(locale: Locale, key: MessageKey, vars: Record<string, string | number> = {}): string {
  const template = catalogs[locale]?.[key] ?? ko[key] ?? humanize(String(key).split('.').pop() ?? '');
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}

/** `region_dirs` or `some.thing` as plain words, for an id the catalog does not know. */
export function humanize(id: string): string {
  return id.replace(/^minecraft:/, '').replace(/[_.\-:]+/g, ' ').trim();
}

/**
 * The label for an id the core sends (a text kind, a coverage area, a warning code). Ids grow with
 * the core, so one the catalog does not know yet shows its own name in plain words, never an error.
 */
export function labelFor(prefix: string, id: string | null | undefined, locale: Locale = i18n.locale, vars: Record<string, string | number> = {}): string {
  const raw = id ?? '';
  const key = `${prefix}.${raw}`;
  return raw && hasMessage(key) ? translate(locale, key, vars) : humanize(raw);
}

export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  return translate(i18n.locale, key, vars);
}

export function hasMessage(key: string): key is MessageKey {
  return key in ko;
}
