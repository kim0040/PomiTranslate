import { describe, expect, it } from 'vitest';

import { CUSTOM_LANGUAGE, LANGUAGES, languageChoice } from '../../src/lib/languages';
import { PROVIDER_CARDS, keyPageFor } from '../../src/lib/providers';
import { pendingChanges, totalPending } from '../../src/lib/settings-tabs';
import { copySettings } from '../../src/lib/settings';
import { defaultSettings } from '../../src/lib/app.svelte';

describe('target language select', () => {
  it('lists the common languages by their own names, Korean first', () => {
    expect(LANGUAGES[0]).toBe('한국어');
    expect(LANGUAGES).toEqual(expect.arrayContaining(['English', '日本語', '简体中文', '繁體中文', 'Português (Brasil)', 'العربية']));
    expect(new Set(LANGUAGES).size).toBe(LANGUAGES.length);
  });

  it('selects a listed value as it is stored', () => {
    expect(languageChoice('한국어')).toBe('한국어');
    expect(languageChoice('Deutsch')).toBe('Deutsch');
  });

  it('shows an unknown stored value as custom, so an earlier free-text entry keeps working', () => {
    expect(languageChoice('Latviešu')).toBe(CUSTOM_LANGUAGE);
    expect(languageChoice('')).toBe(CUSTOM_LANGUAGE);
    expect(languageChoice('english')).toBe(CUSTOM_LANGUAGE);
  });
});

describe('provider table', () => {
  it('has a key page for every public provider and none for custom', () => {
    for (const card of PROVIDER_CARDS.filter((item) => item.id !== 'custom')) expect(keyPageFor(card.id)).toMatch(/^https:\/\//);
    expect(keyPageFor('custom')).toBeNull();
    expect(keyPageFor('constructor')).toBeNull();
    expect(keyPageFor('comet')).toBe('https://www.cometapi.com/console/token');
  });

  it('lists OpenRouter first with the recommended badge, and Custom last', () => {
    expect(PROVIDER_CARDS[0]).toMatchObject({ id: 'openrouter', badge: 'setup.provider.recommended' });
    expect(PROVIDER_CARDS.at(-1)?.id).toBe('custom');
  });
});

describe('pending changes per settings tab', () => {
  const saved = copySettings(defaultSettings());
  const none = { keyTyped: false, storageModeChanged: false };

  it('counts nothing for an untouched copy', () => {
    expect(totalPending(pendingChanges(copySettings(saved), saved, none))).toBe(0);
  });

  it('puts each setting on the tab where it is edited', () => {
    const draft = copySettings({ ...saved, model: 'x', batch_size: 10, concurrency: 2, resource_pack_enabled: true, source_overrides: { a: 'b' } });
    expect(pendingChanges(draft, saved, none)).toEqual({ translate: 1, scope: 2, advanced: 2, app: 0 });
  });

  it('counts file rules on the advanced tab and the category switches on the scope tab', () => {
    const draft = copySettings({ ...saved, scan_options: { ...saved.scan_options!, region_dirs: ['region'], translate_signs: false } });
    expect(pendingChanges(draft, saved, none)).toEqual({ translate: 0, scope: 1, advanced: 1, app: 0 });
  });

  it('counts a typed key and a changed storage mode on the translation tab', () => {
    expect(pendingChanges(copySettings(saved), saved, { keyTyped: true, storageModeChanged: true }).translate).toBe(2);
  });

  it('never counts the instant-apply display language', () => {
    const draft = copySettings({ ...saved, ui_language: 'en' });
    expect(totalPending(pendingChanges(draft, saved, none))).toBe(0);
  });
});
