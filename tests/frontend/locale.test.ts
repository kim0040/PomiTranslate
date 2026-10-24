import { describe, expect, it } from 'vitest';

import { detectSystemLocale, isLocale, localeFromLanguageTag, LOCALES } from '../../src/lib/i18n/locale';

describe('interface locale support', () => {
  it('ships Simplified Chinese alongside the existing locales', () => {
    expect(LOCALES).toEqual(['ko', 'en', 'ja', 'zh']);
    expect(isLocale('zh')).toBe(true);
    expect(isLocale('zh-Hant')).toBe(false);
  });

  it('maps system tags to Simplified Chinese and falls back from Traditional Chinese to English', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans', 'zh-Hans-CN']) expect(localeFromLanguageTag(tag)).toBe('zh');
    for (const tag of ['zh-TW', 'zh-HK', 'zh-Hant', 'zh-Hant-TW']) expect(localeFromLanguageTag(tag)).toBe('en');
    expect(localeFromLanguageTag('en-GB')).toBe('en');
    expect(localeFromLanguageTag('ja-JP')).toBe('ja');
    expect(localeFromLanguageTag('ko-KR')).toBe('ko');
  });

  it('detects the browser system locale without accessing browser globals in non-browser contexts', () => {
    expect(detectSystemLocale()).toBe(localeFromLanguageTag(typeof navigator === 'undefined' ? undefined : navigator.language));
  });
});
