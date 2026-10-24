import { en } from './en';
import { ja } from './ja';
import { ko, type MessageKey } from './ko';
import { zh } from './zh';
import { LOCALES, type Locale } from './locale';

import { localeFromLanguageTag } from './locale';
export { LOCALES, detectSystemLocale, isLocale, localeFromLanguageTag } from './locale';
export type { Locale } from './locale';
export type { MessageKey };

const catalogs: Record<Locale, Record<MessageKey, string>> = { ko, en, ja, zh };

/** Shown when a key exists in no catalog. A screen must never fail to draw because of a missing label. */
const GENERIC: Record<Locale, string> = {
  ko: '표시할 수 없는 문구',
  en: 'Text unavailable',
  ja: '表示できない文言',
  zh: '无法显示的文字'
};

// A plain object, so every `t()` call in a template re-runs when the locale changes.
export const i18n = $state<{ locale: Locale }>({ locale: 'ko' });

export function setLocale(locale: Locale): void {
  i18n.locale = locale;
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

const reported = new Set<string>();

function reportMissing(key: string): void {
  if (reported.has(key)) return;
  reported.add(key);
  // Development builds say which key is missing; a release build stays quiet.
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) console.warn(`[i18n] missing message key: ${key}`);
}

/** Never throws: the locale, then Korean (the source catalog), then a generic line. */
export function translate(locale: Locale, key: MessageKey | string, vars: Record<string, string | number> = {}): string {
  const template = catalogs[locale]?.[key as MessageKey] ?? ko[key as MessageKey];
  if (typeof template !== 'string') {
    reportMissing(String(key));
    return GENERIC[locale] ?? GENERIC.en;
  }
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
  return Object.hasOwn(ko, key);
}

/** Text for a key built from backend data (a kind, a code); `fallback` when the UI does not know it. */
export function tOr(key: string, fallback: string, vars: Record<string, string | number> = {}): string {
  return hasMessage(key) ? t(key, vars) : fallback;
}

/** The first of ko/en/ja/zh that the browser prefers; English when none matches (Traditional Chinese reads English). */
export function detectLocale(languages: readonly string[] = typeof navigator === 'undefined' ? [] : (navigator.languages?.length ? navigator.languages : [navigator.language])): Locale {
  for (const language of languages) {
    const tag = String(language ?? '').trim();
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (base === 'ko' || base === 'ja' || base === 'en') return base;
    if (base === 'zh') return localeFromLanguageTag(tag);
  }
  return 'en';
}
