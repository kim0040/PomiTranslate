import { describe, expect, it } from 'vitest';

import { en } from '../../src/lib/i18n/en';
import { ja } from '../../src/lib/i18n/ja';
import { ko } from '../../src/lib/i18n/ko';
import { zh } from '../../src/lib/i18n/zh';
import { LOCALES, translate } from '../../src/lib/i18n/index.svelte';

describe('translation catalogs', () => {
  it('have exactly the same semantic key set', () => {
    const sourceKeys = Object.keys(ko).sort();
    expect(Object.keys(en).sort()).toEqual(sourceKeys);
    expect(Object.keys(ja).sort()).toEqual(sourceKeys);
    expect(Object.keys(zh).sort()).toEqual(sourceKeys);
  });

  it('has a non-empty localized value for every key and locale', () => {
    for (const locale of LOCALES) {
      for (const key of Object.keys(ko)) {
        const value = translate(locale, key as keyof typeof ko);
        expect(value, `${locale}.${key}`).not.toBe('');
        expect(value, `${locale}.${key}`).not.toContain('{missing');
      }
    }
  });

  it('interpolates variables without exposing template placeholders', () => {
    expect(translate('en', 'common.of', { done: 2, total: 5 })).toBe('2 / 5');
    expect(translate('ko', 'detail.chunk', { x: 3, z: -2 })).toBe('청크 (3, -2)');
  });

  it('preserves placeholders, formatting tokens, product names, and the official subtitle', () => {
    const markers = (value: string) => value.match(/\{[^}]+\}|%s|§[0-9A-FK-ORa-fk-or]/g)?.sort() ?? [];
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(markers(zh[key]), `zh.${key}`).toEqual(markers(en[key]));
      expect((zh[key].match(/§/g) ?? []).length, `zh.${key} section signs`).toBe((en[key].match(/§/g) ?? []).length);
      expect((zh[key].match(/PomiTranslate/g) ?? []).length, `zh.${key} product name`).toBe((en[key].match(/PomiTranslate/g) ?? []).length);
    }
    expect(zh['app.tagline']).toBe('World Translator for Minecraft');
  });
});
