export const LOCALES = ['ko', 'en', 'ja', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && LOCALES.includes(value as Locale);
}

/** Map a system language tag to a shipped interface language. Unknown languages keep the Korean default. */
export function localeFromLanguageTag(value: string | null | undefined): Locale {
  const tag = String(value ?? '').trim().replaceAll('_', '-').toLowerCase();
  if (tag === 'zh' || tag.startsWith('zh-')) {
    if (/(?:^|-)hant(?:-|$)/.test(tag) || /(?:^|-)tw(?:-|$)/.test(tag) || /(?:^|-)hk(?:-|$)/.test(tag)) return 'en';
    return 'zh';
  }
  const language = tag.split('-')[0];
  if (language === 'ko' || language === 'en' || language === 'ja') return language;
  return 'ko';
}

export function detectSystemLocale(): Locale {
  if (typeof navigator === 'undefined') return 'ko';
  return localeFromLanguageTag(navigator.language || navigator.languages?.[0]);
}
