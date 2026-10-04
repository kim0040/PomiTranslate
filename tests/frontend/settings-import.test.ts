import { describe, expect, it } from 'vitest';
import type { Settings } from '../../src/lib/api';
import { defaultScanOptions, publicSettingsForExport } from '../../src/lib/settings';
import { isValidCustomEndpoint, parseSettingsImport } from '../../src/lib/settings-import';

function currentSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    provider: 'openrouter', model: 'current-model', base_url: 'https://openrouter.ai/api/v1', wire_format: 'openai',
    target_language: '한국어', style_preset: 'neutral', style_prompt: '', custom_system_prompt: '',
    temperature: 0.3, batch_size: 40, request_timeout: 120, rpm_limit: 0, tpm_limit: 0,
    max_batch_retries: 3, concurrency: 4, resource_pack_enabled: false, skip_target_language_text: true,
    scan_options: defaultScanOptions(), ui_language: 'ja', last_world_dir: '/world/kept', ...overrides
  };
}

describe('settings import', () => {
  it('round-trips glossary, custom prices, review mode, and spending cap, and preserves them in older files', () => {
    const glossary = [{ source: 'Elder Mira', target: '장로 미라', mode: 'translate' as const, note: 'name', caseSensitive: true }];
    const customPrices = { 'openai/test-model': { input: 1.25, output: 4.5, updatedAt: '2026-10-03T10:00:00Z' } };
    const configured = currentSettings({ glossary, custom_prices: customPrices, review_before_apply: false, max_cost_usd: 0.37 });
    const exported = publicSettingsForExport(configured);
    expect(exported).toMatchObject({ glossary, custom_prices: customPrices, review_before_apply: false, max_cost_usd: 0.37 });

    const fresh = currentSettings({ glossary: [], custom_prices: {}, review_before_apply: true, max_cost_usd: 0 });
    expect(parseSettingsImport(JSON.stringify({ schema: 1, settings: exported }), fresh)).toMatchObject({
      glossary, custom_prices: customPrices, review_before_apply: false, max_cost_usd: 0.37
    });

    const older = parseSettingsImport(JSON.stringify({ schema: 1, settings: { model: 'older-file' } }), configured);
    expect(older).toMatchObject({ glossary, custom_prices: customPrices, review_before_apply: false, max_cost_usd: 0.37 });
  });

  it('round-trips reasoning preferences through the public allowlist and rejects invalid values', () => {
    for (const value of ['default', 'enabled', 'disabled', 'low', 'high', 'max']) {
      const exported = publicSettingsForExport(currentSettings({ openrouter_reasoning: value }));
      expect(parseSettingsImport(JSON.stringify({ schema: 1, settings: exported }), currentSettings()).openrouter_reasoning).toBe(value);
    }
    for (const value of [null, true, {}, 'ultra']) {
      expect(() => parseSettingsImport(JSON.stringify({ schema: 1, settings: { openrouter_reasoning: value } }), currentSettings())).toThrow();
    }
  });

  it('uses the same endpoint rules for manual entry and imported settings', () => {
    for (const endpoint of ['https://example.test/v1', 'http://127.0.0.1:52973/v1', ' https://example.test/v1 ']) {
      expect(isValidCustomEndpoint(endpoint)).toBe(true);
    }
    for (const endpoint of ['', 'https://user:pass@example.test/v1', 'https://@example.test/v1',
      'https://example.test/v1?key=fake', 'https://example.test/v1#part', 'https://example.test/v 1',
      'https://example.test:99999/v1', 'file:///tmp/test', `https://example.test/${'x'.repeat(2048)}`]) {
      expect(isValidCustomEndpoint(endpoint)).toBe(false);
      expect(() => parseSettingsImport(JSON.stringify({ schema: 1, settings: { provider: 'custom', base_url: endpoint } }), currentSettings())).toThrow();
    }
  });
  it('round-trips the public export while preserving current language and world navigation', () => {
    const imported: Settings = {
      ...currentSettings(), provider: 'custom', model: 'fixture-model', base_url: 'https://translator.example/v1',
      wire_format: 'anthropic', target_language: '日本語', style_preset: 'story', style_prompt: 'short lines',
      custom_system_prompt: 'Keep names consistent', temperature: 0.8, batch_size: 12, request_timeout: 50,
      rpm_limit: 20, tpm_limit: 9000, max_batch_retries: 5, concurrency: 2,
      resource_pack_enabled: true, skip_target_language_text: false,
      ui_language: 'en', last_world_dir: '/world/from-file',
      scan_options: { ...defaultScanOptions(), translate_signs: false, region_dirs: ['region', 'DIM1/region'] }
    };
    const current = currentSettings();
    const before = JSON.stringify(current);
    const text = JSON.stringify({ schema: 1, settings: publicSettingsForExport(imported) });

    const result = parseSettingsImport(text, current);

    expect(result).toMatchObject({
      provider: 'custom', model: 'fixture-model', base_url: 'https://translator.example/v1', wire_format: 'anthropic',
      target_language: '日本語', style_preset: 'story', style_prompt: 'short lines',
      custom_system_prompt: 'Keep names consistent', temperature: 0.8, batch_size: 12, request_timeout: 50,
      rpm_limit: 20, tpm_limit: 9000, max_batch_retries: 5, concurrency: 2,
      resource_pack_enabled: true, skip_target_language_text: false,
      ui_language: 'ja', last_world_dir: '/world/kept'
    });
    expect(result.scan_options).toEqual(imported.scan_options);
    expect(result.scan_options?.region_dirs).not.toBe(imported.scan_options?.region_dirs);
    expect(JSON.stringify(current)).toBe(before);
  });

  it('maps legacy execution settings through an allowlist and drops credentials and unrelated paths', () => {
    const legacy = {
      world_dir: '/world/from-file', api: {
        provider: 'custom_anthropic', model: 'claude-fixture', base_url: 'https://api.example/v1',
        wire_format: 'openai', api_key: 'synthetic-api-key', master_key: 'synthetic-master-key', request_timeout: 240,
        rpm_limit: 30, tpm_limit: 12000, nested: { token: 'synthetic-nested-token' }
      },
      prompt: { target_language: 'English', style_preset: 'formal', style_prompt: 'Concise',
        custom_system_prompt: 'Preserve tags', credential: 'synthetic-prompt-secret' },
      scan: { translate_signs: false, region_dirs: ['region', 'DIM-1/region'], skip_target_language_text: false,
        overrides: { key: 'known translation' }, unknown: { api_key: 'synthetic-scan-secret' } },
      resource_pack: { enabled: true, zip_paths: ['/private/path.zip'] },
      runtime: { concurrency: 3, max_batch_retries: 4, checkpoint_path: '/private/checkpoint' },
      temperature: 1.1, batch_size: 20, secret: 'synthetic-root-secret'
    };
    const current = currentSettings();
    const result = parseSettingsImport(JSON.stringify(legacy), current);

    expect(result).toMatchObject({
      provider: 'custom', wire_format: 'anthropic', model: 'claude-fixture', base_url: 'https://api.example/v1',
      target_language: 'English', style_preset: 'formal', style_prompt: 'Concise', custom_system_prompt: 'Preserve tags',
      request_timeout: 240, rpm_limit: 30, tpm_limit: 12000, concurrency: 3, max_batch_retries: 4,
      temperature: 1.1, batch_size: 20, resource_pack_enabled: true, skip_target_language_text: false,
      ui_language: 'ja', last_world_dir: '/world/kept'
    });
    expect(result.source_overrides).toEqual({ key: 'known translation' });
    expect(result.scan_options).toMatchObject({ translate_signs: false, region_dirs: ['region', 'DIM-1/region'] });
    expect(JSON.stringify(result)).not.toMatch(/synthetic|checkpoint|world\/from-file|zip\.path/i);
  });

  it('imports Comet only as custom with an explicit safe endpoint', () => {
    const result = parseSettingsImport(JSON.stringify({ api: { provider: 'comet', base_url: 'https://proxy.example/v1', model: 'm' } }), currentSettings());
    expect(result).toMatchObject({ provider: 'custom', wire_format: 'openai', base_url: 'https://proxy.example/v1' });
    expect(parseSettingsImport(JSON.stringify({ api: { provider: 'comet', model: 'm' } }), currentSettings())).toMatchObject({ provider: 'comet', base_url: 'https://api.cometapi.com/v1', wire_format: 'openai' });
    expect(() => parseSettingsImport(JSON.stringify({ api: { provider: 'comet', base_url: 'https://user:pass@example.test/v1' } }), currentSettings())).toThrow();
    expect(parseSettingsImport(JSON.stringify({ api: { provider: 'custom_openai', base_url: 'https://proxy.example/v1' } }), currentSettings()))
      .toMatchObject({ provider: 'custom', wire_format: 'openai' });
  });

  it('rejects malformed, unsupported, oversized, and out-of-range settings atomically', () => {
    const current = currentSettings();
    const before = JSON.stringify(current);
    const invalid = [
      '{', '[]', JSON.stringify({ schema: 2, settings: {} }), JSON.stringify({ schema: 1, settings: [] }),
      JSON.stringify({ schema: 1, settings: { provider: 'unknown' } }),
      JSON.stringify({ schema: 1, settings: { temperature: 1e999 } }),
      JSON.stringify({ schema: 1, settings: { temperature: -0.1 } }),
      JSON.stringify({ schema: 1, settings: { batch_size: 2.5 } }),
      JSON.stringify({ schema: 1, settings: { concurrency: 9 } }),
      JSON.stringify({ schema: 1, settings: { resource_pack_enabled: 'true' } }),
      JSON.stringify({ schema: 1, settings: { scan_options: { translate_signs: 1 } } }),
      JSON.stringify({ schema: 1, settings: { scan_options: { region_dirs: new Array(65).fill('region') } } }),
      JSON.stringify({ schema: 1, settings: { scan_options: { skip_patterns: ['x'.repeat(257)] } } }),
      JSON.stringify({ schema: 1, settings: { provider: 'custom', base_url: 'file:///tmp/x' } }),
      JSON.stringify({ schema: 1, settings: { provider: 'custom', base_url: 'https://user:pass@example.test/v1' } }),
      JSON.stringify({ schema: 1, settings: { provider: 'custom', base_url: 'https://example.test/v1?token=x' } }),
      JSON.stringify({ schema: 1, settings: { provider: 'custom', base_url: 'https://example.test/v1#fragment' } }),
      JSON.stringify({ schema: 1, settings: { provider: 'custom', base_url: 'https://example.test/v1', model: 'x'.repeat(257) } }),
      JSON.stringify({ schema: 1, settings: { review_before_apply: 'false' } }),
      JSON.stringify({ schema: 1, settings: { max_cost_usd: 1000.01 } }),
      JSON.stringify({ schema: 1, settings: { glossary: [{ source: 'Mira', target: '', mode: 'translate' }] } }),
      JSON.stringify({ schema: 1, settings: { custom_prices: { 'openai/test': { input: 1, output: 1001 } } } }),
      JSON.stringify({ api: { provider: 'not-a-provider' } })
    ];
    for (const text of invalid) expect(() => parseSettingsImport(text, current)).toThrow();
    expect(() => parseSettingsImport(' '.repeat(1024 * 1024 + 1), current)).toThrow(/1 MiB/);
    expect(JSON.stringify(current)).toBe(before);
  });

  it('strips unknown and secret fields from known and nested objects without mutation', () => {
    const current = currentSettings({ scan_options: { ...defaultScanOptions(), skip_patterns: ['*.bak_translate'] } });
    const input = JSON.parse(JSON.stringify({ schema: 1, settings: {
      ...publicSettingsForExport(current), apiKey: 'synthetic-key', auth: { password: 'synthetic-password' },
      scan_options: { ...current.scan_options, api_key: 'synthetic-scan-key', nested: { master_key: 'synthetic-nested-key' } }
    } }));
    const beforeInput = JSON.stringify(input);
    const beforeCurrent = JSON.stringify(current);

    const result = parseSettingsImport(JSON.stringify(input), current);

    expect(JSON.stringify(result)).not.toMatch(/synthetic|apiKey|api_key|password|master_key|auth/);
    expect(result.scan_options?.skip_patterns).toEqual(['*.bak_translate']);
    expect(JSON.stringify(input)).toBe(beforeInput);
    expect(JSON.stringify(current)).toBe(beforeCurrent);
  });
});

