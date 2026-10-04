import { describe, expect, it } from 'vitest';

import type { ModelInfo } from '../../src/lib/api';
import { connectionErrorKey, defaultModel, filterModels, formatContext, isSuitable, modelPrices, perMillion, recommendedModels } from '../../src/lib/models';
import { en } from '../../src/lib/i18n/en';
import { ko } from '../../src/lib/i18n/ko';

const model = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, ...extra });
const priced = (id: string, input: string, output: string, extra: Partial<ModelInfo> = {}) => model(id, { pricing_prompt: input, pricing_completion: output, ...extra });

describe('model suitability', () => {
  it('treats a model as suitable unless the catalog says otherwise', () => {
    expect(isSuitable(model('a'))).toBe(true);
    expect(isSuitable(model('a', { suitable: true }))).toBe(true);
    expect(isSuitable(model('a', { suitable: false }))).toBe(false);
  });
});

describe('prices', () => {
  it('turns a per-token price into dollars per million tokens', () => {
    expect(perMillion('0.0000001')).toBeCloseTo(0.1);
    expect(perMillion('0')).toBe(0);
    expect(perMillion('')).toBeNull();
    expect(perMillion(undefined)).toBeNull();
    expect(perMillion('free')).toBeNull();
    expect(perMillion('-1')).toBeNull();
  });

  it('reads both prices of a model', () => {
    expect(modelPrices(priced('a', '0.000001', '0.000005'))).toEqual({ input: 1, output: 5 });
    expect(modelPrices(model('a'))).toEqual({ input: null, output: null });
  });
});

describe('recommended models', () => {
  const catalog = [
    priced('vendor/big-pro', '0.00001', '0.00005'),
    priced('vendor/chat-mini', '0.00000025', '0.000002'),
    priced('google/gemini-flash-lite', '0.0000001', '0.0000004'),
    priced('anthropic/claude-haiku', '0.000001', '0.000005'),
    priced('vendor/tiny-flash:free', '0', '0'),
    priced('vendor/image-flash', '0.0000001', '0.0000001', { suitable: false }),
    model('vendor/unpriced-small'),
    priced('vendor/other', '0.000002', '0.000004')
  ];

  it('lists the cheapest suitable models of a fast family first', () => {
    expect(recommendedModels(catalog).map((item) => item.id)).toEqual([
      'google/gemini-flash-lite', 'vendor/chat-mini', 'anthropic/claude-haiku', 'vendor/unpriced-small'
    ]);
  });

  it('leaves out free-tier ids and models marked unsuitable', () => {
    const ids = recommendedModels(catalog).map((item) => item.id);
    expect(ids).not.toContain('vendor/tiny-flash:free');
    expect(ids).not.toContain('vendor/image-flash');
  });

  it('shows at most five, and the default is the first of them', () => {
    const many = Array.from({ length: 9 }, (_, index) => priced(`v/mini-${index}`, `0.00000${index + 1}`, '0.000001'));
    expect(recommendedModels(many)).toHaveLength(5);
    expect(recommendedModels(many)[0].id).toBe('v/mini-0');
    expect(defaultModel(catalog)?.id).toBe('google/gemini-flash-lite');
  });

  it('falls back to the first suitable entry when no fast family matches', () => {
    const plain = [model('x/image', { suitable: false }), model('x/alpha'), model('x/beta')];
    expect(recommendedModels(plain).map((item) => item.id)).toEqual(['x/alpha']);
    expect(defaultModel([])).toBeUndefined();
  });

  it('keeps list order among models with the same price', () => {
    const tied = [priced('a/mini', '0.000001', '0.000001'), priced('b/mini', '0.000001', '0.000001')];
    expect(recommendedModels(tied).map((item) => item.id)).toEqual(['a/mini', 'b/mini']);
  });
});

describe('model search', () => {
  const catalog = [model('openai/gpt-5-mini', { display_name: 'GPT-5 Mini' }), model('google/gemini-flash', { display_name: 'Gemini Flash' })];

  it('needs every word in the id or the display name', () => {
    expect(filterModels(catalog, 'gpt mini').map((item) => item.id)).toEqual(['openai/gpt-5-mini']);
    expect(filterModels(catalog, 'GEMINI').map((item) => item.id)).toEqual(['google/gemini-flash']);
    expect(filterModels(catalog, 'google gpt')).toEqual([]);
  });

  it('returns everything for an empty query', () => {
    expect(filterModels(catalog, '   ')).toHaveLength(2);
  });
});

describe('context length', () => {
  it('writes a short size', () => {
    expect(formatContext(128000)).toBe('128K');
    expect(formatContext(1048576)).toBe('1M');
    expect(formatContext(0)).toBe('');
    expect(formatContext(undefined)).toBe('');
  });
});

describe('connection errors', () => {
  it('maps every code the core reports to a catalog message', () => {
    for (const code of ['AUTH_FAILED', 'KEY_MISSING', 'NO_CREDIT', 'RATE_LIMITED', 'PROVIDER_ERROR', 'NETWORK_ERROR', 'TIMEOUT', 'REQUEST_REJECTED']) {
      expect(connectionErrorKey(code)).toBe(`connect.error.${code}`);
      expect(ko[connectionErrorKey(code)]).toBeTruthy();
      expect(en[connectionErrorKey(code)]).toBeTruthy();
    }
  });

  it('shows a rejected model like a rejected request, and an unknown code as unknown', () => {
    expect(connectionErrorKey('MODEL_NOT_FOUND')).toBe('connect.error.REQUEST_REJECTED');
    expect(connectionErrorKey('MODELS_FAILED')).toBe('connect.error.unknown');
    expect(connectionErrorKey('')).toBe('connect.error.unknown');
  });
});
