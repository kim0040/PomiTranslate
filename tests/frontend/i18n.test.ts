import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { en } from '../../src/lib/i18n/en';
import { ja } from '../../src/lib/i18n/ja';
import { ko } from '../../src/lib/i18n/ko';
import { zh } from '../../src/lib/i18n/zh';
import { LOCALES, humanize, labelFor, translate } from '../../src/lib/i18n/index.svelte';

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

describe('catalog hygiene', () => {
  const source = (locale: string) => readFileSync(resolve('src/lib/i18n', `${locale}.ts`), 'utf8');
  // A key line looks like `  'a.b': "text",`; a duplicate silently keeps the last one at runtime.
  const keyLines = (locale: string) => [...source(locale).matchAll(/^\s*(['"])([A-Za-z0-9_.-]+)\1\s*:/gm)].map((match) => match[2]);

  it('declares every key once, in every catalog', () => {
    for (const locale of ['ko', 'en', 'ja', 'zh']) {
      const seen = new Set<string>();
      const duplicates = keyLines(locale).filter((key) => (seen.has(key) ? true : (seen.add(key), false)));
      expect(duplicates, `${locale} duplicate keys`).toEqual([]);
    }
  });

  it('reads the same keys from the source files as from the loaded catalogs', () => {
    const catalogs = { ko, en, ja, zh } as Record<string, Record<string, string>>;
    for (const locale of Object.keys(catalogs)) {
      expect(new Set(keyLines(locale)), locale).toEqual(new Set(Object.keys(catalogs[locale])));
    }
  });

  it('keeps the placeholders of every locale equal to the Korean source', () => {
    const names = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    const problems: string[] = [];
    for (const [locale, catalog] of Object.entries({ en, ja, zh }) as [string, Record<string, string>][]) {
      for (const key of Object.keys(ko) as (keyof typeof ko)[]) {
        if (JSON.stringify(names(catalog[key])) !== JSON.stringify(names(ko[key]))) problems.push(`${locale}.${key}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('translate and labelFor never throw', () => {
  it('falls back for a key no catalog has', () => {
    expect(translate('en', 'no.such.key' as never)).toBe('key');
    expect(translate('ja', 'no.such_thing' as never)).toBe('such thing');
  });

  it('falls back to Korean when one locale is missing a key', () => {
    const catalog = en as Record<string, string>;
    const removed = catalog['common.save'];
    delete catalog['common.save'];
    try {
      expect(translate('en', 'common.save')).toBe(ko['common.save']);
    } finally {
      catalog['common.save'] = removed;
    }
  });

  it('labels a known id from the catalog and an unknown one as plain words', () => {
    expect(labelFor('kind', 'sign', 'en')).toBe(en['kind.sign']);
    expect(labelFor('kind', 'brand_new_kind', 'en')).toBe('brand new kind');
    expect(labelFor('coverage', 'minecraft:some_area', 'ko')).toBe('some area');
    expect(labelFor('kind', undefined, 'en')).toBe('');
    expect(humanize('a.b-c_d')).toBe('a b c d');
  });
});