describe('saved translations and write policy import', () => {
  it('roundtrips exact multiline sources and preserves explicit false without credentials', () => {
    const current = currentSettings({ source_overrides: { ' Shop\nWelcome ': ' 상점\n환영 ' }, continue_on_file_error: false, max_file_write_retries: 1 });
    const result = parseSettingsImport(JSON.stringify({ schema: 1, settings: publicSettingsForExport(current) }), currentSettings());
    expect(result.source_overrides).toEqual({ ' Shop\nWelcome ': '상점\n환영' });
    expect(result.continue_on_file_error).toBe(false);
    expect(result.max_file_write_retries).toBe(1);
  });
  it('rejects invalid maps and write attempt counts without mutating current settings', () => {
    const current = currentSettings();
    for (const settings of [{ source_overrides: { Shop: '' } }, { source_overrides: { Shop: 3 } }, { max_file_write_retries: 0 }, { max_file_write_retries: 1.5 }, { continue_on_file_error: 'false' }]) {
      expect(() => parseSettingsImport(JSON.stringify({ schema: 1, settings }), current)).toThrow();
    }
    expect(current.source_overrides).toBeUndefined();
  });
});


describe('public provider import roundtrips', () => {
  it('restores every public provider and rejects Gemini wire format for Custom', () => {
    const endpoints = {
      openai: 'https://api.openai.com/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta',
      anthropic: 'https://api.anthropic.com/v1', openrouter: 'https://openrouter.ai/api/v1', comet: 'https://api.cometapi.com/v1'
    };
    for (const [provider, base_url] of Object.entries(endpoints)) {
      const wire_format = provider === 'gemini' ? 'gemini' : provider === 'anthropic' ? 'anthropic' : 'openai';
      const settings = currentSettings({ provider, base_url, wire_format });
      expect(parseSettingsImport(JSON.stringify({ schema: 1, settings: publicSettingsForExport(settings) }), currentSettings()))
        .toMatchObject({ provider, base_url, wire_format });
    }
    expect(() => parseSettingsImport(JSON.stringify({ schema: 1, settings: { provider: 'custom', base_url: 'https://example.test/v1', wire_format: 'gemini' } }), currentSettings())).toThrow();
  });
});
